import pg from 'pg';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { PoolFactory } from '../../src/db/db.service';

/**
 * Patrón probe: cada prueba corre dentro de UNA transacción, en una sola conexión, y termina en ROLLBACK.
 * La base queda exactamente como estaba (ni usuarios, ni consumos, ni eventos de seguridad).
 *
 * Cada "transacción" de DbService se vuelve un SAVEPOINT que toma el rol real de su pool (SET LOCAL ROLE bck_api o
 * bck_servicio): RLS, permisos y BYPASSRLS se comportan como en producción. Las de solo lectura se deshacen siempre
 * (ROLLBACK TO SAVEPOINT), así un intento de escritura sigue fallando con 25006.
 *
 * Necesita PROBE_DATABASE_URL: una conexión con permiso para SET ROLE a bck_api y bck_servicio (en local, el
 * superusuario del contenedor). En Neon esos roles no tienen esa membresía, así que sin esta variable las pruebas
 * probe se saltan en vez de dejar datos.
 *
 * Límites: las peticiones se serializan (una conexión) y CURRENT_TIMESTAMP queda fijo durante toda la prueba; para
 * probar ventanas de tiempo se mueven las fechas de los datos con `sql()`.
 */
export class Probe {
  private client: pg.Client | null = null;
  private tail: Promise<void> = Promise.resolve();
  private n = 0;

  private constructor(private readonly url: string) {}

  static fromEnv(): Probe | null {
    const url = process.env.PROBE_DATABASE_URL;
    return url ? new Probe(url) : null;
  }

  /** Para createApp({ poolFactory }): el rol de cada pool sale del usuario de su URL. */
  readonly factory: PoolFactory = (connectionString) => {
    const role = new URL(connectionString).username;
    if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('rol inválido en la URL');
    const pool = {
      connect: () => this.lease(role),
      on: () => pool,
      end: async () => undefined,
    };
    return pool as unknown as Pool;
  };

  async begin(): Promise<void> {
    if (this.client) throw new Error('probe ya iniciado');
    const c = new pg.Client({ connectionString: this.url });
    await c.connect();
    await c.query('BEGIN');
    this.client = c;
  }

  async rollback(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  }

  /** SQL directo con el rol privilegiado, dentro de la misma transacción (preparar datos, mover fechas). */
  async sql<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<R>> {
    const release = await this.lock();
    try {
      return await this.must().query<R>(text, params);
    } finally {
      release();
    }
  }

  private must(): pg.Client {
    if (!this.client) throw new Error('probe.begin() no se llamó');
    return this.client;
  }

  /** Una conexión lógica a la vez: si dos peticiones se cruzan, la segunda espera a que la primera termine. */
  private async lock(): Promise<() => void> {
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((r) => (release = r));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      prev,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe: transacción anidada o colgada (más de 10 s esperando la conexión)')), 10_000);
      }),
    ]).finally(() => clearTimeout(timer));
    return release;
  }

  private async lease(role: string) {
    const release = await this.lock();
    const c = this.must();
    const sp = `probe_${++this.n}`;
    let readOnly = false;
    const empty = { rows: [], rowCount: 0 };
    const reset = async () => {
      await c.query('RESET ROLE');
      await c.query("SELECT set_config('app.current_tenant_id', '', true), set_config('app.current_user_id', '', true)");
    };
    return {
      query: async (text: string, params?: unknown[]) => {
        switch (text) {
          case 'BEGIN':
          case 'BEGIN READ ONLY':
            readOnly = text === 'BEGIN READ ONLY';
            await c.query(`SAVEPOINT ${sp}`);
            if (readOnly) await c.query('SET LOCAL transaction_read_only = on');
            await c.query(`SET LOCAL ROLE ${role}`);
            return empty;
          case 'COMMIT':
            // Solo lectura: deshacer es equivalente y devuelve transaction_read_only a off.
            if (readOnly) await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            await c.query(`RELEASE SAVEPOINT ${sp}`);
            await reset();
            return empty;
          case 'ROLLBACK':
            await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
            await c.query(`RELEASE SAVEPOINT ${sp}`);
            await reset();
            return empty;
          default:
            return c.query(text, params);
        }
      },
      release: () => release(),
    };
  }
}
