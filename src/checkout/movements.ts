import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems } from '../common/errors';
import { IsoDatePipe } from '../common/pipes';
import { DbService } from '../db/db.service';
import { CURSOR_TS, PageQuery, decodeCursor, encodeCursor } from '../diner/common';

const TIPOS = ['VENTA', 'PEDIDO', 'CANJE_DIRECTO'] as const;
type Tipo = (typeof TIPOS)[number];

class MovimientosQuery extends PageQuery {
  @ApiPropertyOptional({
    example: '2026-11-13',
    description: 'Día local del restaurante (AAAA-MM-DD). Por defecto, hoy en la zona horaria del restaurante.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Fecha inválida: usa AAAA-MM-DD.' })
  fecha?: string;
}

class MovimientoResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id de la venta, del pedido o del consumo, según `tipo`' }) id!: string;
  @ApiProperty({
    enum: TIPOS,
    description:
      'VENTA: venta suelta. PEDIDO: preorden canjeada en caja. CANJE_DIRECTO: almuerzo descontado de un plan por QR o búsqueda manual (`POST /v1/caja/validar`), sin preorden',
  })
  tipo!: Tipo;
  @ApiProperty({ description: 'VENTA: cuándo se registró. PEDIDO: cuándo se canjeó. CANJE_DIRECTO: cuándo se descontó' }) hora!: Date;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 750,
    description:
      'Centavos. VENTA: total del ticket. PEDIDO: `totalCentavos` del pedido (valor de la preorden: lo que se cobra aparte sale de `porCobrarCentavos` al canjear). CANJE_DIRECTO: null (ya está prepagado en el plan)',
  })
  montoCentavos!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'EFECTIVO', description: 'Solo VENTA; null en los demás tipos' }) medioPago!:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CONFIRMADO',
    description: 'Solo VENTA: PENDIENTE, CONFIRMADO o RECHAZADO; null en los demás tipos',
  })
  pagoEstado!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Sopa de quinua + Seco de pollo',
    description: 'PEDIDO: platos del almuerzo preordenado unidos con " + ". VENTA y CANJE_DIRECTO: null',
  })
  platoNombre!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Ana Pérez',
    description:
      'Mismo nombre que ya muestra la caja: PEDIDO = nombre de la cuenta (`comensal.nombre` de `GET /v1/caja/pedidos`); CANJE_DIRECTO = nombre del cliente (`cliente.nombre` de `POST /v1/caja/validar`). VENTA: null',
  })
  comensalNombre!: string | null;
  @ApiProperty({ description: 'La venta se deshizo o el consumo se revirtió. No cuenta en el resumen. Los pedidos nunca se revierten' })
  revertido!: boolean;
}

class ResumenTipoResponse {
  @ApiProperty({ example: 12, description: 'Movimientos no revertidos' }) cantidad!: number;
  @ApiProperty({
    example: 8450,
    description:
      'Suma de `montoCentavos` de los no revertidos. En VENTA solo las de pago CONFIRMADO. En CANJE_DIRECTO siempre 0. El monto de PEDIDO no es dinero cobrado: puede repetirse en una VENTA si la caja lo cobró aparte',
  })
  montoCentavos!: number;
}

class ResumenMovimientosResponse {
  @ApiProperty({ type: ResumenTipoResponse }) VENTA!: ResumenTipoResponse;
  @ApiProperty({ type: ResumenTipoResponse }) PEDIDO!: ResumenTipoResponse;
  @ApiProperty({ type: ResumenTipoResponse }) CANJE_DIRECTO!: ResumenTipoResponse;
}

class MovimientosResponse {
  @ApiProperty({ example: '2026-11-13', description: 'Día local que se consultó' }) fecha!: string;
  @ApiProperty({ example: 'America/Guayaquil' }) zonaHoraria!: string;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ type: ResumenMovimientosResponse, description: 'Todo el día, sin importar la página' })
  resumen!: ResumenMovimientosResponse;
  @ApiProperty({ type: [MovimientoResponse], description: 'De la hora más reciente a la más antigua' }) items!: MovimientoResponse[];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null si no hay más páginas' }) nextCursor!: string | null;
}

interface Row {
  tipo: Tipo;
  public_id: string;
  hora: Date;
  monto: string | null;
  medio_pago: string | null;
  pago_estado: string | null;
  plato_nombre: string | null;
  comensal: string | null;
  revertido: boolean;
  cursor_t: string;
}

/**
 * Movimientos del día de la caja, de tres fuentes que ya existen (sin tablas nuevas):
 *  - VENTA: `venta_pos_cabecera` (día = `fecha_local`, el mismo del cierre de caja) con su pago.
 *  - PEDIDO: `orden_cabecera` con `canjeada_en` (día = fecha local de ese instante).
 *  - CANJE_DIRECTO: `consumo_almuerzo` canal QR o MANUAL, sin orden ni mesa (lo que registra `POST /v1/caja/validar`).
 * Los reversos (ventas y consumos con `revierte_a_*`) no son filas: marcan `revertido` en la original.
 */
const MOVIMIENTOS = `
  WITH r AS (
    SELECT zona_horaria, moneda_codigo, COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date) AS dia
      FROM restaurante WHERE restaurante_id = app_tenant_id()
  ), mov AS (
    SELECT 'VENTA'::text AS tipo, v.public_id, v.creado_en AS hora, v.total_centavos AS monto, m.codigo AS medio_pago, p.estado::text AS pago_estado,
           NULL::text AS plato_nombre, NULL::text AS comensal,
           EXISTS (SELECT 1 FROM venta_pos_cabecera x WHERE x.restaurante_id = v.restaurante_id AND x.revierte_a_venta_pos_id = v.venta_pos_id) AS revertido
      FROM venta_pos_cabecera v
      LEFT JOIN transaccion_pago p ON p.restaurante_id = v.restaurante_id AND p.venta_pos_id = v.venta_pos_id AND p.revierte_a_pago_id IS NULL
      LEFT JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
     WHERE v.restaurante_id = app_tenant_id() AND v.revierte_a_venta_pos_id IS NULL AND v.fecha_local = (SELECT dia FROM r)
    UNION ALL
    SELECT 'PEDIDO', o.public_id, o.canjeada_en, o.total_centavos, NULL, NULL,
           (SELECT string_agg(d.nombre_plato, ' + ' ORDER BY d.orden_detalle_id) FROM orden_detalle d WHERE d.orden_id = o.orden_id AND d.seccion IS NOT NULL),
           u.nombre, false
      FROM orden_cabecera o JOIN usuario u ON u.usuario_id = o.usuario_id
     WHERE o.restaurante_id = app_tenant_id() AND o.canjeada_en IS NOT NULL
       AND (o.canjeada_en AT TIME ZONE (SELECT zona_horaria FROM r))::date = (SELECT dia FROM r)
    UNION ALL
    SELECT 'CANJE_DIRECTO', k.public_id, k.creado_en, NULL, NULL, NULL, NULL, c.nombre,
           EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.restaurante_id = k.restaurante_id AND x.revierte_a_consumo_id = k.consumo_id)
      FROM consumo_almuerzo k
      JOIN cliente_restaurante c ON c.restaurante_id = k.restaurante_id AND c.cliente_id = k.cliente_id
     WHERE k.restaurante_id = app_tenant_id() AND k.cantidad = 1 AND k.canal IN ('QR', 'MANUAL')
       AND k.orden_id IS NULL AND k.mesa_compartida_id IS NULL AND k.fecha_local = (SELECT dia FROM r)
  )`;

@Injectable()
export class MovementsService {
  constructor(private readonly db: DbService) {}

  list(fecha: string | undefined, limit: number, cursor?: string): Promise<MovimientosResponse> {
    const cur = cursor ? decodeCursor(cursor) : null;
    return this.db.forRequest(
      async (q) => {
        const page = await q.query<Row>(
          `${MOVIMIENTOS}
           SELECT tipo, public_id, hora, monto, medio_pago, pago_estado, plato_nombre, comensal, revertido, ${CURSOR_TS('hora')} AS cursor_t
             FROM mov
            WHERE ($2::timestamptz IS NULL OR (hora, public_id) < ($2::timestamptz, $3::uuid))
            ORDER BY hora DESC, public_id DESC
            LIMIT $4`,
          [fecha ?? null, cur?.t ?? null, cur?.p ?? null, limit + 1],
        );
        const totals = await q.query<{ tipo: Tipo; cantidad: string; monto: string }>(
          `${MOVIMIENTOS}
           SELECT tipo, count(*) FILTER (WHERE NOT revertido) AS cantidad,
                  COALESCE(sum(monto) FILTER (WHERE NOT revertido AND (tipo <> 'VENTA' OR pago_estado = 'CONFIRMADO')), 0) AS monto
             FROM mov GROUP BY tipo`,
          [fecha ?? null],
        );
        const ctx = (
          await q.query<{ dia: string; zona: string; moneda: string }>(
            `${MOVIMIENTOS} SELECT dia::text AS dia, zona_horaria AS zona, moneda_codigo AS moneda FROM r`,
            [fecha ?? null],
          )
        ).rows[0]!;
        const resumen = Object.fromEntries(
          TIPOS.map((t) => [t, { cantidad: 0, montoCentavos: 0 }]),
        ) as unknown as ResumenMovimientosResponse;
        for (const t of totals.rows) resumen[t.tipo] = { cantidad: Number(t.cantidad), montoCentavos: Number(t.monto) };
        const rows = page.rows.slice(0, limit);
        const last = rows.at(-1);
        return {
          fecha: ctx.dia,
          zonaHoraria: ctx.zona,
          monedaCodigo: ctx.moneda,
          resumen,
          items: rows.map((m) => ({
            id: m.public_id,
            tipo: m.tipo,
            hora: m.hora,
            montoCentavos: m.monto === null ? null : Number(m.monto),
            medioPago: m.medio_pago,
            pagoEstado: m.pago_estado,
            platoNombre: m.plato_nombre,
            comensalNombre: m.comensal,
            revertido: m.revertido,
          })),
          nextCursor: page.rows.length > limit && last ? encodeCursor(last.cursor_t, last.public_id) : null,
        };
      },
      { readOnly: true },
    );
  }
}

@ApiTags('caja')
@Controller('v1/caja/movimientos')
export class MovementsController {
  constructor(private readonly svc: MovementsService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({
    summary: 'Movimientos del día de la caja',
    description:
      'Lista unificada, de solo lectura, de ventas sueltas, pedidos canjeados y canjes directos (`POST /v1/caja/validar`) del día local ' +
      'del restaurante (`fecha`, por defecto hoy), de la hora más reciente a la más antigua, con paginación por cursor (máximo 50). ' +
      '`resumen` cuenta todo el día, no solo la página. Reemplaza armar "Cobros de hoy" con `GET /v1/caja/ventas` + `GET /v1/caja/pedidos` + una lista en memoria.',
  })
  @ApiOkResponse({ type: MovimientosResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'] })
  list(@Query() q: MovimientosQuery) {
    if (q.fecha) new IsoDatePipe().transform(q.fecha);
    return this.svc.list(q.fecha, q.limit ?? 20, q.cursor);
  }
}
