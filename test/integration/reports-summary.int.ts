import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';
import { addDays, clientWithPlan, localToday, moveSubscription, planTemplate } from './reports-kit';
import { offer } from './offers-kit';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: reportes · resumen diario y ventas de planes', () => {
  const k = new DinerKit(probe!, 94);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  /** Un día con de todo: planes (uno pendiente y uno deshecho), almuerzos (uno deshecho), ventas sueltas y ofertas. */
  async function busyDay() {
    const o = await k.activeOwner();
    const semanal = await planTemplate(k, o, 'Semanal', 5, 1500);
    const mensual = await planTemplate(k, o, 'Mensual', 20, 2500);
    const a = await clientWithPlan(k, o, semanal);
    const b = await clientWithPlan(k, o, semanal);
    await clientWithPlan(k, o, semanal, 'TRANSFERENCIA'); // pago pendiente
    const e = await clientWithPlan(k, o, mensual, 'DEUNA', true);
    const d = await clientWithPlan(k, o, semanal);
    const undo = await k.as(o).post(`/v1/planes-vendidos/${d.planVendidoId}/deshacer`, {}, randomUUID());
    expect(undo.statusCode, undo.body).toBe(200);

    const val = (clienteId: string, extra: object = {}) => k.as(o).post('/v1/caja/validar', { clienteId, ...extra }, randomUUID());
    expect((await val(a.clienteId, { paraLlevar: true })).json().descontado).toBe(true);
    const lb = await val(b.clienteId);
    expect(lb.json().descontado).toBe(true);
    expect((await val(e.clienteId)).json().descontado).toBe(true);
    expect((await val(a.clienteId)).json().resultado).toBe('DUPLICADO');
    expect((await k.as(o).post(`/v1/caja/consumos/${lb.json().consumo.id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);

    const venta = (items: object[]) => k.as(o).post('/v1/caja/ventas', { items, metodoPago: 'EFECTIVO' }, randomUUID());
    expect((await venta([{ tipo: 'ALMUERZO', cantidad: 2 }])).statusCode).toBe(201);
    const v2 = await venta([{ tipo: 'ALMUERZO', cantidad: 1 }]);
    expect((await k.as(o).post(`/v1/caja/ventas/${v2.json().id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);

    const of = (await k.as(o).post('/v1/ofertas', offer({ stock: 5 }), randomUUID())).json().id;
    expect((await k.as(o).post(`/v1/ofertas/${of}/canjear`, { cantidad: 2, metodoPago: 'DEUNA' }, randomUUID())).statusCode).toBe(201);
    return { o, a, b, d };
  }

  it('resumen del día: cada cifra cuadra con lo que se hizo (reversos restan, pendientes aparte)', async () => {
    const { o } = await busyDay();
    const hoy = await localToday(k, o);
    const r = await k.as(o).get('/v1/reportes/resumen-diario');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      fecha: hoy,
      zonaHoraria: 'America/Guayaquil',
      moneda: 'USD',
      almuerzos: { servidos: 2, paraLlevar: 1, porCanal: { QR: 0, MANUAL: 2, PREORDEN: 0, MESA: 0 } },
      ingresos: {
        totalCentavos: 7100,
        porOrigen: { planes: 5500, ventas: 700, ofertas: 900, pedidos: 0 },
        porMetodo: [
          { metodo: 'DEUNA', centavos: 3400 },
          { metodo: 'EFECTIVO', centavos: 3700 },
        ],
        pendientesPorConfirmar: { cantidad: 1, centavos: 1500 },
      },
      ventasPos: { tickets: 2, reversos: 1, totalCentavos: 700, almuerzos: 2 },
      planesVendidos: { cantidad: 4, centavos: 6500 + 500 },
      ofertas: { unidades: 2, centavos: 900 },
      escaneos: { total: 4, validos: 3, rechazados: 1 },
    });
    // Lo mismo pidiendo la fecha explícita; otro día no tiene movimiento.
    expect((await k.as(o).get(`/v1/reportes/resumen-diario?fecha=${hoy}`)).json()).toEqual(r.json());
    const vacio = (await k.as(o).get(`/v1/reportes/resumen-diario?fecha=${addDays(hoy, -3)}`)).json();
    expect(vacio.almuerzos.servidos).toBe(0);
    expect(vacio.ingresos).toMatchObject({ totalCentavos: 0, porMetodo: [] });
    expect(vacio.planesVendidos).toEqual({ cantidad: 0, centavos: 0 });
  });

  it('el efectivo del resumen coincide con el efectivo esperado del cierre de caja', async () => {
    const { o } = await busyDay();
    const hoy = await localToday(k, o);
    const resumen = (await k.as(o).get('/v1/reportes/resumen-diario')).json();
    const cierre = (await k.as(o).get(`/v1/caja/cierre/${hoy}`)).json();
    const efectivo = resumen.ingresos.porMetodo.find((m: { metodo: string }) => m.metodo === 'EFECTIVO').centavos;
    expect(efectivo).toBe(cierre.efectivoEsperadoCentavos);
  });

  it('usa la zona horaria del restaurante: una compra a las 23:30 locales cuenta en su día local, no en el de UTC', async () => {
    const o = await k.activeOwner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    const c = await clientWithPlan(k, o, plan);
    const hoy = await localToday(k, o);
    // 23:30 de hoy en Guayaquil (UTC-5) = 04:30 UTC del día siguiente.
    await moveSubscription(k, c.planVendidoId, `comprada_en = (DATE '${hoy}' + TIME '23:30') AT TIME ZONE 'America/Guayaquil'`);
    const utc = (
      await probe!.sql<{ d: string }>(
        `SELECT ((DATE '${hoy}' + TIME '23:30') AT TIME ZONE 'America/Guayaquil' AT TIME ZONE 'UTC')::date::text AS d`,
      )
    ).rows[0]!.d;
    expect(utc).toBe(addDays(hoy, 1));
    expect((await k.as(o).get(`/v1/reportes/resumen-diario?fecha=${hoy}`)).json().planesVendidos).toEqual({ cantidad: 1, centavos: 1500 });
    expect((await k.as(o).get(`/v1/reportes/resumen-diario?fecha=${utc}`)).json().planesVendidos).toEqual({ cantidad: 0, centavos: 0 });
    // Y si el local cambia de zona, el mismo instante cae en otro día (Pacific/Auckland va ~18 h por delante).
    await probe!.sql(`UPDATE restaurante SET zona_horaria = 'Pacific/Auckland' WHERE public_id = $1`, [o.restaurante]);
    const r = (await k.as(o).get(`/v1/reportes/ventas-planes?desde=${addDays(hoy, -2)}&hasta=${addDays(hoy, 3)}`)).json();
    expect(r.zonaHoraria).toBe('Pacific/Auckland');
    const dia = await probe!.sql<{ d: string }>(
      `SELECT (comprada_en AT TIME ZONE 'Pacific/Auckland')::date::text AS d FROM suscripcion_plan WHERE public_id = $1`,
      [c.planVendidoId],
    );
    expect(r.porDia).toEqual([{ fecha: dia.rows[0]!.d, vendidos: 1, ingresoCentavos: 1500 }]);
  });

  it('ventas de planes por plan y por día; los anulados no son venta; el rango por defecto son 30 días', async () => {
    const o = await k.activeOwner();
    const semanal = await planTemplate(k, o, 'Semanal', 5, 1500);
    const mensual = await planTemplate(k, o, 'Mensual', 20, 2500);
    const hoy = await localToday(k, o);
    const a = await clientWithPlan(k, o, semanal);
    const b = await clientWithPlan(k, o, semanal);
    const c = await clientWithPlan(k, o, mensual);
    const x = await clientWithPlan(k, o, semanal);
    await k.as(o).post(`/v1/planes-vendidos/${x.planVendidoId}/deshacer`, {}, randomUUID());
    await k.lunch(o, a.clienteId); // un almuerzo consumido del plan de A
    await moveSubscription(k, b.planVendidoId, `comprada_en = comprada_en - interval '2 days'`);
    await moveSubscription(k, c.planVendidoId, `comprada_en = comprada_en - interval '40 days'`);

    const r = (await k.as(o).get('/v1/reportes/ventas-planes')).json();
    expect(r).toMatchObject({ hasta: hoy, desde: addDays(hoy, -29), zonaHoraria: 'America/Guayaquil', moneda: 'USD' });
    expect(r.total).toEqual({ vendidos: 2, anulados: 1, ingresoCentavos: 3000 });
    expect(r.porPlan).toEqual([
      { nombre: 'Semanal', vendidos: 2, anulados: 1, ingresoCentavos: 3000, almuerzosVendidos: 10, almuerzosConsumidos: 1 },
    ]);
    expect(r.porDia).toEqual([
      { fecha: addDays(hoy, -2), vendidos: 1, ingresoCentavos: 1500 },
      { fecha: hoy, vendidos: 1, ingresoCentavos: 1500 },
    ]);
    const largo = (await k.as(o).get(`/v1/reportes/ventas-planes?desde=${addDays(hoy, -60)}&hasta=${hoy}`)).json();
    expect(largo.porPlan.map((p: { nombre: string }) => p.nombre)).toEqual(['Semanal', 'Mensual']);
    expect(largo.total.ingresoCentavos).toBe(5500);
  });

  it('valida entradas, roles y aislamiento entre locales', async () => {
    const o = await k.activeOwner();
    const otro = await k.activeOwner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    await clientWithPlan(k, o, plan);
    for (const url of [
      '/v1/reportes/resumen-diario?fecha=2026-02-31',
      '/v1/reportes/resumen-diario?fecha=ayer',
      '/v1/reportes/ventas-planes?desde=2026-13-01',
    ]) {
      expect((await k.as(o).get(url)).statusCode, url).toBe(400);
    }
    expect((await k.as(o).get('/v1/reportes/ventas-planes?desde=2026-10-10&hasta=2026-10-01')).json().code).toBe('RANGO_INVALIDO');
    expect((await k.as(o).get('/v1/reportes/ventas-planes?desde=2024-01-01&hasta=2026-10-01')).json().code).toBe('RANGO_MUY_LARGO');
    expect((await k.as(o).get('/v1/reportes/resumen-diario?fecha=2026-02-31')).json().code).toBe('FECHA_INVALIDA');
    expect((await k.as(o).get('/v1/reportes/ventas-planes?otro=1')).statusCode).toBe(400);
    for (const url of ['/v1/reportes/resumen-diario', '/v1/reportes/ventas-planes']) {
      expect((await k.as(cajero).get(url)).statusCode, url).toBe(403);
      expect((await k.as({ token: d.token, restaurante: o.restaurante }).get(url)).statusCode).toBe(403);
      expect((await k.as({}).get(url)).statusCode).toBe(401);
    }
    expect((await k.as(otro).get('/v1/reportes/ventas-planes')).json().total).toEqual({ vendidos: 0, anulados: 0, ingresoCentavos: 0 });
    expect((await k.as(o).get('/v1/reportes/ventas-planes')).json().total.vendidos).toBe(1);
  });
});
