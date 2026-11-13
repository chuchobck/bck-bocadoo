import type { DbService, Queryable } from '../db/db.service';

export const JOBS = ['expire-plans', 'create-partitions'] as const;
export type JobName = (typeof JOBS)[number];

/** Tablas particionadas por mes (ver baseline: fn_crear_particion_mensual). */
export const PARTITIONED_TABLES = ['log_actividad', 'evento_analitica'] as const;
export const DEFAULT_MONTHS_AHEAD = 3;
export const MAX_MONTHS_AHEAD = 12;

export interface ExpirePlansResult {
  job: 'expire-plans';
  ok: true;
  omitido?: 'EN_EJECUCION';
  /** Planes que pasaron de ACTIVA a VENCIDA en esta corrida. */
  vencidos: number;
}
export interface CreatePartitionsResult {
  job: 'create-partitions';
  ok: boolean;
  omitido?: 'EN_EJECUCION';
  creadas: string[];
  existentes: string[];
  errores: { particion: string; error: string }[];
}
export type JobResult = ExpirePlansResult | CreatePartitionsResult;

/**
 * Candado de la corrida: si Render dispara el cron dos veces a la vez, la segunda copia ve el candado tomado y se
 * salta (no espera ni duplica). Es un candado de transacción: se suelta solo al terminar o si el proceso muere.
 */
export const jobLockKey = (job: JobName) => `bocadoo:job:${job}`;

async function tryLock(q: Queryable, job: JobName): Promise<boolean> {
  const r = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [jobLockKey(job)]);
  return r.rows[0]!.ok;
}

/**
 * Vence los planes ACTIVA cuyo último día ya pasó, con el día local de CADA restaurante (`fn_vencer_suscripciones`).
 * Idempotente: solo toca planes ACTIVA, así que una segunda corrida seguida devuelve 0 y no cambia nada.
 */
export async function expirePlans(q: Queryable): Promise<ExpirePlansResult> {
  if (!(await tryLock(q, 'expire-plans'))) return { job: 'expire-plans', ok: true, omitido: 'EN_EJECUCION', vencidos: 0 };
  const r = await q.query<{ n: number }>('SELECT fn_vencer_suscripciones() AS n');
  return { job: 'expire-plans', ok: true, vencidos: r.rows[0]!.n };
}

/**
 * Crea las particiones mensuales (mes actual + `monthsAhead`) de `log_actividad` y `evento_analitica`. Los meses se
 * miden en UTC. Idempotente: una partición que ya existe se informa en `existentes` y no se toca. Si una no se puede
 * crear (por ejemplo, porque la partición DEFAULT ya tiene filas de ese mes) se informa en `errores`, se sigue con
 * las demás y `ok` queda en false para que el cron falle a la vista.
 */
export async function createPartitions(q: Queryable, monthsAhead = DEFAULT_MONTHS_AHEAD): Promise<CreatePartitionsResult> {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > MAX_MONTHS_AHEAD)
    throw new RangeError(`monthsAhead debe ser un entero de 0 a ${MAX_MONTHS_AHEAD}`);
  const result: CreatePartitionsResult = { job: 'create-partitions', ok: true, creadas: [], existentes: [], errores: [] };
  if (!(await tryLock(q, 'create-partitions'))) return { ...result, omitido: 'EN_EJECUCION' };

  // Los límites de una partición son timestamptz: se interpretan en la zona de la sesión, así que se fija UTC.
  const previous = (await q.query<{ tz: string }>('SHOW TimeZone')).rows[0]!.tz;
  await q.query("SELECT set_config('TimeZone', 'UTC', true)");
  try {
    const months = await q.query<{ month: string; suffix: string }>(
      `SELECT m::date::text AS month, to_char(m, 'YYYY_MM') AS suffix
         FROM generate_series(date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
                              date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + make_interval(months => $1),
                              interval '1 month') AS m`,
      [monthsAhead],
    );
    for (const table of PARTITIONED_TABLES) {
      for (const { month, suffix } of months.rows) {
        const name = `${table}_${suffix}`;
        const exists = await q.query<{ e: boolean }>('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${name}`]);
        if (exists.rows[0]!.e) {
          result.existentes.push(name);
          continue;
        }
        await q.query('SAVEPOINT crear_particion');
        try {
          await q.query('SELECT fn_crear_particion_mensual($1, $2::date)', [table, month]);
          await q.query('RELEASE SAVEPOINT crear_particion');
          result.creadas.push(name);
        } catch (err) {
          await q.query('ROLLBACK TO SAVEPOINT crear_particion');
          await q.query('RELEASE SAVEPOINT crear_particion');
          result.errores.push({ particion: name, error: (err as Error).message });
        }
      }
    }
  } finally {
    await q.query("SELECT set_config('TimeZone', $1, true)", [previous]);
  }
  result.ok = result.errores.length === 0;
  return result;
}

/** Corre un job en su propia transacción con el rol de servicio (uso permitido de `service()`: cron). */
export function runJob(db: DbService, job: JobName, opts: { monthsAhead?: number } = {}): Promise<JobResult> {
  return db.service<JobResult>((q) => (job === 'expire-plans' ? expirePlans(q) : createPartitions(q, opts.monthsAhead)));
}
