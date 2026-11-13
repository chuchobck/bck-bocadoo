import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';
import { createPartitions, expirePlans } from '../../src/jobs/jobs';
import { clientWithPlan, moveSubscription, planTemplate } from './reports-kit';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: jobs de mantenimiento (planes vencidos y particiones)', () => {
  const k = new DinerKit(probe!, 100);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const estado = async (planPublicId: string) =>
    (await probe!.sql<{ estado: string }>('SELECT estado FROM suscripcion_plan WHERE public_id = $1', [planPublicId])).rows[0]!.estado;
  const localToday = async (tz: string) =>
    (await probe!.sql<{ d: string }>(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0]!.d;

  it('expire-plans: vence solo los ACTIVA cuyo último día ya pasó; no toca agotados ni anulados; una segunda corrida no cambia nada', async () => {
    const o = await k.activeOwner();
    const semanal = await planTemplate(k, o, 'Semanal', 5, 1500);
    const uno = await planTemplate(k, o, 'Un almuerzo', 1, 350);
    const hoy = await localToday('America/Guayaquil');
    const ayer = (await probe!.sql<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [hoy])).rows[0]!.d;
    const vencido = await clientWithPlan(k, o, semanal);
    const hoyUltimo = await clientWithPlan(k, o, semanal);
    const agotado = await clientWithPlan(k, o, uno);
    const anulado = await clientWithPlan(k, o, semanal);
    await moveSubscription(k, vencido.planVendidoId, `vence_el = DATE '${ayer}'`);
    await moveSubscription(k, hoyUltimo.planVendidoId, `vence_el = DATE '${hoy}'`);
    await k.lunch(o, agotado.clienteId);
    await moveSubscription(k, agotado.planVendidoId, `vence_el = DATE '${ayer}'`);
    await k.as(o).post(`/v1/planes-vendidos/${anulado.planVendidoId}/deshacer`, {}, randomUUID());
    await moveSubscription(k, anulado.planVendidoId, `vence_el = DATE '${ayer}'`);
    expect(await estado(agotado.planVendidoId)).toBe('AGOTADA');

    const first = await k.h.db.service((q) => expirePlans(q));
    expect(first).toMatchObject({ job: 'expire-plans', ok: true });
    expect(first.vencidos).toBeGreaterThanOrEqual(1);
    expect(await estado(vencido.planVendidoId)).toBe('VENCIDA');
    expect(await estado(hoyUltimo.planVendidoId)).toBe('ACTIVA'); // hoy todavía vale
    expect(await estado(agotado.planVendidoId)).toBe('AGOTADA');
    expect(await estado(anulado.planVendidoId)).toBe('ANULADA');

    const snapshot = async () =>
      (await probe!.sql('SELECT suscripcion_id, estado, almuerzos_restantes, actualizado_en FROM suscripcion_plan ORDER BY suscripcion_id'))
        .rows;
    const antes = await snapshot();
    const second = await k.h.db.service((q) => expirePlans(q));
    expect(second).toEqual({ job: 'expire-plans', ok: true, vencidos: 0 });
    expect(await snapshot()).toEqual(antes);
    // Un plan vencido ya no se puede consumir.
    expect((await k.as(o).post('/v1/caja/validar', { clienteId: vencido.clienteId }, randomUUID())).json().resultado).toBe('VENCIDO');
  });

  it('expire-plans usa el día local de cada restaurante: el mismo último día vence en un local y sigue vigente en otro', async () => {
    const adelante = await k.activeOwner(); // UTC+14
    const atras = await k.activeOwner(); // UTC-11
    await probe!.sql(`UPDATE restaurante SET zona_horaria = 'Pacific/Kiritimati' WHERE public_id = $1`, [adelante.restaurante]);
    await probe!.sql(`UPDATE restaurante SET zona_horaria = 'Pacific/Pago_Pago' WHERE public_id = $1`, [atras.restaurante]);
    const a = await clientWithPlan(k, adelante, await planTemplate(k, adelante, 'Semanal', 5, 1500));
    const b = await clientWithPlan(k, atras, await planTemplate(k, atras, 'Semanal', 5, 1500));
    // Hoy de Pago Pago: en Kiritimati (25 h por delante) ya es un día o dos después.
    const ultimo = await localToday('Pacific/Pago_Pago');
    expect(await localToday('Pacific/Kiritimati')).not.toBe(ultimo);
    await moveSubscription(k, a.planVendidoId, `vence_el = DATE '${ultimo}'`);
    await moveSubscription(k, b.planVendidoId, `vence_el = DATE '${ultimo}'`);
    await k.h.db.service((q) => expirePlans(q));
    expect(await estado(a.planVendidoId)).toBe('VENCIDA');
    expect(await estado(b.planVendidoId)).toBe('ACTIVA');
  });

  const partitions = async () =>
    (
      await probe!.sql<{ child: string }>(
        `SELECT inhrelid::regclass::text AS child FROM pg_inherits WHERE inhparent IN ('evento_analitica'::regclass, 'log_actividad'::regclass) ORDER BY 1`,
      )
    ).rows.map((r) => r.child);
  const monthSuffix = async (offset: number) =>
    (
      await probe!.sql<{ s: string }>(
        `SELECT to_char(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + make_interval(months => $1), 'YYYY_MM') AS s`,
        [offset],
      )
    ).rows[0]!.s;

  it('create-partitions: crea los meses que faltan en las dos tablas y una segunda corrida no crea nada', async () => {
    const antes = await partitions();
    const nuevoMes = await monthSuffix(10);
    expect(antes).not.toContain(`evento_analitica_${nuevoMes}`);

    const r1 = await k.h.db.service((q) => createPartitions(q, 12));
    expect(r1.ok).toBe(true);
    expect(r1.errores).toEqual([]);
    expect(r1.creadas).toEqual(expect.arrayContaining([`evento_analitica_${nuevoMes}`, `log_actividad_${nuevoMes}`]));
    expect(r1.creadas.length + r1.existentes.length).toBe(2 * 13);
    const despues = await partitions();
    expect(despues.length).toBe(antes.length + r1.creadas.length);
    expect(new Set(despues).size).toBe(despues.length);

    const r2 = await k.h.db.service((q) => createPartitions(q, 12));
    expect(r2).toMatchObject({ ok: true, creadas: [], errores: [] });
    expect(r2.existentes).toHaveLength(2 * 13);
    expect(await partitions()).toEqual(despues);
  });

  it('create-partitions: los límites son meses UTC (un evento del primer y del último instante cae en su partición)', async () => {
    await k.h.db.service((q) => createPartitions(q, 6));
    const m = await monthSuffix(5);
    const [y, mm] = m.split('_').map(Number) as [number, number];
    const first = `${y}-${String(mm).padStart(2, '0')}-01T00:00:00Z`;
    const last = new Date(Date.UTC(y, mm, 1) - 1000).toISOString();
    const next = new Date(Date.UTC(y, mm, 1)).toISOString();
    const where = async (ts: string) =>
      (
        await probe!.sql<{ t: string }>(
          `INSERT INTO evento_analitica (tipo, ocurrido_en) VALUES ('prueba.particion', $1) RETURNING tableoid::regclass::text AS t`,
          [ts],
        )
      ).rows[0]!.t;
    expect(await where(first)).toBe(`evento_analitica_${m}`);
    expect(await where(last)).toBe(`evento_analitica_${m}`);
    expect(await where(next)).not.toBe(`evento_analitica_${m}`);
    // Con la zona de la sesión en otra parte del mundo el resultado es el mismo (el job fija UTC).
    await probe!.sql(`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
    const r = await k.h.db.service((q) => createPartitions(q, 8));
    expect(r.ok).toBe(true);
    const mes8 = await monthSuffix(8);
    const b = await probe!.sql<{ b: string }>(`SELECT pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_class c WHERE c.relname = $1`, [
      `evento_analitica_${mes8}`,
    ]);
    expect(b.rows[0]!.b).toMatch(/FROM \('\d{4}-\d{2}-01 00:00:00\+00'\)/);
  });

  it('create-partitions: si el mes ya tiene filas en la partición DEFAULT lo informa, sigue con los demás y marca ok=false', async () => {
    const mes = await monthSuffix(8);
    const [y, m] = mes.split('_').map(Number) as [number, number];
    await probe!.sql(`INSERT INTO evento_analitica (tipo, ocurrido_en) VALUES ('prueba.default', $1)`, [
      new Date(Date.UTC(y, m - 1, 15)).toISOString(),
    ]);
    const r = await k.h.db.service((q) => createPartitions(q, 9));
    expect(r.ok).toBe(false);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatchObject({ particion: `evento_analitica_${mes}` });
    expect(r.errores[0]!.error).toMatch(/default partition|partición/i);
    expect(r.creadas).toEqual(expect.arrayContaining([`log_actividad_${mes}`, `evento_analitica_${await monthSuffix(9)}`]));
    expect(r.creadas).not.toContain(`evento_analitica_${mes}`);
    expect(await partitions()).not.toContain(`evento_analitica_${mes}`);
    const fila = await probe!.sql(`SELECT 1 FROM evento_analitica WHERE tipo = 'prueba.default'`);
    expect(fila.rowCount).toBe(1); // el evento sigue ahí
  });

  it('rechaza un horizonte fuera de rango', async () => {
    await expect(k.h.db.service((q) => createPartitions(q, 13))).rejects.toThrow(RangeError);
    await expect(k.h.db.service((q) => createPartitions(q, -1))).rejects.toThrow(RangeError);
  });
});
