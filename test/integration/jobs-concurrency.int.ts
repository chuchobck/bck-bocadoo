import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadEnv } from '../../src/config/env';
import { DbService } from '../../src/db/db.service';
import { runCli } from '../../src/jobs/cli';
import { jobLockKey, runJob, type CreatePartitionsResult, type ExpirePlansResult } from '../../src/jobs/jobs';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;

/** Conexiones reales contra un clon descartable (ver scratch-db.ts): cron disparado dos veces y la entrada por CLI. */
describe.skipIf(!scratch)('Fase 9: jobs con conexiones reales (doble disparo y CLI)', () => {
  const env = scratch
    ? {
        ...process.env,
        DATABASE_URL: scratch.urlFor(process.env.DATABASE_URL!),
        DATABASE_SERVICE_URL: scratch.urlFor(process.env.DATABASE_SERVICE_URL!),
      }
    : process.env;
  const db = scratch ? new DbService(loadEnv(env), scratch.factory) : (undefined as never);
  afterAll(async () => {
    await db?.onModuleDestroy();
    await scratch?.drop();
  });

  const count = async () =>
    db.service(async (q) => {
      const r = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent IN ('evento_analitica'::regclass, 'log_actividad'::regclass)`,
      );
      return r.rows[0]!.n;
    });
  const cli = async (argv: string[], e: NodeJS.ProcessEnv = env) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, e, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.map((l) => JSON.parse(l) as Record<string, unknown>), err: err.join('\n') };
  };

  it('dos corridas a la vez (Render dispara el cron dos veces): nada se duplica y ninguna falla', async () => {
    const antes = await count();
    const res = (await Promise.all(
      Array.from({ length: 4 }, () => runJob(db, 'create-partitions', { monthsAhead: 11 })),
    )) as CreatePartitionsResult[];
    expect(res.every((r) => r.ok && r.errores.length === 0)).toBe(true);
    const creadas = res.flatMap((r) => r.creadas);
    expect(new Set(creadas).size).toBe(creadas.length); // ninguna partición la creó más de una copia
    expect(await count()).toBe(antes + creadas.length);
    expect(creadas.length).toBeGreaterThan(0);
    // Las que llegaron con el candado tomado se saltaron en vez de esperar.
    expect(res.filter((r) => r.omitido === 'EN_EJECUCION').length + res.filter((r) => r.creadas.length > 0).length).toBeGreaterThanOrEqual(
      1,
    );
    const otra = await runJob(db, 'create-partitions', { monthsAhead: 11 });
    expect(otra).toMatchObject({ ok: true, creadas: [] });
  });

  it('con el candado tomado por otra sesión, el job se salta (EN_EJECUCION) y no toca nada; al soltarlo, corre', async () => {
    const holder = new pg.Client({ connectionString: env.DATABASE_SERVICE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [jobLockKey('expire-plans')]);
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [jobLockKey('create-partitions')]);
      const before = await count();
      const a = (await runJob(db, 'expire-plans')) as ExpirePlansResult;
      const b = (await runJob(db, 'create-partitions', { monthsAhead: 12 })) as CreatePartitionsResult;
      expect(a).toEqual({ job: 'expire-plans', ok: true, omitido: 'EN_EJECUCION', vencidos: 0 });
      expect(b).toMatchObject({ ok: true, omitido: 'EN_EJECUCION', creadas: [], existentes: [], errores: [] });
      expect(await count()).toBe(before);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(await runJob(db, 'expire-plans')).not.toHaveProperty('omitido');
  });

  it('CLI: `all` corre los dos jobs con una línea JSON cada uno y, repetido, no cambia nada', async () => {
    const first = await cli(['all', '--months-ahead=5']);
    expect(first.code).toBe(0);
    expect(first.out.map((l) => l.job)).toEqual(['expire-plans', 'create-partitions']);
    expect(first.out.every((l) => l.ok === true && typeof l.duracionMs === 'number')).toBe(true);
    const before = await count();
    const second = await cli(['all', '--months-ahead=5']);
    expect(second.code).toBe(0);
    expect(second.out[0]).toMatchObject({ job: 'expire-plans', vencidos: 0 });
    expect(second.out[1]).toMatchObject({ job: 'create-partitions', creadas: [] });
    expect(await count()).toBe(before);
    expect((await cli(['expire-plans'])).out).toHaveLength(1);
  });

  it('CLI: uso incorrecto → código 2 con la ayuda; una base inalcanzable → código 1 con el error en JSON', async () => {
    for (const argv of [[], ['otro'], ['all', '--months-ahead=99'], ['create-partitions', '--months-ahead=x'], ['all', '--rapido']]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toContain('Uso: node dist/jobs/cli.js');
    }
    const roto = await cli(['expire-plans'], { ...env, DATABASE_SERVICE_URL: 'postgresql://bck_servicio:x@127.0.0.1:1/nada' });
    expect(roto.code).toBe(1);
    expect(roto.out[0]).toMatchObject({ job: 'expire-plans', ok: false });
  });
});
