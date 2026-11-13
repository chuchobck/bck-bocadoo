import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import type { PoolFactory } from '../../src/db/db.service';

/**
 * Base descartable para las pruebas que necesitan conexiones REALES y simultáneas (el patrón probe usa una sola
 * conexión y no puede probar bloqueos de fila). Clona la base de PROBE_DATABASE_URL con CREATE DATABASE ... TEMPLATE,
 * corre la prueba contra el clon y lo borra al final: la base original no recibe ni una fila.
 *
 * Requisitos: PROBE_DATABASE_URL con un superusuario (en local, el de Docker; nunca Neon) y que nadie más esté
 * conectado a la base original mientras se clona (Postgres lo exige). Las suites corren una a la vez, así que en
 * `pnpm test:db` se cumple; si se corre con una sesión abierta (psql, un IDE), falla con un mensaje claro.
 */
export class ScratchDb {
  private pools: Pool[] = [];
  private constructor(
    private readonly adminUrl: string,
    readonly name: string,
    private readonly sourceName: string,
  ) {}

  static async create(): Promise<ScratchDb | null> {
    const source = process.env.PROBE_DATABASE_URL;
    if (!source) return null;
    const sourceName = new URL(source).pathname.slice(1);
    const admin = new URL(source);
    admin.pathname = '/postgres';
    const name = `bck_scratch_${randomBytes(5).toString('hex')}`;
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`CREATE DATABASE ${name} TEMPLATE ${sourceName}`);
    } catch (err) {
      throw new Error(`No se pudo clonar la base "${sourceName}" (¿hay otra sesión conectada a ella?): ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      await c.end();
    }
    return new ScratchDb(admin.toString(), name, sourceName);
  }

  /** Para createApp({ poolFactory }): mismos roles y contraseñas de .env, pero apuntando al clon. */
  readonly factory: PoolFactory = (connectionString, max) => {
    const u = new URL(connectionString);
    u.pathname = `/${this.name}`;
    const pool = new pg.Pool({ connectionString: u.toString(), max, connectionTimeoutMillis: 5_000 });
    this.pools.push(pool);
    return pool;
  };

  async drop(): Promise<void> {
    const c = new pg.Client({ connectionString: this.adminUrl });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  }
}
