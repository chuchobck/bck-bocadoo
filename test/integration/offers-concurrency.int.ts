import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { offer } from './offers-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;

/**
 * Conexiones reales y simultáneas contra un clon descartable de la base (ver scratch-db.ts): el patrón probe usa una
 * sola conexión y no puede probar el bloqueo de fila que protege el stock.
 */
describe.skipIf(!scratch)('Fase 9: stock de ofertas con canjes concurrentes', () => {
  // DinerKit pide un Probe solo por su `factory`; aquí no se usa ninguna otra cosa de él.
  const k = new DinerKit(scratch as unknown as Probe, 93);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  const stockOf = async (id: string) =>
    k.h.db.service(async (q) => {
      const r = await q.query<{ stock_restante: number; stock_total: number; canjes: number; unidades: number; pagos: string }>(
        `SELECT o.stock_restante, o.stock_total, count(c.canje_id)::int AS canjes, COALESCE(sum(c.cantidad), 0)::int AS unidades,
                (SELECT COALESCE(sum(p.monto_centavos), 0) FROM transaccion_pago p WHERE p.canje_oferta_id IN
                   (SELECT canje_id FROM canje_oferta_flash WHERE oferta_flash_id = o.oferta_flash_id)) AS pagos
           FROM oferta_flash o LEFT JOIN canje_oferta_flash c ON c.oferta_flash_id = o.oferta_flash_id
          WHERE o.public_id = $1 GROUP BY o.oferta_flash_id`,
        [id],
      );
      return r.rows[0]!;
    });

  it('20 canjes a la vez sobre 5 unidades: exactamente 5 pasan, el stock queda en 0 y nunca es negativo', async () => {
    const o = await k.activeOwner();
    const id = (await k.as(o).post('/v1/ofertas', offer({ stock: 5 }), randomUUID())).json().id as string;
    const res = await Promise.all(
      Array.from({ length: 20 }, () => k.as(o).post(`/v1/ofertas/${id}/canjear`, { metodoPago: 'EFECTIVO' }, randomUUID())),
    );
    const ok = res.filter((r) => r.statusCode === 201);
    const no = res.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(5);
    expect(no).toHaveLength(15);
    expect(new Set(no.map((r) => r.json().code))).toEqual(new Set(['OFERTA_AGOTADA']));
    expect(
      res.every((r) => r.statusCode === 201 || r.statusCode === 409),
      res.map((r) => r.statusCode).join(),
    ).toBe(true);
    expect(await stockOf(id)).toMatchObject({ stock_restante: 0, canjes: 5, unidades: 5, pagos: '2250' });
  });

  it('canjes de distinto tamaño: nunca se vende más de lo publicado', async () => {
    const o = await k.activeOwner();
    const id = (await k.as(o).post('/v1/ofertas', offer({ stock: 7 }), randomUUID())).json().id as string;
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        k.as(o).post(`/v1/ofertas/${id}/canjear`, { metodoPago: 'DEUNA', cantidad: (i % 3) + 1 }, randomUUID()),
      ),
    );
    expect(res.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    const s = await stockOf(id);
    expect(s.stock_restante).toBeGreaterThanOrEqual(0);
    expect(s.unidades + s.stock_restante).toBe(7);
    expect(s.pagos).toBe(String(s.unidades * 450));
    const lastOk = res.filter((r) => r.statusCode === 409).map((r) => r.json().code);
    expect(lastOk.every((c: string) => c === 'OFERTA_AGOTADA' || c === 'STOCK_INSUFICIENTE')).toBe(true);
  });

  it('la misma Idempotency-Key en 6 peticiones simultáneas: un solo canje y un solo descuento', async () => {
    const o = await k.activeOwner();
    const id = (await k.as(o).post('/v1/ofertas', offer({ stock: 5 }), randomUUID())).json().id as string;
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 6 }, () => k.as(o).post(`/v1/ofertas/${id}/canjear`, { metodoPago: 'EFECTIVO' }, key)),
    );
    expect(res.map((r) => r.statusCode)).toEqual(Array(6).fill(201));
    expect(new Set(res.map((r) => r.json().id)).size).toBe(1);
    expect(await stockOf(id)).toMatchObject({ stock_restante: 4, canjes: 1, unidades: 1, pagos: '450' });
  });
});
