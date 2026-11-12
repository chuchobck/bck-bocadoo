import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';

const base = { DATABASE_URL: 'postgresql://a:b@h/db', DATABASE_SERVICE_URL: 'postgresql://c:d@h/db' } as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('aplica DB_POOL_MAX=10 por defecto', () => {
    expect(loadEnv(base).DB_POOL_MAX).toBe(10);
  });
  it('rechaza un DB_POOL_MAX fuera de rango', () => {
    expect(() => loadEnv({ ...base, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
  });
  it('si falta DATABASE_URL dice cuál', () => {
    expect(() => loadEnv({ DATABASE_SERVICE_URL: base.DATABASE_SERVICE_URL } as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });
});
