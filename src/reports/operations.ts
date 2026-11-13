import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems } from '../common/errors';
import { DbService } from '../db/db.service';
import { RangeQuery, num, resolveRange } from './common';

class RankingQuery extends RangeQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10, description: 'Cuántos platos devolver' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

class HoraPico {
  @ApiProperty({ minimum: 0, maximum: 23, description: 'Hora local del restaurante (0 = 00:00–00:59)' }) hora!: number;
  @ApiProperty({ description: 'Almuerzos de planes servidos esa hora (los devueltos no cuentan)' }) almuerzos!: number;
  @ApiProperty({ description: 'Tickets de ventas sueltas de esa hora (los deshechos no cuentan)' }) ventas!: number;
  @ApiProperty({ description: 'almuerzos + ventas' }) total!: number;
}
class HorasPicoResponse {
  @ApiProperty() desde!: string;
  @ApiProperty() hasta!: string;
  @ApiProperty() zonaHoraria!: string;
  @ApiProperty({ type: [HoraPico], description: 'Siempre 24 filas, de la hora 0 a la 23' }) porHora!: HoraPico[];
  @ApiPropertyOptional({ description: 'Hora con más movimiento (la más temprana si hay empate); null si no hubo nada' }) horaPico!:
    number | null;
  @ApiProperty() totalAlmuerzos!: number;
  @ApiProperty() totalVentas!: number;
}

class PlatoRanking {
  @ApiProperty({ example: 1 }) posicion!: number;
  @ApiProperty({ example: { id: 'uuid', nombre: 'Seco de pollo' }, description: 'id = public_id del plato' }) plato!: {
    id: string;
    nombre: string;
  };
  @ApiProperty({ description: 'unidadesVentas + unidadesPedidos' }) unidades!: number;
  @ApiProperty({ description: 'Vendidas sueltas en caja (netas de tickets deshechos)' }) unidadesVentas!: number;
  @ApiProperty({ description: 'Incluidas en pedidos de comensales ya canjeados' }) unidadesPedidos!: number;
  @ApiProperty({ description: 'Lo cobrado por ese plato (centavos); los platos dentro del almuerzo cuestan 0' }) ingresoCentavos!: number;
}
class RankingResponse {
  @ApiProperty() desde!: string;
  @ApiProperty() hasta!: string;
  @ApiProperty() zonaHoraria!: string;
  @ApiProperty() moneda!: string;
  @ApiProperty({ type: [PlatoRanking] }) items!: PlatoRanking[];
}

class BloqueVencimiento {
  @ApiProperty({ enum: ['HOY', 'EN_1_A_3_DIAS', 'EN_4_A_7_DIAS', 'EN_MAS_DE_7_DIAS'] }) rango!: string;
  @ApiProperty() planes!: number;
  @ApiProperty() almuerzos!: number;
  @ApiProperty() pasivoCentavos!: number;
}
class PlanPendiente {
  @ApiProperty() nombre!: string;
  @ApiProperty() planes!: number;
  @ApiProperty() almuerzos!: number;
  @ApiProperty() pasivoCentavos!: number;
}
class PendientesResponse {
  @ApiProperty({ description: 'Hoy, en la zona del local' }) fecha!: string;
  @ApiProperty() zonaHoraria!: string;
  @ApiProperty() moneda!: string;
  @ApiProperty({
    example: { clientes: 12, planes: 14, almuerzos: 60, pasivoCentavos: 18000 },
    description: 'Lo que el local todavía debe en almuerzos prepagados',
  })
  total!: { clientes: number; planes: number; almuerzos: number; pasivoCentavos: number };
  @ApiProperty({ type: [PlanPendiente], description: 'Por nombre de plan, de más a menos pasivo' }) porPlan!: PlanPendiente[];
  @ApiProperty({ type: [BloqueVencimiento], description: 'Siempre los 4 bloques, en este orden' }) porVencimiento!: BloqueVencimiento[];
}

const RANGOS = ['HOY', 'EN_1_A_3_DIAS', 'EN_4_A_7_DIAS', 'EN_MAS_DE_7_DIAS'] as const;

/** Reportes operativos del dueño: cuándo se llena el local, qué se pide más y cuántos almuerzos se deben. */
@Injectable()
export class OperationsService {
  constructor(private readonly db: DbService) {}

  peakHours(f: RangeQuery): Promise<HorasPicoResponse> {
    return this.db.forRequest(
      async (q) => {
        const { desde, hasta, zonaHoraria } = await resolveRange(q, f.desde, f.hasta);
        const rows = await q.query<{ hora: number; almuerzos: number; ventas: number }>(
          `SELECT h AS hora,
                  COALESCE((SELECT count(*) FROM consumo_almuerzo k
                             WHERE k.restaurante_id = app_tenant_id() AND k.fecha_local BETWEEN $1 AND $2 AND k.cantidad = 1
                               AND EXTRACT(HOUR FROM k.creado_en AT TIME ZONE $3) = h
                               AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)), 0)::int AS almuerzos,
                  COALESCE((SELECT count(*) FROM venta_pos_cabecera v
                             WHERE v.restaurante_id = app_tenant_id() AND v.fecha_local BETWEEN $1 AND $2 AND v.revierte_a_venta_pos_id IS NULL
                               AND EXTRACT(HOUR FROM v.creado_en AT TIME ZONE $3) = h
                               AND NOT EXISTS (SELECT 1 FROM venta_pos_cabecera x WHERE x.revierte_a_venta_pos_id = v.venta_pos_id)), 0)::int AS ventas
             FROM generate_series(0, 23) AS h ORDER BY h`,
          [desde, hasta, zonaHoraria],
        );
        const porHora = rows.rows.map((r) => ({ hora: r.hora, almuerzos: r.almuerzos, ventas: r.ventas, total: r.almuerzos + r.ventas }));
        const max = Math.max(...porHora.map((h) => h.total));
        return {
          desde,
          hasta,
          zonaHoraria,
          porHora,
          horaPico: max > 0 ? porHora.find((h) => h.total === max)!.hora : null,
          totalAlmuerzos: porHora.reduce((s, h) => s + h.almuerzos, 0),
          totalVentas: porHora.reduce((s, h) => s + h.ventas, 0),
        };
      },
      { readOnly: true },
    );
  }

  dishRanking(f: RankingQuery): Promise<RankingResponse> {
    return this.db.forRequest(
      async (q) => {
        const { desde, hasta, zonaHoraria, moneda } = await resolveRange(q, f.desde, f.hasta);
        const r = await q.query<{ public_id: string; nombre: string; u_ventas: number; u_pedidos: number; ingreso: string }>(
          `WITH ventas AS (
             SELECT d.plato_id, sum(d.cantidad)::int AS u, sum(d.subtotal_centavos) AS ing
               FROM venta_pos_detalle d
               JOIN venta_pos_cabecera v ON v.restaurante_id = d.restaurante_id AND v.venta_pos_id = d.venta_pos_id
              WHERE d.restaurante_id = app_tenant_id() AND d.plato_id IS NOT NULL AND v.fecha_local BETWEEN $1 AND $2
              GROUP BY d.plato_id),
           pedidos AS (
             SELECT d.plato_id, sum(d.cantidad)::int AS u, sum(d.cantidad * d.precio_unitario_centavos) AS ing
               FROM orden_detalle d
               JOIN orden_cabecera o ON o.restaurante_id = d.restaurante_id AND o.orden_id = d.orden_id
              WHERE d.restaurante_id = app_tenant_id() AND o.estado IN ('CANJEADA', 'SERVIDA') AND o.fecha_local BETWEEN $1 AND $2
              GROUP BY d.plato_id)
           SELECT p.public_id, p.nombre, COALESCE(v.u, 0) AS u_ventas, COALESCE(o.u, 0) AS u_pedidos,
                  COALESCE(v.ing, 0) + COALESCE(o.ing, 0) AS ingreso
             FROM plato p LEFT JOIN ventas v ON v.plato_id = p.plato_id LEFT JOIN pedidos o ON o.plato_id = p.plato_id
            WHERE p.restaurante_id = app_tenant_id() AND COALESCE(v.u, 0) + COALESCE(o.u, 0) > 0
            ORDER BY COALESCE(v.u, 0) + COALESCE(o.u, 0) DESC, p.nombre, p.public_id
            LIMIT $3`,
          [desde, hasta, f.limit ?? 10],
        );
        return {
          desde,
          hasta,
          zonaHoraria,
          moneda,
          items: r.rows.map((p, i) => ({
            posicion: i + 1,
            plato: { id: p.public_id, nombre: p.nombre },
            unidades: p.u_ventas + p.u_pedidos,
            unidadesVentas: p.u_ventas,
            unidadesPedidos: p.u_pedidos,
            ingresoCentavos: num(p.ingreso),
          })),
        };
      },
      { readOnly: true },
    );
  }

  /**
   * Pasivo: almuerzos prepagados que el local aún debe. Cuenta los planes ACTIVA que todavía no vencieron en hora
   * local (un plan que venció ayer y espera al job de expiración ya no se puede consumir, así que no es deuda).
   */
  outstanding(): Promise<PendientesResponse> {
    return this.db.forRequest(
      async (q) => {
        const { hasta: hoy, zonaHoraria, moneda } = await resolveRange(q);
        const live = `FROM suscripcion_plan s WHERE s.restaurante_id = app_tenant_id() AND s.estado = 'ACTIVA' AND s.almuerzos_restantes > 0 AND s.vence_el >= $1::date`;
        const total = (
          await q.query<{ clientes: number; planes: number; almuerzos: number; pasivo: string }>(
            `SELECT count(DISTINCT s.cliente_id)::int AS clientes, count(*)::int AS planes, COALESCE(sum(s.almuerzos_restantes), 0)::int AS almuerzos,
                    COALESCE(sum(s.almuerzos_restantes * s.precio_unitario_centavos), 0) AS pasivo ${live}`,
            [hoy],
          )
        ).rows[0]!;
        const porPlan = await q.query<{ nombre: string; planes: number; almuerzos: number; pasivo: string }>(
          `SELECT s.nombre_plan AS nombre, count(*)::int AS planes, sum(s.almuerzos_restantes)::int AS almuerzos,
                  sum(s.almuerzos_restantes * s.precio_unitario_centavos) AS pasivo ${live}
            GROUP BY s.nombre_plan ORDER BY pasivo DESC, s.nombre_plan`,
          [hoy],
        );
        const bloques = await q.query<{ rango: string; planes: number; almuerzos: number; pasivo: string }>(
          `SELECT CASE WHEN s.vence_el = $1::date THEN 'HOY' WHEN s.vence_el <= $1::date + 3 THEN 'EN_1_A_3_DIAS'
                       WHEN s.vence_el <= $1::date + 7 THEN 'EN_4_A_7_DIAS' ELSE 'EN_MAS_DE_7_DIAS' END AS rango,
                  count(*)::int AS planes, sum(s.almuerzos_restantes)::int AS almuerzos,
                  sum(s.almuerzos_restantes * s.precio_unitario_centavos) AS pasivo ${live} GROUP BY 1`,
          [hoy],
        );
        const byRango = new Map(bloques.rows.map((b) => [b.rango, b]));
        return {
          fecha: hoy,
          zonaHoraria,
          moneda,
          total: { clientes: total.clientes, planes: total.planes, almuerzos: total.almuerzos, pasivoCentavos: num(total.pasivo) },
          porPlan: porPlan.rows.map((p) => ({ nombre: p.nombre, planes: p.planes, almuerzos: p.almuerzos, pasivoCentavos: num(p.pasivo) })),
          porVencimiento: RANGOS.map((rango) => {
            const b = byRango.get(rango);
            return { rango, planes: b?.planes ?? 0, almuerzos: b?.almuerzos ?? 0, pasivoCentavos: num(b?.pasivo) };
          }),
        };
      },
      { readOnly: true },
    );
  }
}

@ApiTags('reportes')
@Controller('v1/reportes')
export class OperationsController {
  constructor(private readonly svc: OperationsService) {}

  @Roles('DUENO')
  @Get('horas-pico')
  @ApiOperation({
    summary: 'Horas pico',
    description:
      'Almuerzos servidos y tickets de venta por hora local (0–23) en un rango de días. Los almuerzos devueltos y los tickets deshechos no cuentan, así un reverso no mueve la hora.',
  })
  @ApiOkResponse({ type: HorasPicoResponse })
  @ApiProblems({ 400: ['FECHA_INVALIDA', 'RANGO_INVALIDO', 'RANGO_MUY_LARGO'] })
  peak(@Query() q: RangeQuery) {
    return this.svc.peakHours(q);
  }

  @Roles('DUENO')
  @Get('ranking-platos')
  @ApiOperation({
    summary: 'Ranking de platos',
    description:
      'Platos más pedidos en un rango: vendidos sueltos en caja (netos de deshechos) y dentro de pedidos de comensales ya canjeados. Un plato de un pedido que además se cobra en caja cuenta en las dos fuentes, que se muestran por separado.',
  })
  @ApiOkResponse({ type: RankingResponse })
  @ApiProblems({ 400: ['FECHA_INVALIDA', 'RANGO_INVALIDO', 'RANGO_MUY_LARGO'] })
  ranking(@Query() q: RankingQuery) {
    return this.svc.dishRanking(q);
  }

  @Roles('DUENO')
  @Get('almuerzos-pendientes')
  @ApiOperation({
    summary: 'Almuerzos pendientes (lo que debes)',
    description:
      'Almuerzos prepagados que quedan en planes activos y no vencidos, con su valor en centavos (precio unitario de cada plan), por plan y por cercanía al vencimiento.',
  })
  @ApiOkResponse({ type: PendientesResponse })
  outstanding() {
    return this.svc.outstanding();
  }
}
