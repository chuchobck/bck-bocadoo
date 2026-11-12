import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { RequestContextStore } from '../tenancy/request-context';

export const POOL_FACTORY = Symbol('POOL_FACTORY');
export type PoolFactory = (connectionString: string, max: number) => Pool;

const defaultPoolFactory: PoolFactory = (connectionString, max) =>
  new Pool({ connectionString, max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });

/** Lo único que ve el código de negocio: consultas, sin acceso al cliente ni al pool. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export interface ScopeOptions {
  /** restaurante_id del tenant (RLS). Sin él, solo se ve lo público. */
  tenantId?: string;
  /** usuario_id del actor (RLS del comensal y auditoría). */
  userId?: string;
  /** La transacción rechaza escrituras (error 25006). */
  readOnly?: boolean;
}

const MAX_BIGINT = 9223372036854775807n;

/** Los ids viajan a set_config como texto: solo enteros positivos que quepan en BIGINT. */
export function assertScopeId(value: string | undefined, name: string): string {
  if (value === undefined) return '';
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > MAX_BIGINT) {
    throw new Error(`${name} inválido para el contexto de base de datos`);
  }
  return value;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  /** Rol bck_api (sujeto a RLS), por el pooler. */
  private readonly appPool: Pool;
  /** Rol bck_servicio (BYPASSRLS), conexión directa: solo auth y cron. */
  private readonly servicePool: Pool;

  constructor(@Inject(ENV) env: Env, @Optional() @Inject(POOL_FACTORY) factory: PoolFactory = defaultPoolFactory) {
    this.appPool = factory(env.DATABASE_URL, env.DB_POOL_MAX);
    this.servicePool = factory(env.DATABASE_SERVICE_URL, Math.max(2, Math.ceil(env.DB_POOL_MAX / 2)));
    for (const [name, pool] of [['app', this.appPool], ['service', this.servicePool]] as const) {
      // Un error en un cliente inactivo no debe tumbar el proceso.
      pool.on('error', (err) => this.logger.error({ err, pool: name }, 'Error en conexión inactiva'));
    }
  }

  /**
   * Transacción con rol bck_api y contexto RLS. set_config(..., true) vale solo dentro de
   * esta transacción, así que una conexión reutilizada nunca arrastra el tenant anterior.
   */
  async scope<T>(options: ScopeOptions, fn: (db: Queryable) => Promise<T>): Promise<T> {
    const tenantId = assertScopeId(options.tenantId, 'tenantId');
    const userId = assertScopeId(options.userId, 'userId');
    return this.transaction(this.appPool, options.readOnly === true, fn, async (client) => {
      await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', [
        'app.current_tenant_id', tenantId, 'app.current_user_id', userId,
      ]);
    });
  }

  /** Igual que scope, pero toma tenant y usuario del request en curso. */
  forRequest<T>(fn: (db: Queryable) => Promise<T>, options: Pick<ScopeOptions, 'readOnly'> = {}): Promise<T> {
    const ctx = RequestContextStore.get();
    return this.scope({ tenantId: ctx?.tenantId, userId: ctx?.userId, readOnly: options.readOnly }, fn);
  }

  /** Rol bck_servicio (se salta RLS). Solo para login, cron y facturación; nunca para endpoints de negocio. */
  async service<T>(fn: (db: Queryable) => Promise<T>, options: { actorUserId?: string } = {}): Promise<T> {
    const actor = assertScopeId(options.actorUserId, 'actorUserId');
    // El actor llega a la auditoría de la base (log_actividad) aunque la operación corra con el rol de servicio.
    const setup = actor
      ? async (client: PoolClient) => { await client.query("SELECT set_config('app.current_user_id', $1, true)", [actor]); }
      : undefined;
    return this.transaction(this.servicePool, false, fn, setup);
  }

  /** Verifica que ambos roles conectan. */
  async ping(): Promise<{ app: string; service: string }> {
    const sql = 'SELECT current_user AS u';
    const [app, service] = await Promise.all([
      this.scope({ readOnly: true }, (db) => db.query<{ u: string }>(sql)),
      this.service((db) => db.query<{ u: string }>(sql)),
    ]);
    return { app: app.rows[0]!.u, service: service.rows[0]!.u };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.appPool.end(), this.servicePool.end()]);
  }

  private async transaction<T>(
    pool: Pool,
    readOnly: boolean,
    fn: (db: Queryable) => Promise<T>,
    setup?: (client: PoolClient) => Promise<void>,
  ): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      if (setup) await setup(client);
      const api: Queryable = { query: (text, params) => client.query(text, params as unknown[] | undefined) };
      const result = await fn(api);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr as Error; // la conexión quedó en estado dudoso: se descarta
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}
