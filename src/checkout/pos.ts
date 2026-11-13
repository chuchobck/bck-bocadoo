import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';
import { RequestContextStore } from '../tenancy/request-context';
import { PERSONAL_ACTUAL } from './checkout';
import { VentaResponse } from './responses';

const ID = /^[1-9][0-9]{0,17}$/;
const METODOS = ['EFECTIVO', 'TRANSFERENCIA', 'DEUNA'] as const;
const HOY = `(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())`;

class ItemVentaDto {
  @ApiProperty({
    enum: ['ALMUERZO', 'PLATO', 'LIBRE'],
    description: 'ALMUERZO: almuerzo suelto al precio del local. PLATO: del catálogo. LIBRE: cobro suelto con nombre y precio.',
  })
  @IsIn(['ALMUERZO', 'PLATO', 'LIBRE'])
  tipo!: 'ALMUERZO' | 'PLATO' | 'LIBRE';
  @ApiPropertyOptional({ description: 'Obligatorio en PLATO' })
  @IsOptional()
  @IsString()
  @Matches(ID, { message: 'platoId inválido' })
  platoId?: string;
  @ApiPropertyOptional({ description: 'Obligatorio en LIBRE' }) @IsOptional() @Text() @IsString() @Length(1, 80) nombre?: string;
  @ApiPropertyOptional({ description: 'Centavos; obligatorio en LIBRE' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  precioUnitarioCentavos?: number;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(100) cantidad!: number;
}

export class VentaDto {
  @ApiProperty({ type: [ItemVentaDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ItemVentaDto)
  items!: ItemVentaDto[];
  @ApiProperty({ enum: METODOS }) @IsIn(METODOS) metodoPago!: (typeof METODOS)[number];
  @ApiPropertyOptional({ description: 'Suma el recargo para llevar del local por cada almuerzo' })
  @IsOptional()
  @IsBoolean()
  paraLlevar?: boolean;
  @ApiPropertyOptional({ example: 'Mesa 3' }) @IsOptional() @Text() @IsString() @Length(1, 20) mesaTexto?: string;
  @ApiPropertyOptional({ description: 'Transferencia o Deuna ya verificada; si no, queda pendiente' })
  @IsOptional()
  @IsBoolean()
  pagoConfirmado?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) @MaxLength(500) comprobanteUrl?: string;
  @ApiPropertyOptional() @IsOptional() @Text() @IsString() @Length(1, 100) referenciaExterna?: string;
}

interface Line {
  platoId: string | null;
  nombre: string;
  esAlmuerzo: boolean;
  cantidad: number;
  precio: number;
}

@Injectable()
export class PosService {
  constructor(private readonly db: DbService) {}

  /** Venta suelta (sin plan): cabecera + renglones + pago en una transacción. Los precios salen del servidor, no del cliente. */
  async sell(dto: VentaDto, key: string) {
    const replay = await this.db.forRequest((q) => this.byKey(q, key), { readOnly: true });
    if (replay) return replay;
    try {
      return await this.db.forRequest(async (q) => {
        const rest = (
          await q.query<{ precio: string; recargo: string }>(
            'SELECT precio_suelto_centavos AS precio, recargo_para_llevar_centavos AS recargo FROM restaurante WHERE restaurante_id = app_tenant_id()',
          )
        ).rows[0]!;
        const lines: Line[] = [];
        let almuerzos = 0;
        for (const it of dto.items) {
          if (it.tipo === 'ALMUERZO') {
            if (Number(rest.precio) <= 0) throw new ConflictException('El restaurante no tiene precio de almuerzo suelto.');
            lines.push({ platoId: null, nombre: 'Almuerzo', esAlmuerzo: true, cantidad: it.cantidad, precio: Number(rest.precio) });
            almuerzos += it.cantidad;
          } else if (it.tipo === 'PLATO') {
            if (!it.platoId) throw new BadRequestException('Falta platoId en un item de tipo PLATO.');
            const p = (
              await q.query<{ nombre: string; precio_centavos: string | null }>(
                'SELECT nombre, precio_centavos FROM plato WHERE restaurante_id = app_tenant_id() AND plato_id = $1 AND activo',
                [it.platoId],
              )
            ).rows[0];
            if (!p) throw new BadRequestException('Algún plato no existe o está inactivo.');
            if (p.precio_centavos === null) throw new BadRequestException(`"${p.nombre}" no tiene precio de venta suelta.`);
            lines.push({
              platoId: it.platoId,
              nombre: p.nombre,
              esAlmuerzo: false,
              cantidad: it.cantidad,
              precio: Number(p.precio_centavos),
            });
          } else {
            if (!it.nombre || it.precioUnitarioCentavos === undefined)
              throw new BadRequestException('Un item LIBRE necesita nombre y precioUnitarioCentavos.');
            lines.push({ platoId: null, nombre: it.nombre, esAlmuerzo: false, cantidad: it.cantidad, precio: it.precioUnitarioCentavos });
          }
        }
        if (dto.paraLlevar && almuerzos > 0 && Number(rest.recargo) > 0) {
          lines.push({
            platoId: null,
            nombre: 'Recargo para llevar',
            esAlmuerzo: false,
            cantidad: almuerzos,
            precio: Number(rest.recargo),
          });
        }
        const total = lines.reduce((s, l) => s + l.cantidad * l.precio, 0);
        if (total <= 0) throw new BadRequestException('El total de la venta debe ser mayor que cero.');

        const m = (
          await q.query<{ metodo_pago_id: string; es_efectivo: boolean }>(
            `SELECT metodo_pago_id, es_efectivo FROM metodo_pago WHERE codigo = $1 AND activo
              AND (pais_codigo IS NULL OR pais_codigo = (SELECT pais_codigo FROM restaurante WHERE restaurante_id = app_tenant_id()))`,
            [dto.metodoPago],
          )
        ).rows[0];
        if (!m) throw new BadRequestException('Método de pago no disponible.');

        const ventaId = await this.insertHeader(q, {
          total,
          key,
          paraLlevar: dto.paraLlevar ?? false,
          mesaTexto: dto.mesaTexto ?? null,
          revierteA: null,
        });
        for (const l of lines) await this.insertLine(q, ventaId, l, 1);
        await q.query(
          `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, venta_pos_id, cobrado_por_personal_id,
               fecha_local, comprobante_url, referencia_externa, clave_idempotencia)
           SELECT app_tenant_id(), $1, $2, r.moneda_codigo, $3, $4, ${PERSONAL_ACTUAL}, ${HOY}, $5, $6, $7 FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
          [
            m.metodo_pago_id,
            total,
            m.es_efectivo || dto.pagoConfirmado ? 'CONFIRMADO' : 'PENDIENTE',
            ventaId,
            dto.comprobanteUrl ?? null,
            dto.referenciaExterna ?? null,
            key,
          ],
        );
        return this.render(q, ventaId);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_pago_referencia_externa') {
        throw new ConflictException('Esa referencia de pago ya se registró: no se puede usar el mismo depósito dos veces.');
      }
      // Misma clave en dos peticiones simultáneas: gana una y la otra devuelve esa misma venta.
      if (e.code === '23505' && e.constraint?.includes('clave_idempotencia')) {
        const again = await this.db.forRequest((q) => this.byKey(q, key), { readOnly: true });
        if (again) return again;
        throw new ConflictException('Esa Idempotency-Key ya se usó en otra operación.');
      }
      throw err;
    }
  }

  /** Deshace una venta suelta con una venta y un pago inversos (nunca borra). El cajero, solo ventas del día. */
  async undo(ventaPublicId: string, key: string) {
    try {
      return await this.db.forRequest(async (q) => {
        const v = (
          await q.query<{
            venta_pos_id: string;
            total_centavos: string;
            para_llevar: boolean;
            mesa_texto: string | null;
            es_hoy: boolean;
            es_reverso: boolean;
            reverso: string | null;
          }>(
            `SELECT v.venta_pos_id, v.total_centavos, v.para_llevar, v.mesa_texto, v.fecha_local = ${HOY} AS es_hoy, v.revierte_a_venta_pos_id IS NOT NULL AS es_reverso,
                  (SELECT x.venta_pos_id FROM venta_pos_cabecera x WHERE x.revierte_a_venta_pos_id = v.venta_pos_id) AS reverso
             FROM venta_pos_cabecera v WHERE v.restaurante_id = app_tenant_id() AND v.public_id = $1`,
            [ventaPublicId],
          )
        ).rows[0];
        if (!v || v.es_reverso) throw new NotFoundException('Venta no encontrada.');
        if (v.reverso) return this.render(q, v.venta_pos_id); // ya deshecha
        if (RequestContextStore.get()?.role === 'CAJERO' && !v.es_hoy)
          throw new ForbiddenException('El cajero solo puede deshacer ventas del mismo día.');

        const reversoId = await this.insertHeader(q, {
          total: -Number(v.total_centavos),
          key,
          paraLlevar: v.para_llevar,
          mesaTexto: v.mesa_texto,
          revierteA: v.venta_pos_id,
        });
        const lines = await q.query<{
          plato_id: string | null;
          nombre_item: string;
          es_almuerzo: boolean;
          cantidad: number;
          precio_unitario_centavos: string;
        }>(
          'SELECT plato_id, nombre_item, es_almuerzo, cantidad, precio_unitario_centavos FROM venta_pos_detalle WHERE restaurante_id = app_tenant_id() AND venta_pos_id = $1',
          [v.venta_pos_id],
        );
        for (const l of lines.rows) {
          await this.insertLine(
            q,
            reversoId,
            {
              platoId: l.plato_id,
              nombre: l.nombre_item,
              esAlmuerzo: l.es_almuerzo,
              cantidad: l.cantidad,
              precio: Number(l.precio_unitario_centavos),
            },
            -1,
          );
        }
        const p = (
          await q.query<{ pago_id: string; estado: string; monto_centavos: string; metodo_pago_id: string }>(
            `SELECT pago_id, estado, monto_centavos, metodo_pago_id FROM transaccion_pago
            WHERE restaurante_id = app_tenant_id() AND venta_pos_id = $1 AND revierte_a_pago_id IS NULL FOR UPDATE`,
            [v.venta_pos_id],
          )
        ).rows[0];
        if (p?.estado === 'CONFIRMADO') {
          await q.query(
            `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, venta_pos_id, cobrado_por_personal_id,
                 fecha_local, clave_idempotencia, revierte_a_pago_id)
             SELECT app_tenant_id(), $1, -$2::bigint, r.moneda_codigo, 'CONFIRMADO', $3, ${PERSONAL_ACTUAL}, ${HOY}, $4, $5 FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
            [p.metodo_pago_id, p.monto_centavos, reversoId, key, p.pago_id],
          );
        } else if (p?.estado === 'PENDIENTE') {
          await q.query(`UPDATE transaccion_pago SET estado = 'RECHAZADO' WHERE pago_id = $1`, [p.pago_id]);
        }
        return this.render(q, v.venta_pos_id);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_venta_pos_un_solo_reverso') {
        return this.db.forRequest(
          async (q) => {
            const v = await q.query<{ venta_pos_id: string }>(
              'SELECT venta_pos_id FROM venta_pos_cabecera WHERE restaurante_id = app_tenant_id() AND public_id = $1',
              [ventaPublicId],
            );
            return this.render(q, v.rows[0]!.venta_pos_id);
          },
          { readOnly: true },
        );
      }
      if (e.code === '23505' && e.constraint?.includes('clave_idempotencia'))
        throw new ConflictException('Esa Idempotency-Key ya se usó en otra operación.');
      throw err;
    }
  }

  today() {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<{ venta_pos_id: string }>(
          `SELECT venta_pos_id FROM venta_pos_cabecera WHERE restaurante_id = app_tenant_id() AND fecha_local = ${HOY} AND revierte_a_venta_pos_id IS NULL
            ORDER BY ticket DESC LIMIT 200`,
        );
        return Promise.all(r.rows.map((v) => this.render(q, v.venta_pos_id)));
      },
      { readOnly: true },
    );
  }

  private async insertHeader(
    q: Queryable,
    a: { total: number; key: string; paraLlevar: boolean; mesaTexto: string | null; revierteA: string | null },
  ): Promise<string> {
    // El número de ticket es consecutivo por día: un candado por restaurante evita que dos cajas tomen el mismo.
    await q.query(`SELECT pg_advisory_xact_lock(7001, app_tenant_id()::int)`);
    const r = await q.query<{ venta_pos_id: string }>(
      `INSERT INTO venta_pos_cabecera (restaurante_id, fecha_local, ticket, para_llevar, mesa_texto, total_centavos, moneda_codigo, personal_id, clave_idempotencia, revierte_a_venta_pos_id)
       SELECT app_tenant_id(), ${HOY},
              COALESCE((SELECT max(ticket) FROM venta_pos_cabecera WHERE restaurante_id = app_tenant_id() AND fecha_local = ${HOY}), 0) + 1,
              $1, $2, $3, r.moneda_codigo, ${PERSONAL_ACTUAL}, $4, $5
         FROM restaurante r WHERE r.restaurante_id = app_tenant_id() RETURNING venta_pos_id`,
      [a.paraLlevar, a.mesaTexto, a.total, a.key, a.revierteA],
    );
    return r.rows[0]!.venta_pos_id;
  }

  private insertLine(q: Queryable, ventaId: string, l: Line, sign: 1 | -1) {
    return q.query(
      `INSERT INTO venta_pos_detalle (venta_pos_id, restaurante_id, plato_id, nombre_item, es_almuerzo, cantidad, precio_unitario_centavos, subtotal_centavos)
       VALUES ($1, app_tenant_id(), $2, $3, $4, $5::int, $6::bigint, $5::int * $6::bigint)`,
      [ventaId, l.platoId, l.nombre, l.esAlmuerzo, sign * l.cantidad, l.precio],
    );
  }

  private async byKey(q: Queryable, key: string) {
    const r = await q.query<{ venta_pos_id: string }>(
      'SELECT venta_pos_id FROM venta_pos_cabecera WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1 AND revierte_a_venta_pos_id IS NULL',
      [key],
    );
    return r.rows[0] ? this.render(q, r.rows[0].venta_pos_id) : null;
  }

  private async render(q: Queryable, ventaId: string) {
    const v = (
      await q.query<{
        public_id: string;
        ticket: number;
        fecha: string;
        total_centavos: string;
        moneda_codigo: string;
        para_llevar: boolean;
        mesa_texto: string | null;
        creado_en: Date;
        deshecha: boolean;
        pago_estado: string | null;
        metodo: string | null;
      }>(
        `SELECT v.public_id, v.ticket, v.fecha_local::text AS fecha, v.total_centavos, v.moneda_codigo, v.para_llevar, v.mesa_texto, v.creado_en,
              EXISTS (SELECT 1 FROM venta_pos_cabecera x WHERE x.revierte_a_venta_pos_id = v.venta_pos_id) AS deshecha,
              p.estado AS pago_estado, m.codigo AS metodo
         FROM venta_pos_cabecera v
         LEFT JOIN transaccion_pago p ON p.restaurante_id = v.restaurante_id AND p.venta_pos_id = v.venta_pos_id AND p.revierte_a_pago_id IS NULL
         LEFT JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
        WHERE v.restaurante_id = app_tenant_id() AND v.venta_pos_id = $1`,
        [ventaId],
      )
    ).rows[0]!;
    const lines = await q.query<{
      nombre_item: string;
      es_almuerzo: boolean;
      cantidad: number;
      precio_unitario_centavos: string;
      subtotal_centavos: string;
    }>(
      'SELECT nombre_item, es_almuerzo, cantidad, precio_unitario_centavos, subtotal_centavos FROM venta_pos_detalle WHERE restaurante_id = app_tenant_id() AND venta_pos_id = $1 ORDER BY venta_pos_detalle_id',
      [ventaId],
    );
    return {
      id: v.public_id,
      ticket: v.ticket,
      fecha: v.fecha,
      totalCentavos: Number(v.total_centavos),
      monedaCodigo: v.moneda_codigo,
      paraLlevar: v.para_llevar,
      mesaTexto: v.mesa_texto,
      creadoEn: v.creado_en,
      deshecha: v.deshecha,
      pago: v.pago_estado ? { estado: v.pago_estado, metodo: v.metodo } : null,
      items: lines.rows.map((l) => ({
        nombre: l.nombre_item,
        esAlmuerzo: l.es_almuerzo,
        cantidad: l.cantidad,
        precioUnitarioCentavos: Number(l.precio_unitario_centavos),
        subtotalCentavos: Number(l.subtotal_centavos),
      })),
    };
  }
}

@ApiTags('caja')
@Controller('v1/caja/ventas')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Ventas sueltas de hoy' })
  @ApiOkResponse({ type: VentaResponse, isArray: true })
  today() {
    return this.pos.today();
  }

  @Roles('DUENO', 'CAJERO')
  @Post()
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Registrar una venta suelta (sin plan)',
    description: 'Los precios de almuerzo y platos los pone el servidor. Efectivo queda confirmado.',
  })
  @ApiCreatedResponse({ type: VentaResponse })
  sell(@Body() dto: VentaDto, @IdempotencyKey() key: string) {
    return this.pos.sell(dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/deshacer')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Deshacer una venta suelta',
    description: 'Registra una venta y un pago inversos. El cajero, solo las del mismo día.',
  })
  @ApiOkResponse({ type: VentaResponse })
  undo(@Param('id', UuidPipe) id: string, @IdempotencyKey() key: string) {
    return this.pos.undo(id, key);
  }
}
