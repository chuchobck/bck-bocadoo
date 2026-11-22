import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;
const P = 350;
const R = 25;
const B = 100;
const E = 75;

/**
 * PR 5b con conexiones reales y simultáneas (clon descartable, ver scratch-db.ts): agregar y quitar líneas compiten
 * con cobrar por el mismo bloqueo de la cuenta; la misma llave de validar con items crea una sola cuenta.
 */
describe.skipIf(!scratch)('PR 5b: cuentas del QR con peticiones simultáneas', () => {
  const k = new DinerKit(scratch as unknown as Probe, 86);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  async function local() {
    const o = await k.activeOwner();
    expect((await k.as(o).patch('/v1/restaurante', { momentoCobro: 'DESPUES_DE_SERVIR' })).statusCode).toBe(200);
    const m = await k.menu(o);
    return { o, cola: m.Cola!, huevo: m['Huevo frito']! };
  }
  type Local = Awaited<ReturnType<typeof local>>;
  const codigo = async (l: Local, d: { token?: string }) =>
    (await k.as(d).get(`/v1/pase/codigo?restaurante=${l.o.restaurante}`)).json().codigo as string;
  /** Cuenta ABIERTA de un comensal sin plan: almuerzo 350 + Cola 100. */
  async function abierta(l: Local) {
    const d = await k.diner();
    const r = await k
      .as(l.o)
      .post('/v1/caja/validar', { codigoQr: await codigo(l, d), items: [{ plato: l.cola, cantidad: 1 }] }, randomUUID());
    expect(r.json().cuenta, r.body).toMatchObject({ estado: 'ABIERTA', saldoCentavos: P + B });
    return r.json().cuenta.id as string;
  }
  const estado = (cuentaPublicId: string) =>
    k.h.db.service(async (q) => {
      const r = await q.query<{ estado: string; por_cobrar: string; pagado: string; lineas: number; reversos: number }>(
        `SELECT c.estado::text AS estado, s.por_cobrar_centavos::text AS por_cobrar, s.pagado_centavos::text AS pagado,
                (SELECT count(*)::int FROM cuenta_cobro_linea l WHERE l.cuenta_id = c.cuenta_id) AS lineas,
                (SELECT count(*)::int FROM cuenta_cobro_linea l WHERE l.cuenta_id = c.cuenta_id AND l.revierte_a_linea_id IS NOT NULL) AS reversos
           FROM cuenta_cobro c JOIN v_cuenta_saldo s ON s.cuenta_id = c.cuenta_id WHERE c.public_id = $1`,
        [cuentaPublicId],
      );
      const x = r.rows[0]!;
      return { ...x, por_cobrar: Number(x.por_cobrar), pagado: Number(x.pagado) };
    });

  it('agregar y cobrar todo a la vez: o se cobra lo visto y agregar choca (CUENTA_CERRADA), o se agrega y cobrar ve otro saldo', async () => {
    const l = await local();
    for (let i = 0; i < 4; i++) {
      const id = await abierta(l);
      const [a, c] = await Promise.all([
        k.as(l.o).post(`/v1/caja/cuentas/${id}/items`, { items: [{ plato: l.huevo, cantidad: 2 }] }, randomUUID()),
        k.as(l.o).post(`/v1/caja/cuentas/${id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: P + B }, randomUUID()),
      ]);
      const fin = await estado(id);
      if (c.statusCode === 200) {
        expect(a.statusCode, a.body).toBe(409);
        expect(a.json().code).toBe('CUENTA_CERRADA');
        expect(fin).toMatchObject({ estado: 'COBRADA', por_cobrar: P + B, pagado: P + B, lineas: 2 });
      } else {
        expect(a.statusCode, a.body).toBe(200);
        expect(c.statusCode).toBe(409);
        expect(c.json().code).toBe('SALDO_CAMBIO');
        expect(fin).toMatchObject({ estado: 'ABIERTA', por_cobrar: P + B + 2 * E, pagado: 0, lineas: 3 });
      }
    }
  });

  it('quitar y un pago parcial a la vez: lo pagado nunca supera lo que queda por cobrar', async () => {
    const l = await local();
    for (let i = 0; i < 4; i++) {
      const id = await abierta(l);
      // Pagar 400 deja sin sitio para quitar el almuerzo (quedaría 100 < 400): uno de los dos gana.
      const [q, c] = await Promise.all([
        k.as(l.o).post(`/v1/caja/cuentas/${id}/lineas/almuerzo/quitar`, undefined, randomUUID()),
        k
          .as(l.o)
          .post(
            `/v1/caja/cuentas/${id}/cobrar`,
            { metodoPago: 'EFECTIVO', montoCentavos: 400, saldoEsperadoCentavos: P + B },
            randomUUID(),
          ),
      ]);
      const fin = await estado(id);
      expect(fin.pagado).toBeLessThanOrEqual(fin.por_cobrar);
      if (c.statusCode === 200) {
        expect(q.statusCode, q.body).toBe(409);
        expect(q.json().code).toBe('SALDO_NEGATIVO');
        expect(fin).toMatchObject({ por_cobrar: P + B, pagado: 400, reversos: 0 });
      } else {
        expect(q.statusCode, q.body).toBe(200);
        expect(c.json().code).toBe('SALDO_CAMBIO');
        expect(fin).toMatchObject({ por_cobrar: B, pagado: 0, reversos: 1 });
      }
    }
  });

  it('la misma llave de agregar en 5 peticiones simultáneas: una sola línea nueva', async () => {
    const l = await local();
    const id = await abierta(l);
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 5 }, () => k.as(l.o).post(`/v1/caja/cuentas/${id}/items`, { items: [{ plato: l.cola, cantidad: 1 }] }, key)),
    );
    expect(res.map((r) => r.statusCode)).toEqual(Array(5).fill(200));
    expect(new Set(res.map((r) => r.body)).size).toBe(1);
    // La Cola se fusiona: inversa de la de 1 y una nueva de 2.
    expect(await estado(id)).toMatchObject({ por_cobrar: P + 2 * B, lineas: 4, reversos: 1 });
  });

  it('agregar y quitar a la vez sobre la misma cuenta: el resultado es el de aplicarlos uno tras otro', async () => {
    const l = await local();
    const id = await abierta(l);
    const [a, q] = await Promise.all([
      k.as(l.o).post(`/v1/caja/cuentas/${id}/items`, { items: [{ plato: l.huevo, cantidad: 1 }] }, randomUUID()),
      k.as(l.o).post(`/v1/caja/cuentas/${id}/lineas/${encodeURIComponent(`item:${l.cola}`)}/quitar`, undefined, randomUUID()),
    ]);
    expect([a.statusCode, q.statusCode]).toEqual([200, 200]);
    expect(await estado(id)).toMatchObject({ estado: 'ABIERTA', por_cobrar: P + E, pagado: 0, reversos: 1 });
  });

  it('validar con items y cobro, la misma llave en 4 peticiones simultáneas: un consumo, una cuenta y un pago', async () => {
    const l = await local();
    const d = await k.dinerWithPlan(l.o);
    const body = {
      codigoQr: await codigo(l, d),
      paraLlevar: true,
      items: [{ plato: l.cola, cantidad: 1 }],
      cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B + R },
    };
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => k.as(l.o).post('/v1/caja/validar', body, key)));
    expect(
      res.map((r) => r.statusCode),
      res.map((r) => r.body).join(),
    ).toEqual(Array(4).fill(200));
    expect(new Set(res.map((r) => r.json().cuenta.id)).size).toBe(1);
    expect(new Set(res.map((r) => r.json().consumo.id)).size).toBe(1);
    const fin = await estado(res[0]!.json().cuenta.id);
    expect(fin).toMatchObject({ estado: 'COBRADA', pagado: B + R });
    const consumos = await k.h.db.service(
      async (q) =>
        (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM consumo_almuerzo k WHERE k.cliente_id::text = $1`, [d.clienteId]))
          .rows[0]!.n,
    );
    expect(consumos).toBe(1);
  });
});
