import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;
const P = 350;
const R = 25;
const B = 100;

/**
 * PR 6c con conexiones reales y simultáneas (clon descartable, ver scratch-db.ts): dos cajas canjean el mismo pedido sin
 * `cobro` a la vez (llaves distintas o la misma) → una sola cuenta; un PATCH que deja el precio en 0 contra `activar`
 * → nunca queda un local ACTIVO con P = 0.
 */
describe.skipIf(!scratch)('PR 6c: huecos de cobro con peticiones simultáneas', () => {
  const k = new DinerKit(scratch as unknown as Probe, 121);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  /** Pedido para llevar con almuerzo y una Cola; con plan o de alguien que no es cliente del local. */
  async function pedido(o: Local, m: Record<string, string>, conPlan: boolean) {
    const d = conPlan ? await k.dinerWithPlan(o) : await k.diner();
    const r = await k.as(d).post(
      '/v1/mis/pedidos',
      {
        restaurante: o.restaurante,
        paraLlevar: true,
        almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] },
        extras: [{ plato: m.Cola, cantidad: 1 }],
      },
      randomUUID(),
    );
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const estado = (pedidoPublicId: string) =>
    k.h.db.service(async (q) => {
      const r = await q.query<{ cuentas: number; lineas: number; consumos: number }>(
        `SELECT (SELECT count(*)::int FROM cuenta_cobro c WHERE c.orden_id = o.orden_id) AS cuentas,
                (SELECT count(*)::int FROM cuenta_cobro_linea l JOIN cuenta_cobro c ON c.cuenta_id = l.cuenta_id WHERE c.orden_id = o.orden_id) AS lineas,
                (SELECT count(*)::int FROM consumo_almuerzo x WHERE x.orden_id = o.orden_id) AS consumos
           FROM orden_cabecera o WHERE o.public_id = $1`,
        [pedidoPublicId],
      );
      return r.rows[0]!;
    });

  it('dos cajas canjean a la vez el mismo pedido sin cobro (llaves distintas): una cuenta, un consumo; la otra ve yaCanjeado', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const cajero = await k.h.cashier(o.restaurante);
    for (const conPlan of [true, false, true, false]) {
      const id = await pedido(o, m, conPlan);
      const res = await Promise.all([o, cajero].map((who) => k.as(who).post(`/v1/caja/pedidos/${id}/canjear`, undefined, randomUUID())));
      expect(res.map((r) => r.statusCode)).toEqual([200, 200]);
      const body = res.map((r) => r.json());
      expect(body.map((b) => b.yaCanjeado).sort()).toEqual([false, true]);
      const saldo = conPlan ? B + R : P + B + R;
      for (const b of body) expect(b.cuenta).toMatchObject({ estado: 'ABIERTA', saldoCentavos: saldo });
      expect(body[0].cuenta.id).toBe(body[1].cuenta.id);
      expect(await estado(id)).toMatchObject({ cuentas: 1, consumos: conPlan ? 1 : 0 });
    }
  });

  it('la misma llave en 4 canjes simultáneos sin cobro: todos 200 con la misma cuenta; una cuenta y un consumo', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    for (const conPlan of [true, false]) {
      const id = await pedido(o, m, conPlan);
      const key = randomUUID();
      const res = await Promise.all(Array.from({ length: 4 }, () => k.as(o).post(`/v1/caja/pedidos/${id}/canjear`, undefined, key)));
      expect(res.map((r) => r.statusCode)).toEqual(Array(4).fill(200));
      expect(new Set(res.map((r) => r.json().cuenta.id)).size).toBe(1);
      expect(res.filter((r) => !r.json().yaCanjeado)).toHaveLength(1);
      const fin = await estado(id);
      expect(fin).toMatchObject({ cuentas: 1, consumos: conPlan ? 1 : 0 });
      expect(fin.lineas).toBe(2); // almuerzo (PLAN o CAJA) y la Cola
    }
  });

  it('PATCH precio 0 y activar a la vez: o se activa y el PATCH es 422, o el PATCH gana y activar es 409; nunca ACTIVO con 0', async () => {
    for (let i = 0; i < 4; i++) {
      const o = await k.owner();
      expect((await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: P })).statusCode).toBe(200);
      expect(
        (await k.as(o).put('/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '08:00', cierra: '16:00' }] })).statusCode,
      ).toBe(200);
      const [p, a] = await Promise.all([
        k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 0 }),
        k.as(o).post('/v1/restaurante/activar'),
      ]);
      const fin = (await k.as(o).get('/v1/restaurante')).json();
      if (a.statusCode === 200) {
        expect(p.statusCode, p.body).toBe(422);
        expect(p.json().code).toBe('PRECIO_ALMUERZO_REQUERIDO');
        expect(fin).toMatchObject({ estado: 'ACTIVO', precioAlmuerzoCentavos: P });
      } else {
        expect(a.statusCode, a.body).toBe(409);
        expect(p.statusCode, p.body).toBe(200);
        expect(fin).toMatchObject({ estado: 'BORRADOR', precioAlmuerzoCentavos: 0 });
      }
    }
  });
});
