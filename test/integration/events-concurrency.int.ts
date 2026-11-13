import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;

/** Conexiones reales contra un clon descartable (ver scratch-db.ts): la carrera por la misma Idempotency-Key. */
describe.skipIf(!scratch)('Fase 9: lotes de eventos con la misma Idempotency-Key a la vez', () => {
  const k = new DinerKit(scratch as unknown as Probe, 99);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  it('8 peticiones simultáneas con la misma llave: un solo lote guardado y todas responden igual', async () => {
    const d = await k.diner();
    const key = randomUUID();
    const tipo = `carrera.${randomUUID().replaceAll('-', '').slice(0, 12)}`; // único: el clon trae eventos del seed
    const body = { eventos: [{ tipo }, { tipo }, { tipo }] };
    const res = await Promise.all(Array.from({ length: 8 }, () => k.as(d).post('/v1/eventos', body, key)));
    expect(res.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    expect(new Set(res.map((r) => r.body)).size).toBe(1);
    const n = await k.h.db.service(async (q) => {
      const e = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM evento_analitica WHERE tipo = $1', [tipo]);
      const l = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM evento_lote');
      return { eventos: e.rows[0]!.n, lotes: l.rows[0]!.n };
    });
    expect(n).toEqual({ eventos: 3, lotes: 1 });
  });
});
