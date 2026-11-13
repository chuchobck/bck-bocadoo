import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems } from '../common/errors';
import { DbService } from '../db/db.service';
import { DayQuery, RangeQuery, num, resolveRange } from './common';

const CANALES = ['QR', 'MANUAL', 'PREORDEN', 'MESA'] as const;
const ORIGENES = ['planes', 'ventas', 'ofertas', 'pedidos'] as const;

class AlmuerzosDia {
  @ApiProperty({ description: 'Almuerzos descontados de planes, netos de devoluciones' }) servidos!: number;
  @ApiProperty() paraLlevar!: number;
  @ApiProperty({ example: { QR: 40, MANUAL: 2, PREORDEN: 3, MESA: 5 } }) porCanal!: Record<(typeof CANALES)[number], number>;
}
class IngresosDia {
  @ApiProperty({ description: 'Cobros confirmados del día, netos de reversos (centavos)' }) totalCentavos!: number;
  @ApiProperty({ example: { planes: 1500, ventas: 700, ofertas: 900, pedidos: 0 } }) porOrigen!: Record<(typeof ORIGENES)[number], number>;
  @ApiProperty({ example: [{ metodo: 'EFECTIVO', centavos: 2400 }] }) porMetodo!: { metodo: string; centavos: number }[];
  @ApiProperty({ example: { cantidad: 1, centavos: 1500 }, description: 'Transferencias o Deuna sin confirmar (no están en el total)' })
  pendientesPorConfirmar!: { cantidad: number; centavos: number };
}
class VentasPosDia {
  @ApiProperty() tickets!: number;
  @ApiProperty({ description: 'Tickets deshechos' }) reversos!: number;
  @ApiProperty({ description: 'Neto de reversos (centavos)' }) totalCentavos!: number;
  @ApiProperty({ description: 'Almuerzos sueltos vendidos, netos' }) almuerzos!: number;
}
class CantidadMonto {
  @ApiProperty() cantidad!: number;
  @ApiProperty() centavos!: number;
}
class ResumenDiarioResponse {
  @ApiProperty({ example: '2026-10-31', description: 'Día local del restaurante' }) fecha!: string;
  @ApiProperty({ example: 'America/Guayaquil' }) zonaHoraria!: string;
  @ApiProperty({ example: 'USD' }) moneda!: string;
  @ApiProperty({ type: AlmuerzosDia }) almuerzos!: AlmuerzosDia;
  @ApiProperty({ type: IngresosDia }) ingresos!: IngresosDia;
  @ApiProperty({ type: VentasPosDia }) ventasPos!: VentasPosDia;
  @ApiProperty({ type: CantidadMonto, description: 'Planes vendidos ese día, sin los anulados ni las cartulinas migradas' })
  planesVendidos!: CantidadMonto;
  @ApiProperty({ example: { unidades: 3, centavos: 1350 }, description: 'Canjes de ofertas flash' }) ofertas!: {
    unidades: number;
    centavos: number;
  };
  @ApiProperty({ example: { total: 50, validos: 47, rechazados: 3 }, description: 'Escaneos en caja' }) escaneos!: {
    total: number;
    validos: number;
    rechazados: number;
  };
}

class PlanVentas {
  @ApiProperty({ example: 'Semanal' }) nombre!: string;
  @ApiProperty({ description: 'No anulados' }) vendidos!: number;
  @ApiProperty() anulados!: number;
  @ApiProperty({ description: 'Precio pagado de los vendidos (centavos)' }) ingresoCentavos!: number;
  @ApiProperty({ description: 'Almuerzos incluidos en lo vendido' }) almuerzosVendidos!: number;
  @ApiProperty({ description: 'Almuerzos ya consumidos de lo vendido' }) almuerzosConsumidos!: number;
}
class VentasPlanesResponse {
  @ApiProperty() desde!: string;
  @ApiProperty() hasta!: string;
  @ApiProperty() zonaHoraria!: string;
  @ApiProperty() moneda!: string;
  @ApiProperty({ example: { vendidos: 12, anulados: 1, ingresoCentavos: 18000 } }) total!: {
    vendidos: number;
    anulados: number;
    ingresoCentavos: number;
  };
  @ApiProperty({ type: [PlanVentas], description: 'Por nombre de plan, de más a menos ingreso' }) porPlan!: PlanVentas[];
  @ApiProperty({ example: [{ fecha: '2026-10-30', vendidos: 2, ingresoCentavos: 3000 }], description: 'Solo los días con ventas' })
  porDia!: { fecha: string; vendidos: number; ingresoCentavos: number }[];
}

/**
 * Reportes del dueño. Todo se calcula en la zona horaria del restaurante (`restaurante.zona_horaria`) con los libros
 * de solo inserción (consumos, ventas, pagos): los reversos restan, nada se borra, y las cifras salen de la misma
 * fuente que el cierre de caja.
 */
@Injectable()
export class SummaryService {
  constructor(private readonly db: DbService) {}

  daily(f: DayQuery): Promise<ResumenDiarioResponse> {
    return this.db.forRequest(
      async (q) => {
        const { hasta: fecha, zonaHoraria, moneda } = await resolveRange(q, f.fecha, f.fecha);
        const consumos = await q.query<{ canal: string; total: number; llevar: number }>(
          `SELECT canal, COALESCE(sum(cantidad), 0)::int AS total, COALESCE(sum(cantidad) FILTER (WHERE para_llevar), 0)::int AS llevar
             FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND fecha_local = $1 GROUP BY canal`,
          [fecha],
        );
        const pos = (
          await q.query<{ tickets: number; reversos: number; total: string }>(
            `SELECT count(*) FILTER (WHERE revierte_a_venta_pos_id IS NULL)::int AS tickets,
                    count(*) FILTER (WHERE revierte_a_venta_pos_id IS NOT NULL)::int AS reversos,
                    COALESCE(sum(total_centavos), 0) AS total
               FROM venta_pos_cabecera WHERE restaurante_id = app_tenant_id() AND fecha_local = $1`,
            [fecha],
          )
        ).rows[0]!;
        const posAlmuerzos = (
          await q.query<{ n: number }>(
            `SELECT COALESCE(sum(d.cantidad), 0)::int AS n FROM venta_pos_detalle d
               JOIN venta_pos_cabecera v ON v.restaurante_id = d.restaurante_id AND v.venta_pos_id = d.venta_pos_id
              WHERE d.restaurante_id = app_tenant_id() AND v.fecha_local = $1 AND d.es_almuerzo`,
            [fecha],
          )
        ).rows[0]!.n;
        const pagos = await q.query<{ origen: string; estado: string; metodo: string; centavos: string; n: number }>(
          `SELECT CASE WHEN p.suscripcion_id IS NOT NULL THEN 'planes' WHEN p.venta_pos_id IS NOT NULL THEN 'ventas'
                       WHEN p.canje_oferta_id IS NOT NULL THEN 'ofertas' ELSE 'pedidos' END AS origen,
                  p.estado, m.codigo AS metodo, sum(p.monto_centavos) AS centavos, count(*)::int AS n
             FROM transaccion_pago p JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
            WHERE p.restaurante_id = app_tenant_id() AND p.fecha_local = $1 AND p.estado <> 'RECHAZADO'
            GROUP BY 1, 2, 3`,
          [fecha],
        );
        const planes = (
          await q.query<{ n: number; centavos: string }>(
            `SELECT count(*)::int AS n, COALESCE(sum(precio_pagado_centavos), 0) AS centavos
               FROM suscripcion_plan s JOIN restaurante r ON r.restaurante_id = s.restaurante_id
              WHERE s.restaurante_id = app_tenant_id() AND s.origen = 'VENTA' AND s.estado <> 'ANULADA'
                AND (s.comprada_en AT TIME ZONE r.zona_horaria)::date = $1`,
            [fecha],
          )
        ).rows[0]!;
        const ofertas = (
          await q.query<{ unidades: number; centavos: string }>(
            `SELECT COALESCE(sum(c.cantidad), 0)::int AS unidades, COALESCE(sum(c.monto_centavos), 0) AS centavos
               FROM canje_oferta_flash c JOIN restaurante r ON r.restaurante_id = c.restaurante_id
              WHERE c.restaurante_id = app_tenant_id() AND (c.creado_en AT TIME ZONE r.zona_horaria)::date = $1`,
            [fecha],
          )
        ).rows[0]!;
        const escaneos = (
          await q.query<{ total: number; validos: number }>(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE resultado IN ('OK', 'OK_ADVERTENCIA'))::int AS validos
               FROM intento_escaneo i JOIN restaurante r ON r.restaurante_id = i.restaurante_id
              WHERE i.restaurante_id = app_tenant_id() AND (i.creado_en AT TIME ZONE r.zona_horaria)::date = $1`,
            [fecha],
          )
        ).rows[0]!;

        const porCanal = Object.fromEntries(CANALES.map((c) => [c, 0])) as Record<(typeof CANALES)[number], number>;
        for (const c of consumos.rows) porCanal[c.canal as (typeof CANALES)[number]] = c.total;
        const porOrigen = Object.fromEntries(ORIGENES.map((o) => [o, 0])) as Record<(typeof ORIGENES)[number], number>;
        const porMetodo = new Map<string, number>();
        const pendientes = { cantidad: 0, centavos: 0 };
        for (const p of pagos.rows) {
          if (p.estado === 'PENDIENTE') {
            pendientes.cantidad += p.n;
            pendientes.centavos += num(p.centavos);
            continue;
          }
          porOrigen[p.origen as (typeof ORIGENES)[number]] += num(p.centavos);
          porMetodo.set(p.metodo, (porMetodo.get(p.metodo) ?? 0) + num(p.centavos));
        }
        return {
          fecha,
          zonaHoraria,
          moneda,
          almuerzos: {
            servidos: consumos.rows.reduce((s, c) => s + c.total, 0),
            paraLlevar: consumos.rows.reduce((s, c) => s + c.llevar, 0),
            porCanal,
          },
          ingresos: {
            totalCentavos: Object.values(porOrigen).reduce((s, v) => s + v, 0),
            porOrigen,
            porMetodo: [...porMetodo].map(([metodo, centavos]) => ({ metodo, centavos })).sort((a, b) => a.metodo.localeCompare(b.metodo)),
            pendientesPorConfirmar: pendientes,
          },
          ventasPos: { tickets: pos.tickets, reversos: pos.reversos, totalCentavos: num(pos.total), almuerzos: posAlmuerzos },
          planesVendidos: { cantidad: planes.n, centavos: num(planes.centavos) },
          ofertas: { unidades: ofertas.unidades, centavos: num(ofertas.centavos) },
          escaneos: { total: escaneos.total, validos: escaneos.validos, rechazados: escaneos.total - escaneos.validos },
        };
      },
      { readOnly: true },
    );
  }

  plans(f: RangeQuery): Promise<VentasPlanesResponse> {
    return this.db.forRequest(
      async (q) => {
        const { desde, hasta, zonaHoraria, moneda } = await resolveRange(q, f.desde, f.hasta);
        const base = `FROM suscripcion_plan s JOIN restaurante r ON r.restaurante_id = s.restaurante_id
                     WHERE s.restaurante_id = app_tenant_id() AND s.origen = 'VENTA'
                       AND (s.comprada_en AT TIME ZONE r.zona_horaria)::date BETWEEN $1 AND $2`;
        const porPlan = await q.query<{
          nombre: string;
          vendidos: number;
          anulados: number;
          ingreso: string;
          vendidos_almuerzos: number;
          consumidos: number;
        }>(
          `SELECT s.nombre_plan AS nombre,
                  count(*) FILTER (WHERE s.estado <> 'ANULADA')::int AS vendidos,
                  count(*) FILTER (WHERE s.estado = 'ANULADA')::int AS anulados,
                  COALESCE(sum(s.precio_pagado_centavos) FILTER (WHERE s.estado <> 'ANULADA'), 0) AS ingreso,
                  COALESCE(sum(s.almuerzos_totales) FILTER (WHERE s.estado <> 'ANULADA'), 0)::int AS vendidos_almuerzos,
                  COALESCE(sum(s.almuerzos_totales - s.almuerzos_restantes) FILTER (WHERE s.estado <> 'ANULADA'), 0)::int AS consumidos
             ${base} GROUP BY s.nombre_plan ORDER BY ingreso DESC, s.nombre_plan`,
          [desde, hasta],
        );
        const porDia = await q.query<{ fecha: string; vendidos: number; ingreso: string }>(
          `SELECT (s.comprada_en AT TIME ZONE r.zona_horaria)::date::text AS fecha, count(*)::int AS vendidos,
                  sum(s.precio_pagado_centavos) AS ingreso
             ${base} AND s.estado <> 'ANULADA' GROUP BY 1 ORDER BY 1`,
          [desde, hasta],
        );
        const plans = porPlan.rows.map((p) => ({
          nombre: p.nombre,
          vendidos: p.vendidos,
          anulados: p.anulados,
          ingresoCentavos: num(p.ingreso),
          almuerzosVendidos: p.vendidos_almuerzos,
          almuerzosConsumidos: p.consumidos,
        }));
        return {
          desde,
          hasta,
          zonaHoraria,
          moneda,
          total: {
            vendidos: plans.reduce((s, p) => s + p.vendidos, 0),
            anulados: plans.reduce((s, p) => s + p.anulados, 0),
            ingresoCentavos: plans.reduce((s, p) => s + p.ingresoCentavos, 0),
          },
          porPlan: plans,
          porDia: porDia.rows.map((d) => ({ fecha: d.fecha, vendidos: d.vendidos, ingresoCentavos: num(d.ingreso) })),
        };
      },
      { readOnly: true },
    );
  }
}

@ApiTags('reportes')
@Controller('v1/reportes')
export class SummaryController {
  constructor(private readonly svc: SummaryService) {}

  @Roles('DUENO')
  @Get('resumen-diario')
  @ApiOperation({
    summary: 'Resumen del día',
    description:
      'Almuerzos servidos, ingresos por origen y método, ventas sueltas, planes vendidos, canjes de ofertas y escaneos de un día local del restaurante. Sin `fecha` es hoy en la zona horaria del local.',
  })
  @ApiOkResponse({ type: ResumenDiarioResponse })
  @ApiProblems({ 400: ['FECHA_INVALIDA'] })
  daily(@Query() q: DayQuery) {
    return this.svc.daily(q);
  }

  @Roles('DUENO')
  @Get('ventas-planes')
  @ApiOperation({
    summary: 'Ventas de planes',
    description:
      'Planes vendidos en un rango de días locales (máximo 366), por nombre de plan y por día. No cuenta los anulados como venta ni las cartulinas migradas.',
  })
  @ApiOkResponse({ type: VentasPlanesResponse })
  @ApiProblems({ 400: ['FECHA_INVALIDA', 'RANGO_INVALIDO', 'RANGO_MUY_LARGO'] })
  plans(@Query() q: RangeQuery) {
    return this.svc.plans(q);
  }
}
