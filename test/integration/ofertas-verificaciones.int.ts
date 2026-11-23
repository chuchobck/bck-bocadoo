import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

/** Verificaciones previas al push del PR 7b: deshacer un canje con saldo 0 y el precio de un almuerzo cuya oferta cae. */
describe.skipIf(!probe)('PR 7b: verificaciones (deshacer con saldo 0, almuerzo cuya oferta cae)', () => {
  const k = new DinerKit(probe!, 144);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const saldoPlan = async (o: object, c: string) => (await k.as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const cuentasDe = async (pedidoId: string) =>
    (
      await probe!.sql<{ estado: string }>(
        `SELECT c.estado FROM cuenta_cobro c JOIN orden_cabecera o ON o.orden_id = c.orden_id WHERE o.public_id = $1`,
        [pedidoId],
      )
    ).rows;

  it('1. canje con plan que cubre todo (saldo 0) y cobro {}: sin cuenta, y se puede deshacer en los 10 s', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const p = (
      await k
        .as(d)
        .post(
          '/v1/mis/pedidos',
          { restaurante: o.restaurante, almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] } },
          randomUUID(),
        )
    ).json();
    const r = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().cuenta).toBeNull(); // saldo 0 y sin pagos: sin cuenta, así deshacer no choca con CUENTA_COBRADA
    expect(await saldoPlan(o, d.clienteId)).toBe(4);
    const u = await k.as(o).post(`/v1/caja/consumos/${r.json().almuerzo.consumoId}/deshacer`);
    expect([u.statusCode, u.json().code]).toEqual([200, undefined]);
    expect(await saldoPlan(o, d.clienteId)).toBe(5);
  });

  it('2. almuerzo.ofertaId que cae antes de canjear: vuelve a almuerzo normal (plan o P), nunca al precio de carta del plato', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const gestion = (await probe!.sql<{ id: string }>('SELECT plato_id::text AS id FROM plato WHERE public_id = $1', [m['Seco de pollo']]))
      .rows[0]!.id;
    // El plato del almuerzo tiene precio de carta 500 y la oferta un original de 700: ninguno debe aparecer en el almuerzo.
    await probe!.sql('UPDATE plato SET precio_centavos = 500 WHERE plato_id = $1', [gestion]);
    const of = (
      await k.as(o).post(
        '/v1/ofertas',
        {
          titulo: 'Seco flash',
          platoId: m['Seco de pollo'],
          precioCentavos: 250,
          precioOriginalCentavos: 700,
          stock: 3,
          duracionMinutos: 60,
        },
        randomUUID(),
      )
    ).json().id as string;
    const body = () => ({
      restaurante: o.restaurante,
      almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']], ofertaId: of },
    });

    // Con plan: cae a PLAN (saldo 0).
    const conPlan = await k.dinerWithPlan(o);
    const a = (await k.as(conPlan).post('/v1/mis/pedidos', body(), randomUUID())).json();
    // Sin plan: cae a P.
    const sinPlan = await k.diner();
    const b = (await k.as(sinPlan).post('/v1/mis/pedidos', body(), randomUUID())).json();
    expect([a.totalCentavos, b.totalCentavos]).toEqual([250, 250]);
    expect((await k.as(o).post(`/v1/ofertas/${of}/cerrar`)).statusCode).toBe(200);

    const ra = await k.as(o).post(`/v1/caja/pedidos/${a.id}/canjear`, { cobro: { saldoEsperadoCentavos: 0 } }, randomUUID());
    expect(ra.statusCode, ra.body).toBe(200);
    expect(ra.json().cotizacion.lineas).toMatchObject([{ tipo: 'ALMUERZO', fuente: 'PLAN', precioUnitarioCentavos: 350 }]);
    expect(ra.json().cotizacion.saldoPorCobrarCentavos).toBe(0);

    const rb = await k.as(o).post(`/v1/caja/pedidos/${b.id}/canjear`, { cobro: { saldoEsperadoCentavos: 350 } }, randomUUID());
    expect(rb.statusCode, rb.body).toBe(200);
    expect(rb.json().cotizacion.lineas).toMatchObject([{ tipo: 'ALMUERZO', fuente: 'CAJA', precioUnitarioCentavos: 350 }]);
    expect(rb.json().cotizacion.saldoPorCobrarCentavos).toBe(350);
    expect((await cuentasDe(b.id)).length).toBe(1);
  });
});
