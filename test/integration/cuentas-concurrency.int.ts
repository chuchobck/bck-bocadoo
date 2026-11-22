import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;
const R = 25;

/**
 * Conexiones reales y simultáneas contra un clon descartable de la base (ver scratch-db.ts): el bloqueo de la cuenta
 * (FOR UPDATE) y el del pedido no se pueden probar con una sola conexión.
 */
describe.skipIf(!scratch)('PR 5a: cuentas de cobro con peticiones simultáneas', () => {
  const k = new DinerKit(scratch as unknown as Probe, 89);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  async function pedido() {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const p = (
      await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: o.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [m['Sopa de quinua']] },
          extras: [{ plato: m.Cola, cantidad: 1 }],
        },
        randomUUID(),
      )
    ).json();
    return { o, d, p };
  }
  const contar = (ordenPublicId: string) =>
    k.h.db.service(async (q) => {
      const r = await q.query<{ cuentas: number; consumos: number; pagado: string; plan: number }>(
        `SELECT (SELECT count(*)::int FROM cuenta_cobro c WHERE c.orden_id = o.orden_id) AS cuentas,
                (SELECT count(*)::int FROM consumo_almuerzo k WHERE k.orden_id = o.orden_id AND k.cantidad = 1) AS consumos,
                (SELECT COALESCE(sum(p.monto_centavos), 0) FROM transaccion_pago p JOIN cuenta_cobro c ON c.cuenta_id = p.cuenta_cobro_id
                  WHERE c.orden_id = o.orden_id AND p.estado <> 'RECHAZADO') AS pagado,
                (SELECT almuerzos_restantes FROM suscripcion_plan s WHERE s.cliente_id = o.cliente_id ORDER BY suscripcion_id DESC LIMIT 1) AS plan
           FROM orden_cabecera o WHERE o.public_id = $1`,
        [ordenPublicId],
      );
      return r.rows[0]!;
    });

  it('dos pagos simultáneos por todo el saldo: uno pasa y el otro no; lo pagado nunca supera el total', async () => {
    const { o, p } = await pedido();
    const c = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, randomUUID())).json().cuenta;
    expect(c.saldoCentavos).toBe(100 + R);
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        k
          .as(o)
          .post(
            `/v1/caja/cuentas/${c.id}/cobrar`,
            { metodoPago: i % 2 ? 'EFECTIVO' : 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: 100 + R },
            randomUUID(),
          ),
      ),
    );
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const no = res.filter((r) => r.statusCode !== 200);
    expect(
      no.every((r) => r.statusCode === 409 && ['SALDO_CAMBIO', 'CUENTA_CERRADA'].includes(r.json().code)),
      no.map((r) => r.body).join(),
    ).toBe(true);
    expect(await contar(p.id)).toMatchObject({ cuentas: 1, pagado: String(100 + R) });
    expect((await k.as(o).get(`/v1/caja/cuentas/${c.id}`)).json()).toMatchObject({ estado: 'COBRADA', saldoCentavos: 0 });
  });

  it('pagos parciales simultáneos: la suma nunca pasa del saldo', async () => {
    const { o, p } = await pedido();
    const c = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, randomUUID())).json().cuenta;
    // Cada uno vio el saldo completo: solo el primero que toma el bloqueo cobra; los demás ven otro saldo.
    const res = await Promise.all(
      Array.from({ length: 5 }, () =>
        k
          .as(o)
          .post(
            `/v1/caja/cuentas/${c.id}/cobrar`,
            { metodoPago: 'EFECTIVO', montoCentavos: 50, saldoEsperadoCentavos: 100 + R },
            randomUUID(),
          ),
      ),
    );
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(Number((await contar(p.id)).pagado)).toBe(50);
  });

  it('la misma llave de cobro en 5 peticiones simultáneas: un solo pago', async () => {
    const { o, p } = await pedido();
    const c = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, randomUUID())).json().cuenta;
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 5 }, () =>
        k.as(o).post(`/v1/caja/cuentas/${c.id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R }, key),
      ),
    );
    expect(res.map((r) => r.statusCode)).toEqual(Array(5).fill(200));
    expect(
      new Set(
        res.map((r) =>
          r
            .json()
            .pagos.map((x: { id: string }) => x.id)
            .join(),
        ),
      ).size,
    ).toBe(1);
    expect(await contar(p.id)).toMatchObject({ pagado: String(100 + R) });
  });

  it('doble canje simultáneo con cobro (otras llaves): un consumo, una cuenta y un pago', async () => {
    const { o, p } = await pedido();
    const res = await Promise.all(
      Array.from({ length: 4 }, () =>
        k
          .as(o)
          .post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R } }, randomUUID()),
      ),
    );
    expect(res.map((r) => r.statusCode)).toEqual(Array(4).fill(200));
    expect(res.filter((r) => r.json().yaCanjeado === false)).toHaveLength(1);
    expect(new Set(res.map((r) => r.json().cuenta?.id)).size).toBe(1);
    expect(await contar(p.id)).toMatchObject({ cuentas: 1, consumos: 1, pagado: String(100 + R), plan: 4 });
  });

  it('doble canje simultáneo con la misma llave: un consumo y una cuenta', async () => {
    const { o, p } = await pedido();
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, key)));
    expect(res.map((r) => r.statusCode)).toEqual(Array(4).fill(200));
    expect(new Set(res.map((r) => r.json().cuenta.id)).size).toBe(1);
    expect(await contar(p.id)).toMatchObject({ cuentas: 1, consumos: 1, plan: 4 });
  });

  it('anular y cobrar a la vez: o se cobra y se devuelve, o se anula sin cobro; nunca queda dinero en una cuenta anulada', async () => {
    const { o, p } = await pedido();
    const c = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: {} }, randomUUID())).json().cuenta;
    await Promise.all([
      k.as(o).post(`/v1/caja/cuentas/${c.id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R }, randomUUID()),
      k.as(o).post(`/v1/caja/cuentas/${c.id}/anular`, {}, randomUUID()),
    ]);
    const fin = (await k.as(o).get(`/v1/caja/cuentas/${c.id}`)).json();
    expect(fin.estado).toBe('ANULADA');
    expect(fin.pagadoCentavos).toBe(0);
    expect((await contar(p.id)).plan).toBe(5);
  });
});
