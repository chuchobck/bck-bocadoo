import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Actor } from './harness';
import { unique } from './harness';
import { ALL_DAYS, DinerKit } from './diner-kit';

/** Fecha local de hoy del restaurante (la que usan los reportes), leída con SQL directo. */
export async function localToday(k: DinerKit, o: Actor): Promise<string> {
  const r = await k.probe.sql<{ d: string }>(
    `SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date::text AS d FROM restaurante WHERE public_id = $1`,
    [o.restaurante],
  );
  return r.rows[0]!.d;
}

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Cliente (sin cuenta) del local con un plan vendido; devuelve los ids para validar o deshacer. */
export async function clientWithPlan(
  k: DinerKit,
  o: Actor,
  planId: string,
  metodoPago: 'EFECTIVO' | 'TRANSFERENCIA' | 'DEUNA' = 'EFECTIVO',
  pagoConfirmado?: boolean,
) {
  const c = (await k.as(o).post('/v1/clientes', { nombre: `Cliente ${unique()}` })).json().id as string;
  const sale = await k
    .as(o)
    .post(`/v1/clientes/${c}/planes`, { planId, metodoPago, ...(pagoConfirmado !== undefined && { pagoConfirmado }) }, randomUUID());
  expect(sale.statusCode, sale.body).toBe(201);
  return { clienteId: c, planVendidoId: sale.json().id as string };
}

/** Crea una plantilla de plan con los días válidos de siempre. */
export async function planTemplate(k: DinerKit, o: Actor, nombre: string, almuerzos: number, precioCentavos: number) {
  const r = await k
    .as(o)
    .post('/v1/planes', { tipo: 'SEMANAL', nombre, almuerzos, precioCentavos, vigenciaDias: 7, diasValidos: ALL_DAYS });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/** Mueve la fecha de compra de un plan (libro de solo inserción en pagos; la suscripción sí se puede tocar con el superusuario del probe). */
export async function moveSubscription(k: DinerKit, planVendidoId: string, sql: string) {
  await k.probe.sql(`UPDATE suscripcion_plan SET ${sql} WHERE public_id = $1`, [planVendidoId]);
}

/** Pone la hora de creación de un consumo o de una venta a una hora LOCAL de hoy (libros de solo inserción: solo con el superusuario del probe). */
export async function setLocalTime(k: DinerKit, table: 'consumo_almuerzo' | 'venta_pos_cabecera', publicId: string, hhmm: string) {
  await k.probe.sql('SET LOCAL session_replication_role = replica');
  await k.probe.sql(
    `UPDATE ${table} t SET creado_en = ((t.fecha_local + $2::time) AT TIME ZONE r.zona_horaria)
       FROM restaurante r WHERE r.restaurante_id = t.restaurante_id AND t.public_id = $1`,
    [publicId, hhmm],
  );
  await k.probe.sql('SET LOCAL session_replication_role = origin');
}
