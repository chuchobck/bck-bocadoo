import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';
import { addDays, clientWithPlan, localToday, moveSubscription, planTemplate, setLocalTime } from './reports-kit';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: reportes · horas pico, ranking de platos y almuerzos pendientes', () => {
  const k = new DinerKit(probe!, 95);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  it('horas pico: por hora local de 0 a 23; los almuerzos devueltos y los tickets deshechos no cuentan', async () => {
    const o = await k.activeOwner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    const hoy = await localToday(k, o);
    const lunch = async (hhmm: string) => {
      const c = await clientWithPlan(k, o, plan);
      const id = await k.lunch(o, c.clienteId);
      await setLocalTime(k, 'consumo_almuerzo', id, hhmm);
      return id;
    };
    for (const t of ['12:05', '12:30', '12:55', '13:10', '13:40', '18:00', '23:30']) await lunch(t);
    const devuelto = await lunch('12:20');
    expect((await k.as(o).post(`/v1/caja/consumos/${devuelto}/deshacer`, {}, randomUUID())).statusCode).toBe(200);

    const venta = async (hhmm: string) => {
      const r = await k.as(o).post('/v1/caja/ventas', { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], metodoPago: 'EFECTIVO' }, randomUUID());
      await setLocalTime(k, 'venta_pos_cabecera', r.json().id, hhmm);
      return r.json().id as string;
    };
    await venta('12:15');
    await venta('12:45');
    await venta('20:15');
    const deshecha = await venta('12:40');
    expect((await k.as(o).post(`/v1/caja/ventas/${deshecha}/deshacer`, {}, randomUUID())).statusCode).toBe(200);

    const r = (await k.as(o).get(`/v1/reportes/horas-pico?desde=${hoy}&hasta=${hoy}`)).json();
    expect(r.porHora).toHaveLength(24);
    expect(r.porHora.map((h: { hora: number }) => h.hora)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    const con = r.porHora.filter((h: { total: number }) => h.total > 0);
    expect(con).toEqual([
      { hora: 12, almuerzos: 3, ventas: 2, total: 5 },
      { hora: 13, almuerzos: 2, ventas: 0, total: 2 },
      { hora: 18, almuerzos: 1, ventas: 0, total: 1 },
      { hora: 20, almuerzos: 0, ventas: 1, total: 1 },
      { hora: 23, almuerzos: 1, ventas: 0, total: 1 },
    ]);
    expect(r).toMatchObject({ horaPico: 12, totalAlmuerzos: 7, totalVentas: 3, zonaHoraria: 'America/Guayaquil' });
    // La suma por hora es igual a los almuerzos netos del resumen del día.
    const dia = (await k.as(o).get(`/v1/reportes/resumen-diario?fecha=${hoy}`)).json();
    expect(r.totalAlmuerzos).toBe(dia.almuerzos.servidos);
    // Otro día: sin movimiento, sin hora pico.
    const vacio = (await k.as(o).get(`/v1/reportes/horas-pico?desde=${addDays(hoy, -5)}&hasta=${addDays(hoy, -1)}`)).json();
    expect(vacio.horaPico).toBeNull();
    expect(vacio.porHora.every((h: { total: number }) => h.total === 0)).toBe(true);
  });

  it('ranking de platos: ventas sueltas netas + pedidos canjeados, con desempate por nombre y límite', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const venta = (items: object[]) => k.as(o).post('/v1/caja/ventas', { items, metodoPago: 'EFECTIVO' }, randomUUID());
    expect((await venta([{ tipo: 'PLATO', platoId: await platoNumeric(m['Huevo frito']), cantidad: 3 }])).statusCode).toBe(201);
    expect((await venta([{ tipo: 'PLATO', platoId: await platoNumeric(m.Cola), cantidad: 2 }])).statusCode).toBe(201);
    const x = await venta([{ tipo: 'PLATO', platoId: await platoNumeric(m['Huevo frito']), cantidad: 1 }]);
    expect((await k.as(o).post(`/v1/caja/ventas/${x.json().id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);

    const d = await k.dinerWithPlan(o);
    const pedido = (
      await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: o.restaurante,
          almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo'], m['Jugo de mora']] },
          extras: [{ plato: m['Huevo frito'], cantidad: 2 }],
        },
        randomUUID(),
      )
    ).json();
    expect((await k.as(o).post(`/v1/caja/pedidos/${pedido.id}/canjear`, {}, randomUUID())).statusCode).toBe(200);
    // Un pedido que no se canjeó no cuenta.
    const e = await k.dinerWithPlan(o);
    const sinCanjear = await k
      .as(e)
      .post('/v1/mis/pedidos', { restaurante: o.restaurante, almuerzo: { platos: [m['Menestra con carne']] } }, randomUUID());
    expect(sinCanjear.statusCode, sinCanjear.body).toBe(201);

    const r = (await k.as(o).get('/v1/reportes/ranking-platos')).json();
    expect(r.items).toEqual([
      {
        posicion: 1,
        plato: { id: m['Huevo frito'], nombre: 'Huevo frito' },
        unidades: 5,
        unidadesVentas: 3,
        unidadesPedidos: 2,
        ingresoCentavos: 375,
      },
      { posicion: 2, plato: { id: m.Cola, nombre: 'Cola' }, unidades: 2, unidadesVentas: 2, unidadesPedidos: 0, ingresoCentavos: 200 },
      {
        posicion: 3,
        plato: { id: m['Jugo de mora'], nombre: 'Jugo de mora' },
        unidades: 1,
        unidadesVentas: 0,
        unidadesPedidos: 1,
        ingresoCentavos: 0,
      },
      {
        posicion: 4,
        plato: { id: m['Seco de pollo'], nombre: 'Seco de pollo' },
        unidades: 1,
        unidadesVentas: 0,
        unidadesPedidos: 1,
        ingresoCentavos: 0,
      },
      {
        posicion: 5,
        plato: { id: m['Sopa de quinua'], nombre: 'Sopa de quinua' },
        unidades: 1,
        unidadesVentas: 0,
        unidadesPedidos: 1,
        ingresoCentavos: 0,
      },
    ]);
    expect(
      (await k.as(o).get('/v1/reportes/ranking-platos?limit=2')).json().items.map((i: { plato: { nombre: string } }) => i.plato.nombre),
    ).toEqual(['Huevo frito', 'Cola']);
    const hoy = await localToday(k, o);
    expect((await k.as(o).get(`/v1/reportes/ranking-platos?desde=${addDays(hoy, -9)}&hasta=${addDays(hoy, -1)}`)).json().items).toEqual([]);
    for (const l of ['0', '51', 'x']) expect((await k.as(o).get(`/v1/reportes/ranking-platos?limit=${l}`)).statusCode, l).toBe(400);
  });

  /** id numérico del plato dentro del tenant (lo pide el POS) a partir del public_id. */
  async function platoNumeric(publicId: string) {
    return String(
      (await probe!.sql<{ plato_id: string }>('SELECT plato_id FROM plato WHERE public_id = $1', [publicId])).rows[0]!.plato_id,
    );
  }

  it('almuerzos pendientes: solo planes activos y vigentes, con su valor y por cercanía al vencimiento', async () => {
    const o = await k.activeOwner();
    const semanal = await planTemplate(k, o, 'Semanal', 5, 1500);
    const mensual = await planTemplate(k, o, 'Mensual', 20, 2500);
    const hoy = await localToday(k, o);
    const c1 = await clientWithPlan(k, o, semanal);
    const c2 = await clientWithPlan(k, o, semanal);
    const c3 = await clientWithPlan(k, o, mensual);
    const c4 = await clientWithPlan(k, o, mensual);
    const c5 = await clientWithPlan(k, o, semanal);
    const c6 = await clientWithPlan(k, o, semanal);
    await moveSubscription(k, c1.planVendidoId, `vence_el = DATE '${hoy}'`);
    await moveSubscription(k, c2.planVendidoId, `vence_el = DATE '${addDays(hoy, 3)}'`);
    await moveSubscription(k, c3.planVendidoId, `vence_el = DATE '${addDays(hoy, 5)}'`);
    await moveSubscription(k, c4.planVendidoId, `vence_el = DATE '${addDays(hoy, 30)}'`);
    await moveSubscription(k, c5.planVendidoId, `vence_el = DATE '${addDays(hoy, -1)}'`); // ACTIVA pero ya vencido: no es deuda
    await k.as(o).post(`/v1/planes-vendidos/${c6.planVendidoId}/deshacer`, {}, randomUUID()); // anulado
    await k.lunch(o, c1.clienteId); // c1 queda con 4
    const unit = async (n: string) =>
      Number(
        (
          await probe!.sql<{ u: string }>(
            `SELECT precio_unitario_centavos AS u FROM suscripcion_plan WHERE nombre_plan = $1 AND restaurante_id = (SELECT restaurante_id FROM restaurante WHERE public_id = $2) LIMIT 1`,
            [n, o.restaurante],
          )
        ).rows[0]!.u,
      );
    const us = await unit('Semanal');
    const um = await unit('Mensual');
    expect([us, um]).toEqual([300, 125]);

    const r = (await k.as(o).get('/v1/reportes/almuerzos-pendientes')).json();
    expect(r).toMatchObject({ fecha: hoy, zonaHoraria: 'America/Guayaquil', moneda: 'USD' });
    expect(r.total).toEqual({ clientes: 4, planes: 4, almuerzos: 49, pasivoCentavos: 4 * us + 5 * us + 40 * um });
    expect(r.porPlan).toEqual([
      { nombre: 'Mensual', planes: 2, almuerzos: 40, pasivoCentavos: 40 * um },
      { nombre: 'Semanal', planes: 2, almuerzos: 9, pasivoCentavos: 9 * us },
    ]);
    expect(r.porVencimiento).toEqual([
      { rango: 'HOY', planes: 1, almuerzos: 4, pasivoCentavos: 4 * us },
      { rango: 'EN_1_A_3_DIAS', planes: 1, almuerzos: 5, pasivoCentavos: 5 * us },
      { rango: 'EN_4_A_7_DIAS', planes: 1, almuerzos: 20, pasivoCentavos: 20 * um },
      { rango: 'EN_MAS_DE_7_DIAS', planes: 1, almuerzos: 20, pasivoCentavos: 20 * um },
    ]);
    // Un local sin planes: todo en cero y los 4 bloques presentes.
    const vacio = (await k.as(await k.activeOwner()).get('/v1/reportes/almuerzos-pendientes')).json();
    expect(vacio.total).toEqual({ clientes: 0, planes: 0, almuerzos: 0, pasivoCentavos: 0 });
    expect(vacio.porVencimiento.map((b: { rango: string }) => b.rango)).toEqual([
      'HOY',
      'EN_1_A_3_DIAS',
      'EN_4_A_7_DIAS',
      'EN_MAS_DE_7_DIAS',
    ]);
  });

  it('solo el dueño; el cajero, un comensal y un anónimo no entran', async () => {
    const o = await k.activeOwner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    for (const url of ['/v1/reportes/horas-pico', '/v1/reportes/ranking-platos', '/v1/reportes/almuerzos-pendientes']) {
      expect((await k.as(o).get(url)).statusCode, url).toBe(200);
      expect((await k.as(cajero).get(url)).statusCode, url).toBe(403);
      expect((await k.as({ token: d.token, restaurante: o.restaurante }).get(url)).statusCode).toBe(403);
      expect((await k.as({}).get(url)).statusCode).toBe(401);
    }
    expect((await k.as(o).get('/v1/reportes/horas-pico?desde=2026-10-10&hasta=2026-10-01')).json().code).toBe('RANGO_INVALIDO');
  });
});
