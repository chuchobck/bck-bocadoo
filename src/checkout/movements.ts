import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems, forbidden } from '../common/errors';
import { IsoDatePipe } from '../common/pipes';
import { DbService } from '../db/db.service';
import { RequestContextStore } from '../tenancy/request-context';
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
      'Centavos cobrados. Solo VENTA: total del ticket. PEDIDO y CANJE_DIRECTO: null (el valor de una preorden va en `valorPedidoCentavos`)',
  })
  montoCentavos!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 125,
    description:
      'Centavos. Solo PEDIDO: `totalCentavos` de la preorden. Es el valor del pedido, NO dinero cobrado (lo que se cobra aparte sale de `porCobrarCentavos` al canjear y ya es una VENTA). VENTA y CANJE_DIRECTO: null',
  })
  valorPedidoCentavos!: number | null;
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

class ResumenVentasResponse {
  @ApiProperty({ example: 2, description: 'Ventas no deshechas (con pago confirmado o pendiente)' }) cantidad!: number;
  @ApiProperty({
    example: 1050,
    description: 'Dinero de las ventas con pago CONFIRMADO, sin las deshechas. Un pago PENDIENTE o RECHAZADO no suma',
  })
  ventasConfirmadasCentavos!: number;
}

class ResumenPedidosResponse {
  @ApiProperty({ example: 1, description: 'Pedidos canjeados en el día' }) cantidad!: number;
  @ApiProperty({
    example: 125,
    description:
      'Suma de `totalCentavos` de los pedidos canjeados: es el valor de las preórdenes, NO dinero cobrado. Lo que la caja cobra aparte de un pedido ya es una venta',
  })
  valorPedidosCentavos!: number;
}

class ResumenCanjesDirectosResponse {
  @ApiProperty({
    example: 1,
    description: 'Almuerzos descontados de un plan por QR o búsqueda manual, sin los revertidos. No mueven dinero',
  })
  cantidad!: number;
}

class ResumenMovimientosResponse {
  @ApiProperty({ type: ResumenVentasResponse }) ventas!: ResumenVentasResponse;
  @ApiProperty({ type: ResumenPedidosResponse }) pedidos!: ResumenPedidosResponse;
  @ApiProperty({ type: ResumenCanjesDirectosResponse }) canjesDirectos!: ResumenCanjesDirectosResponse;
}

const EJEMPLO_ITEMS = [
  {
    id: '7d0e1c64-52a0-4b0b-8a43-0f6f1b9e2c11',
    tipo: 'CANJE_DIRECTO',
    hora: '2026-11-13T17:05:12.000Z',
    montoCentavos: null,
    valorPedidoCentavos: null,
    medioPago: null,
    pagoEstado: null,
    platoNombre: null,
    comensalNombre: 'Ana Pérez',
    revertido: false,
  },
  {
    id: 'b1070383-90ef-4353-b00d-9019fcf067c2',
    tipo: 'PEDIDO',
    hora: '2026-11-13T16:48:30.000Z',
    montoCentavos: null,
    valorPedidoCentavos: 125,
    medioPago: null,
    pagoEstado: null,
    platoNombre: 'Sopa de quinua + Seco de pollo',
    comensalNombre: 'Luis Mora',
    revertido: false,
  },
  {
    id: '0e98d6e3-f04b-4875-a60d-ac56fd48c717',
    tipo: 'VENTA',
    hora: '2026-11-13T16:20:05.000Z',
    montoCentavos: 700,
    valorPedidoCentavos: null,
    medioPago: 'EFECTIVO',
    pagoEstado: 'CONFIRMADO',
    platoNombre: null,
    comensalNombre: null,
    revertido: false,
  },
];

class MovimientosResponse {
  @ApiProperty({ example: '2026-11-13', description: 'Día local que se consultó' }) fecha!: string;
  @ApiProperty({ example: 'America/Guayaquil' }) zonaHoraria!: string;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ type: ResumenMovimientosResponse, description: 'Todo el día, sin importar la página' })
  resumen!: ResumenMovimientosResponse;
  @ApiProperty({ type: [MovimientoResponse], example: EJEMPLO_ITEMS, description: 'De la hora más reciente a la más antigua' })
  items!: MovimientoResponse[];
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'eyJ0IjoiMjAyNi0xMS0xM1QxNjoyMDowNS4xMjM0NTZaIiwicCI6IjNmNmM5YTUyLTFiN2UtNGQwOC05YzM0LTVhOGUwZjIxYjdkNiJ9',
    description: 'null si no hay más páginas',
  })
  nextCursor!: string | null;
}

interface Row {
  tipo: Tipo;
  public_id: string;
  hora: Date;
  monto: string | null;
  valor_pedido: string | null;
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
    SELECT zona_horaria, moneda_codigo, (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date AS hoy,
           COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date) AS dia
      FROM restaurante WHERE restaurante_id = app_tenant_id()
  ), mov AS (
    SELECT 'VENTA'::text AS tipo, v.public_id, v.creado_en AS hora, v.total_centavos AS monto, NULL::bigint AS valor_pedido, m.codigo AS medio_pago, p.estado::text AS pago_estado,
           NULL::text AS plato_nombre, NULL::text AS comensal,
           EXISTS (SELECT 1 FROM venta_pos_cabecera x WHERE x.restaurante_id = v.restaurante_id AND x.revierte_a_venta_pos_id = v.venta_pos_id) AS revertido
      FROM venta_pos_cabecera v
      LEFT JOIN transaccion_pago p ON p.restaurante_id = v.restaurante_id AND p.venta_pos_id = v.venta_pos_id AND p.revierte_a_pago_id IS NULL
      LEFT JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
     WHERE v.restaurante_id = app_tenant_id() AND v.revierte_a_venta_pos_id IS NULL AND v.fecha_local = (SELECT dia FROM r)
    UNION ALL
    SELECT 'PEDIDO', o.public_id, o.canjeada_en, NULL, o.total_centavos, NULL, NULL,
           (SELECT string_agg(d.nombre_plato, ' + ' ORDER BY d.orden_detalle_id) FROM orden_detalle d WHERE d.orden_id = o.orden_id AND d.seccion IS NOT NULL),
           u.nombre, false
      FROM orden_cabecera o JOIN usuario u ON u.usuario_id = o.usuario_id
     WHERE o.restaurante_id = app_tenant_id() AND o.canjeada_en IS NOT NULL
       AND (o.canjeada_en AT TIME ZONE (SELECT zona_horaria FROM r))::date = (SELECT dia FROM r)
    UNION ALL
    SELECT 'CANJE_DIRECTO', k.public_id, k.creado_en, NULL, NULL, NULL, NULL, NULL, c.nombre,
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
        const ctx = (
          await q.query<{ dia: string; hoy: string; zona: string; moneda: string }>(
            `${MOVIMIENTOS} SELECT dia::text AS dia, hoy::text AS hoy, zona_horaria AS zona, moneda_codigo AS moneda FROM r`,
            [fecha ?? null],
          )
        ).rows[0]!;
        // Igual que el cierre de caja: el cajero solo ve el día de hoy (hora local del restaurante); el dueño, cualquiera.
        if (RequestContextStore.get()?.role === 'CAJERO' && ctx.dia !== ctx.hoy)
          throw forbidden('CAJERO_SOLO_HOY', 'El cajero solo puede consultar los movimientos de hoy.');
        const page = await q.query<Row>(
          `${MOVIMIENTOS}
           SELECT tipo, public_id, hora, monto, valor_pedido, medio_pago, pago_estado, plato_nombre, comensal, revertido, ${CURSOR_TS('hora')} AS cursor_t
             FROM mov
            WHERE ($2::timestamptz IS NULL OR (hora, public_id) < ($2::timestamptz, $3::uuid))
            ORDER BY hora DESC, public_id DESC
            LIMIT $4`,
          [fecha ?? null, cur?.t ?? null, cur?.p ?? null, limit + 1],
        );
        const t = (
          await q.query<{ ventas: string; confirmadas: string; pedidos: string; valor: string; canjes: string }>(
            `${MOVIMIENTOS}
           SELECT count(*) FILTER (WHERE tipo = 'VENTA' AND NOT revertido) AS ventas,
                  COALESCE(sum(monto) FILTER (WHERE tipo = 'VENTA' AND NOT revertido AND pago_estado = 'CONFIRMADO'), 0) AS confirmadas,
                  count(*) FILTER (WHERE tipo = 'PEDIDO') AS pedidos,
                  COALESCE(sum(valor_pedido) FILTER (WHERE tipo = 'PEDIDO'), 0) AS valor,
                  count(*) FILTER (WHERE tipo = 'CANJE_DIRECTO' AND NOT revertido) AS canjes
             FROM mov`,
            [fecha ?? null],
          )
        ).rows[0]!;
        const resumen: ResumenMovimientosResponse = {
          ventas: { cantidad: Number(t.ventas), ventasConfirmadasCentavos: Number(t.confirmadas) },
          pedidos: { cantidad: Number(t.pedidos), valorPedidosCentavos: Number(t.valor) },
          canjesDirectos: { cantidad: Number(t.canjes) },
        };
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
            valorPedidoCentavos: m.valor_pedido === null ? null : Number(m.valor_pedido),
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
      'El dueño puede consultar cualquier fecha; el cajero solo hoy (otra fecha → 403 `CAJERO_SOLO_HOY`). `resumen` cuenta todo el día, no solo la página, y separa lo cobrado en ventas (`ventasConfirmadasCentavos`) del valor de las preórdenes (`valorPedidosCentavos`). Reemplaza armar "Cobros de hoy" con `GET /v1/caja/ventas` + `GET /v1/caja/pedidos` + una lista en memoria.',
  })
  @ApiOkResponse({ type: MovimientosResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'], 403: ['CAJERO_SOLO_HOY'] })
  list(@Query() q: MovimientosQuery) {
    if (q.fecha) new IsoDatePipe().transform(q.fecha);
    return this.svc.list(q.fecha, q.limit ?? 20, q.cursor);
  }
}
