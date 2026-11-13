import {
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
import { ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { FechaOHoyPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';
import { RequestContextStore } from '../tenancy/request-context';
import { PERSONAL_ACTUAL } from './checkout';

const HOY = `(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())`;

export class CerrarCajaDto {
  @ApiProperty({ example: 4550, description: 'Efectivo contado en la gaveta, en centavos' })
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  efectivoContadoCentavos!: number;
  @ApiPropertyOptional() @IsOptional() @Text() @IsString() @MaxLength(300) nota?: string;
}

interface MethodRow {
  metodo_pago_id: string;
  codigo: string;
  nombre: string;
  es_efectivo: boolean;
  planes: string;
  pos: string;
}

@Injectable()
export class CashService {
  constructor(private readonly db: DbService) {}

  get(fecha: string) {
    return this.db.forRequest(async (q) => this.view(q, await this.resolve(q, fecha)), { readOnly: true });
  }

  /** Cierra la caja del día: guarda la foto de lo esperado por método y lo contado. Solo un cierre activo por día. */
  async close(fecha: string, dto: CerrarCajaDto) {
    try {
      return await this.db.forRequest(async (q) => {
        const date = await this.resolve(q, fecha);
        const hoy = (await q.query<{ hoy: string }>(`SELECT ${HOY}::text AS hoy`)).rows[0]!.hoy;
        if (date > hoy) throw new ConflictException('No se puede cerrar un día que aún no llega.');
        if (date !== hoy && RequestContextStore.get()?.role === 'CAJERO')
          throw new ForbiddenException('El cajero solo puede cerrar la caja de hoy.');
        const s = await this.summary(q, date);
        const c = await q.query<{ cierre_caja_id: string }>(
          `INSERT INTO cierre_caja_cabecera (restaurante_id, fecha_local, moneda_codigo, efectivo_esperado_centavos, efectivo_contado_centavos,
               almuerzos_servidos, almuerzos_para_llevar, nota, cerrado_por_personal_id)
           SELECT app_tenant_id(), $1, r.moneda_codigo, $2, $3, $4, $5, $6, ${PERSONAL_ACTUAL} FROM restaurante r WHERE r.restaurante_id = app_tenant_id()
           RETURNING cierre_caja_id`,
          [
            date,
            s.efectivoEsperadoCentavos,
            dto.efectivoContadoCentavos,
            Math.max(0, s.almuerzosServidos),
            Math.max(0, s.almuerzosParaLlevar),
            dto.nota ?? null,
          ],
        );
        for (const m of s.rows) {
          if (Number(m.planes) === 0 && Number(m.pos) === 0) continue;
          await q.query(
            'INSERT INTO cierre_caja_detalle (cierre_caja_id, restaurante_id, metodo_pago_id, planes_centavos, pos_centavos) VALUES ($1, app_tenant_id(), $2, $3, $4)',
            [c.rows[0]!.cierre_caja_id, m.metodo_pago_id, m.planes, m.pos],
          );
        }
        return this.view(q, date);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_cierre_caja_dia')
        throw new ConflictException('La caja de ese día ya está cerrada. El dueño puede reabrirla.');
      throw err;
    }
  }

  /** Reabre el día: el cierre anterior queda en el historial (inactivo) y se puede cerrar de nuevo. */
  reopen(fecha: string) {
    return this.db.forRequest(async (q) => {
      const date = await this.resolve(q, fecha);
      const r = await q.query(
        'UPDATE cierre_caja_cabecera SET activo = false WHERE restaurante_id = app_tenant_id() AND fecha_local = $1 AND activo',
        [date],
      );
      if (!r.rowCount) throw new NotFoundException('Ese día no tiene un cierre activo.');
      return this.view(q, date);
    });
  }

  private async resolve(q: Queryable, fecha: string) {
    return fecha === 'hoy' ? (await q.query<{ hoy: string }>(`SELECT ${HOY}::text AS hoy`)).rows[0]!.hoy : fecha;
  }

  /**
   * Lo que debería haber según el sistema. Solo cuentan pagos CONFIRMADOS; los reversos restan el día en que se hacen.
   * `planes` = cobros de planes; `pos` = todo lo demás (ventas sueltas, pedidos, ofertas).
   */
  private async summary(q: Queryable, date: string) {
    const pay = await q.query<MethodRow>(
      `SELECT m.metodo_pago_id, m.codigo, m.nombre, m.es_efectivo,
              COALESCE(sum(p.monto_centavos) FILTER (WHERE p.suscripcion_id IS NOT NULL), 0) AS planes,
              COALESCE(sum(p.monto_centavos) FILTER (WHERE p.suscripcion_id IS NULL), 0) AS pos
         FROM transaccion_pago p JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
        WHERE p.restaurante_id = app_tenant_id() AND p.fecha_local = $1 AND p.estado = 'CONFIRMADO'
        GROUP BY m.metodo_pago_id, m.codigo, m.nombre, m.es_efectivo ORDER BY m.metodo_pago_id`,
      [date],
    );
    const n = (
      await q.query<{ pendientes: number; plan: number; plan_llevar: number; pos: number; pos_llevar: number }>(
        `SELECT (SELECT count(*)::int FROM transaccion_pago WHERE restaurante_id = app_tenant_id() AND fecha_local = $1 AND estado = 'PENDIENTE') AS pendientes,
              (SELECT COALESCE(sum(cantidad), 0)::int FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND fecha_local = $1) AS plan,
              (SELECT COALESCE(sum(cantidad), 0)::int FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND fecha_local = $1 AND para_llevar) AS plan_llevar,
              (SELECT COALESCE(sum(d.cantidad), 0)::int FROM venta_pos_detalle d JOIN venta_pos_cabecera v ON v.venta_pos_id = d.venta_pos_id
                WHERE v.restaurante_id = app_tenant_id() AND v.fecha_local = $1 AND d.es_almuerzo) AS pos,
              (SELECT COALESCE(sum(d.cantidad), 0)::int FROM venta_pos_detalle d JOIN venta_pos_cabecera v ON v.venta_pos_id = d.venta_pos_id
                WHERE v.restaurante_id = app_tenant_id() AND v.fecha_local = $1 AND d.es_almuerzo AND v.para_llevar) AS pos_llevar`,
        [date],
      )
    ).rows[0]!;
    return {
      rows: pay.rows,
      efectivoEsperadoCentavos: pay.rows.filter((m) => m.es_efectivo).reduce((s, m) => s + Number(m.planes) + Number(m.pos), 0),
      totalCentavos: pay.rows.reduce((s, m) => s + Number(m.planes) + Number(m.pos), 0),
      almuerzosConPlan: n.plan,
      almuerzosSueltos: n.pos,
      almuerzosServidos: n.plan + n.pos,
      almuerzosParaLlevar: n.plan_llevar + n.pos_llevar,
      pagosPendientes: n.pendientes,
    };
  }

  private async view(q: Queryable, date: string) {
    const s = await this.summary(q, date);
    const c = (
      await q.query<{
        efectivo_esperado_centavos: string;
        efectivo_contado_centavos: string;
        diferencia_centavos: string;
        nota: string | null;
        cerrado_en: Date;
        cerrado_por: string;
      }>(
        `SELECT c.efectivo_esperado_centavos, c.efectivo_contado_centavos, c.diferencia_centavos, c.nota, c.cerrado_en, p.nombre_visible AS cerrado_por
         FROM cierre_caja_cabecera c JOIN personal_restaurante p ON p.personal_id = c.cerrado_por_personal_id
        WHERE c.restaurante_id = app_tenant_id() AND c.fecha_local = $1 AND c.activo`,
        [date],
      )
    ).rows[0];
    return {
      fecha: date,
      efectivoEsperadoCentavos: s.efectivoEsperadoCentavos,
      totalCentavos: s.totalCentavos,
      porMetodo: s.rows.map((m) => ({
        metodo: m.codigo,
        nombre: m.nombre,
        esEfectivo: m.es_efectivo,
        planesCentavos: Number(m.planes),
        posCentavos: Number(m.pos),
        totalCentavos: Number(m.planes) + Number(m.pos),
      })),
      almuerzosServidos: s.almuerzosServidos,
      almuerzosConPlan: s.almuerzosConPlan,
      almuerzosSueltos: s.almuerzosSueltos,
      almuerzosParaLlevar: s.almuerzosParaLlevar,
      pagosPendientes: s.pagosPendientes,
      cierre: c
        ? {
            efectivoEsperadoCentavos: Number(c.efectivo_esperado_centavos),
            efectivoContadoCentavos: Number(c.efectivo_contado_centavos),
            diferenciaCentavos: Number(c.diferencia_centavos),
            nota: c.nota,
            cerradoEn: c.cerrado_en,
            cerradoPor: c.cerrado_por,
            // true si hubo cobros o reversos en efectivo después de cerrar: conviene reabrir y volver a contar.
            movimientosDespuesDelCierre: Number(c.efectivo_esperado_centavos) !== s.efectivoEsperadoCentavos,
          }
        : null,
    };
  }
}

const FECHA = { name: 'fecha', description: 'AAAA-MM-DD o `hoy` (zona horaria del restaurante)', example: 'hoy' } as const;

@ApiTags('caja')
@Controller('v1/caja/cierre')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Roles('DUENO', 'CAJERO')
  @Get(':fecha')
  @ApiParam(FECHA)
  @ApiOperation({
    summary: 'Arqueo del día: lo esperado por método de pago y el cierre, si existe',
    description:
      'Efectivo esperado = cobros confirmados en efectivo del día (planes + ventas sueltas + pedidos + ofertas), menos reversos.',
  })
  get(@Param('fecha', FechaOHoyPipe) fecha: string) {
    return this.cash.get(fecha);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':fecha')
  @ApiParam(FECHA)
  @ApiOperation({
    summary: 'Cerrar la caja',
    description: 'Un solo cierre activo por día (repetir → 409). El cajero solo cierra el día de hoy.',
  })
  close(@Param('fecha', FechaOHoyPipe) fecha: string, @Body() dto: CerrarCajaDto) {
    return this.cash.close(fecha, dto);
  }

  @Roles('DUENO')
  @Post(':fecha/reabrir')
  @HttpCode(200)
  @ApiParam(FECHA)
  @ApiOperation({ summary: 'Reabrir la caja de un día', description: 'El cierre anterior queda en el historial.' })
  reopen(@Param('fecha', FechaOHoyPipe) fecha: string) {
    return this.cash.reopen(fecha);
  }
}
