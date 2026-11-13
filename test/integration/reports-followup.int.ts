import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';
import { addDays, clientWithPlan, localToday, moveSubscription, planTemplate } from './reports-kit';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: reportes · clientes a quienes escribirles', () => {
  const k = new DinerKit(probe!, 96);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  async function setup() {
    const o = await k.activeOwner();
    const semanal = await planTemplate(k, o, 'Semanal', 5, 1500);
    const uno = await planTemplate(k, o, 'Un almuerzo', 1, 350);
    const hoy = await localToday(k, o);
    const name = async (c: { clienteId: string }, nombre: string) => {
      await k.as(o).patch(`/v1/clientes/${c.clienteId}`, { nombre });
      return c.clienteId;
    };
    const ago = (days: number) => `comprada_en = comprada_en - interval '${days} days'`;
    const ids: Record<string, string> = {};

    const A = await clientWithPlan(k, o, semanal); // vence en 2 días, compró hoy
    await moveSubscription(k, A.planVendidoId, `vence_el = DATE '${addDays(hoy, 2)}'`);
    ids.A = await name(A, 'Ana por vencer');
    const B = await clientWithPlan(k, o, semanal); // plan vigente, compró hace 10 días y nunca vino
    await moveSubscription(k, B.planVendidoId, `${ago(10)}, vence_el = DATE '${addDays(hoy, 20)}'`);
    ids.B = await name(B, 'Beto sin venir');
    const C = await clientWithPlan(k, o, semanal); // las dos cosas, y alguna vez vino
    await moveSubscription(k, C.planVendidoId, `${ago(10)}, vence_el = DATE '${addDays(hoy, 1)}'`);
    ids.C = await name(C, 'Carla las dos');
    const D = await clientWithPlan(k, o, uno); // se le acabó el plan hoy
    await k.lunch(o, D.clienteId);
    ids.D = await name(D, 'Dani agotó');
    const E = await clientWithPlan(k, o, semanal); // plan vencido hace 5 días
    await moveSubscription(k, E.planVendidoId, `${ago(12)}, vence_el = DATE '${addDays(hoy, -5)}', estado = 'VENCIDA'`);
    ids.E = await name(E, 'Eli vencida');
    const F = await clientWithPlan(k, o, semanal); // vencido hace 60 días: ya no es "reciente"
    await moveSubscription(k, F.planVendidoId, `${ago(70)}, vence_el = DATE '${addDays(hoy, -60)}', estado = 'VENCIDA'`);
    ids.F = await name(F, 'Fer muy antigua');
    const G = (await k.as(o).post('/v1/clientes', { nombre: 'Gus sin planes' })).json().id; // nunca compró
    const H = await clientWithPlan(k, o, semanal); // vigente y compró hoy: nada que hacer
    await name(H, 'Hugo al día');
    const I = await clientWithPlan(k, o, semanal); // plan anulado
    await k.as(o).post(`/v1/planes-vendidos/${I.planVendidoId}/deshacer`, {}, randomUUID());
    await name(I, 'Ines anulado');
    // Carla sí vino una vez, hace 8 días (servido y no devuelto).
    const lc = await k.lunch(o, C.clienteId);
    await probe!.sql('SET LOCAL session_replication_role = replica'); // libro de solo inserción: solo para preparar el dato
    await probe!.sql(
      `UPDATE consumo_almuerzo SET creado_en = creado_en - interval '8 days', fecha_local = fecha_local - 8 WHERE public_id = $1`,
      [lc],
    );
    await probe!.sql('SET LOCAL session_replication_role = origin');
    return { o, hoy, ids, G };
  }

  it('cada cliente aparece con sus motivos, ordenado por urgencia; el resto no aparece', async () => {
    const { o, hoy, ids } = await setup();
    const r = await k.as(o).get('/v1/reportes/clientes-a-contactar');
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ fecha: hoy, zonaHoraria: 'America/Guayaquil', total: 5 });
    expect(j.items.map((i: { nombre: string }) => i.nombre)).toEqual([
      'Carla las dos', // vence mañana
      'Ana por vencer', // vence en 2 días
      'Beto sin venir',
      'Dani agotó', // para renovar: su actividad es de hoy
      'Eli vencida',
    ]);
    const by = Object.fromEntries(j.items.map((i: { clienteId: string }) => [i.clienteId, i]));
    expect(by[ids.C]).toMatchObject({
      motivos: ['POR_VENCER', 'SIN_VENIR'],
      almuerzosRestantes: 4,
      venceEl: addDays(hoy, 1),
      ultimaVisita: addDays(hoy, -8),
      diasSinActividad: 8,
    });
    expect(by[ids.A]).toMatchObject({
      motivos: ['POR_VENCER'],
      almuerzosRestantes: 5,
      venceEl: addDays(hoy, 2),
      ultimaVisita: null,
      diasSinActividad: 0,
    });
    expect(by[ids.B]).toMatchObject({
      motivos: ['SIN_VENIR'],
      almuerzosRestantes: 5,
      venceEl: addDays(hoy, 20),
      ultimaVisita: null,
      diasSinActividad: 10,
    });
    expect(by[ids.D]).toMatchObject({
      motivos: ['PARA_RENOVAR'],
      almuerzosRestantes: 0,
      venceEl: null,
      ultimaVisita: hoy,
      diasSinActividad: 0,
    });
    expect(by[ids.E]).toMatchObject({ motivos: ['PARA_RENOVAR'], almuerzosRestantes: 0, diasSinActividad: 12 });
    expect(j.items.every((i: { clienteId: string; nombre: string }) => typeof i.clienteId === 'string' && i.nombre)).toBe(true);
    expect(Object.keys(j.items[0]).sort()).toEqual([
      'almuerzosRestantes',
      'clienteId',
      'diasSinActividad',
      'motivos',
      'nombre',
      'telefono',
      'ultimaVisita',
      'venceEl',
    ]);
  });

  it('los umbrales se ajustan por query y limit recorta sin cambiar el total', async () => {
    const { o, ids } = await setup();
    const get = async (qs: string) => (await k.as(o).get(`/v1/reportes/clientes-a-contactar?${qs}`)).json();
    // Con 1 día solo vence "mañana" (Carla); 15 días de "sin venir" deja fuera a Beto y a Carla por inactividad.
    const a = await get('diasVencer=1&diasSinVenir=15&diasRenovar=1');
    expect(a.items.map((i: { clienteId: string }) => i.clienteId).sort()).toEqual([ids.C, ids.D].sort());
    expect(a.items.find((i: { clienteId: string }) => i.clienteId === ids.C).motivos).toEqual(['POR_VENCER']);
    // 90 días de "renovar" suma a la clienta de hace 60 días.
    const b = await get('diasRenovar=90');
    expect(b.total).toBe(6);
    expect(b.items.map((i: { nombre: string }) => i.nombre)).toContain('Fer muy antigua');
    const c = await get('limit=2');
    expect(c.total).toBe(5);
    expect(c.items.map((i: { nombre: string }) => i.nombre)).toEqual(['Carla las dos', 'Ana por vencer']);
    for (const bad of [
      'limit=0',
      'limit=101',
      'diasVencer=0',
      'diasVencer=31',
      'diasSinVenir=2',
      'diasRenovar=91',
      'limit=abc',
      'otro=1',
    ]) {
      expect((await k.as(o).get(`/v1/reportes/clientes-a-contactar?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('un almuerzo devuelto no cuenta como visita; un cliente desactivado no aparece', async () => {
    const o = await k.activeOwner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    const c = await clientWithPlan(k, o, plan);
    const hoy = await localToday(k, o);
    await moveSubscription(k, c.planVendidoId, `comprada_en = comprada_en - interval '10 days', vence_el = DATE '${addDays(hoy, 20)}'`);
    const id = await k.lunch(o, c.clienteId);
    expect((await k.as(o).get('/v1/reportes/clientes-a-contactar')).json().total).toBe(0); // vino hoy
    expect((await k.as(o).post(`/v1/caja/consumos/${id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);
    const r = (await k.as(o).get('/v1/reportes/clientes-a-contactar')).json();
    expect(r.items).toMatchObject([{ motivos: ['SIN_VENIR'], ultimaVisita: null, diasSinActividad: 10 }]);
    await probe!.sql(`UPDATE cliente_restaurante SET activo = false WHERE cliente_id = $1`, [c.clienteId]);
    expect((await k.as(o).get('/v1/reportes/clientes-a-contactar')).json().total).toBe(0);
  });

  it('solo el dueño y solo los clientes de su local', async () => {
    const o = await k.activeOwner();
    const otro = await k.activeOwner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    const c = await clientWithPlan(k, o, plan);
    const hoy = await localToday(k, o);
    await moveSubscription(k, c.planVendidoId, `vence_el = DATE '${addDays(hoy, 1)}'`);
    expect((await k.as(o).get('/v1/reportes/clientes-a-contactar')).json().total).toBe(1);
    expect((await k.as(otro).get('/v1/reportes/clientes-a-contactar')).json()).toMatchObject({ total: 0, items: [] });
    expect((await k.as(cajero).get('/v1/reportes/clientes-a-contactar')).statusCode).toBe(403);
    expect((await k.as({ token: d.token, restaurante: o.restaurante }).get('/v1/reportes/clientes-a-contactar')).statusCode).toBe(403);
    expect((await k.as({}).get('/v1/reportes/clientes-a-contactar')).statusCode).toBe(401);
  });
});
