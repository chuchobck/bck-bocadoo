import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DbService, assertScopeId, type PoolFactory } from '../../src/db/db.service';
import { loadEnv } from '../../src/config/env';

const env = loadEnv({
  DATABASE_URL: 'postgresql://a:b@localhost/db',
  DATABASE_SERVICE_URL: 'postgresql://c:d@localhost/db',
} as NodeJS.ProcessEnv);

/** Pool falso: registra cada sentencia y permite hacer fallar una concreta. */
function fakePools(failOn?: RegExp) {
  const log: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      log.push(params ? `${text} ${JSON.stringify(params)}` : text);
      if (failOn?.test(text)) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn((err?: unknown) => released.push(err)),
  };
  const factory: PoolFactory = () => ({ connect: async () => client, on: () => undefined, end: async () => undefined }) as unknown as Pool;
  return { log, client, released, db: new DbService(env, factory) };
}

describe('assertScopeId', () => {
  it.each(['1', '42', '9223372036854775807'])('acepta %s', (v) => {
    expect(assertScopeId(v, 'id')).toBe(v);
  });
  it.each(['0', '-1', 'abc', ' 1', '1; DROP TABLE x', '01', '9223372036854775808', '1.5', ''])('rechaza %j', (v) => {
    expect(() => assertScopeId(v, 'id')).toThrow(/inválido/);
  });
  it('undefined significa sin contexto (cadena vacía)', () => {
    expect(assertScopeId(undefined, 'id')).toBe('');
  });
});

describe('DbService.scope', () => {
  it('abre transacción, fija el contexto con set_config local y confirma', async () => {
    const { db, log, released } = fakePools();
    await db.scope({ tenantId: '7', userId: '9' }, (q) => q.query('SELECT 1'));
    expect(log[0]).toBe('BEGIN');
    expect(log[1]).toContain('set_config($1, $2, true)');
    expect(log[1]).toContain('["app.current_tenant_id","7","app.current_user_id","9"]');
    expect(log[2]).toBe('SELECT 1');
    expect(log[3]).toBe('COMMIT');
    expect(released).toEqual([undefined]);
  });

  it('sin tenant ni usuario manda cadenas vacías', async () => {
    const { db, log } = fakePools();
    await db.scope({}, async () => undefined);
    expect(log[1]).toContain('["app.current_tenant_id","","app.current_user_id",""]');
  });

  it('readOnly abre BEGIN READ ONLY', async () => {
    const { db, log } = fakePools();
    await db.scope({ tenantId: '1', readOnly: true }, async () => undefined);
    expect(log[0]).toBe('BEGIN READ ONLY');
  });

  it('si fn falla hace ROLLBACK, relanza el error y libera la conexión', async () => {
    const { db, log, released } = fakePools();
    await expect(
      db.scope({ tenantId: '1' }, async () => {
        throw new Error('negocio');
      }),
    ).rejects.toThrow('negocio');
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(log).not.toContain('COMMIT');
    expect(released).toEqual([undefined]);
  });

  it('si el ROLLBACK también falla, descarta la conexión (release con error)', async () => {
    const { db, released } = fakePools(/ROLLBACK/);
    await expect(
      db.scope({ tenantId: '1' }, async () => {
        throw new Error('negocio');
      }),
    ).rejects.toThrow('negocio');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('un id inválido se rechaza antes de abrir conexión', async () => {
    const { db, client } = fakePools();
    await expect(db.scope({ tenantId: '1; DROP TABLE x' }, async () => undefined)).rejects.toThrow(/inválido/);
    expect(client.query).not.toHaveBeenCalled();
  });
});
