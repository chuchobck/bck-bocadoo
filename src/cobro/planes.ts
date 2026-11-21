// Lectura de los planes de los clientes para estimar cobros (docs/spec-cobros.md, B.2 `plan.estado` y `plan.disponibles`).
// Todo lo que cuenta "hoy" usa la misma condición que fn_descontar_almuerzo
// (db/migrations/20261116000000_descontar_almuerzo_mesa.sql:82-87): ACTIVA, vence_el >= hoy y hoy en dias_validos.

import type { PlanPersona } from '../billing/tipos';
import type { Queryable } from '../db/db.service';
import { type PlanFilas, planDesdeFilas } from './adaptador';

/**
 * SQL: el plan `s` vale hoy. `hoy` es una expresión SQL de tipo date (la fecha local del local).
 * Es la condición de fn_descontar_almuerzo; INC-12 la aplica a todas las vistas.
 */
export const planVigenteHoySql = (s: string, hoy: string) =>
  `(${s}.estado = 'ACTIVA' AND ${s}.vence_el >= ${hoy} AND EXTRACT(ISODOW FROM ${hoy})::smallint = ANY (${s}.dias_validos))`;

export const claveCliente = (restauranteId: string, clienteId: string) => `${restauranteId}:${clienteId}`;

/**
 * Plan de cada (restaurante, cliente) para HOY en la zona horaria del local. Un cliente null (sin ficha) no se consulta:
 * quien llama usa `SIN_PLAN`. Corre con los permisos de quien consulta: el comensal solo lee sus propios planes y el
 * personal los de su local (RLS); un cliente que no se pueda leer saldría como "sin plan", por eso quien llama solo
 * pregunta por los que puede ver.
 */
export async function cargarPlanes(
  q: Queryable,
  pares: { restauranteId: string; clienteId: string | null }[],
): Promise<Map<string, PlanPersona>> {
  const unicos = new Map<string, { restauranteId: string; clienteId: string }>();
  for (const p of pares) if (p.clienteId !== null) unicos.set(claveCliente(p.restauranteId, p.clienteId), { ...p, clienteId: p.clienteId });
  const out = new Map<string, PlanPersona>();
  if (!unicos.size) return out;
  const lista = [...unicos.values()];
  const r = await q.query<{
    restaurante_id: string;
    cliente_id: string;
    disponibles: number;
    activa_vigente: boolean | null;
    vencida_con_saldo: boolean | null;
    hay_plan: boolean;
  }>(
    `SELECT p.restaurante_id, p.cliente_id, x.disponibles, x.activa_vigente, x.vencida_con_saldo, x.hay_plan
       FROM unnest($1::bigint[], $2::bigint[]) AS p(restaurante_id, cliente_id)
       JOIN restaurante r ON r.restaurante_id = p.restaurante_id
       CROSS JOIN LATERAL (SELECT (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date AS hoy) h
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(s.almuerzos_restantes) FILTER (WHERE ${planVigenteHoySql('s', 'h.hoy')}), 0)::int AS disponibles,
                bool_or(s.estado = 'ACTIVA' AND s.vence_el >= h.hoy) AS activa_vigente,
                bool_or(s.almuerzos_restantes > 0 AND s.estado IN ('ACTIVA', 'VENCIDA') AND s.vence_el < h.hoy) AS vencida_con_saldo,
                count(*) > 0 AS hay_plan
           FROM suscripcion_plan s WHERE s.restaurante_id = p.restaurante_id AND s.cliente_id = p.cliente_id) x`,
    [lista.map((p) => p.restauranteId), lista.map((p) => p.clienteId)],
  );
  for (const f of r.rows) {
    const filas: PlanFilas = {
      disponibles: f.disponibles,
      hayActivaVigente: f.activa_vigente === true,
      hayVencidaConSaldo: f.vencida_con_saldo === true,
      hayPlan: f.hay_plan,
    };
    out.set(claveCliente(String(f.restaurante_id), String(f.cliente_id)), planDesdeFilas(filas));
  }
  return out;
}
