import 'reflect-metadata';
import 'dotenv/config';
import { loadEnv } from '../config/env';
import { DbService } from '../db/db.service';
import { DEFAULT_MONTHS_AHEAD, JOBS, MAX_MONTHS_AHEAD, runJob, type JobName, type JobResult } from './jobs';

const USAGE = `Uso: node dist/jobs/cli.js <job> [--months-ahead=N]

Jobs (idempotentes: correrlos dos veces no duplica nada):
  expire-plans        Vence los planes cuyo último día ya pasó (día local de cada restaurante)
  create-partitions   Crea las particiones mensuales de log_actividad y evento_analitica
  all                 Los dos, en ese orden

Opciones:
  --months-ahead=N    Meses por adelantado para create-partitions (0 a ${MAX_MONTHS_AHEAD}, por defecto ${DEFAULT_MONTHS_AHEAD})

Salida: una línea JSON por job. Código de salida: 0 todo bien, 1 algún job falló, 2 uso incorrecto.
Usa DATABASE_SERVICE_URL (rol bck_servicio). Sobre las bases de pruebas, apunta las variables a ellas.`;

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Entrada del cron: separada de `main` para poder probarla sin lanzar un proceso. Devuelve el código de salida. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [job, ...flags] = argv;
  let monthsAhead = DEFAULT_MONTHS_AHEAD;
  const selected: readonly JobName[] | null = job === 'all' ? JOBS : JOBS.find((j) => j === job) ? [job as JobName] : null;
  if (!selected) {
    io.err(USAGE);
    return 2;
  }
  for (const f of flags) {
    const m = /^--months-ahead=(\d+)$/.exec(f);
    if (!m || Number(m[1]) > MAX_MONTHS_AHEAD) {
      io.err(`Opción inválida: ${f}\n\n${USAGE}`);
      return 2;
    }
    monthsAhead = Number(m[1]);
  }

  const db = new DbService(loadEnv(env));
  let code = 0;
  try {
    for (const name of selected) {
      const t0 = Date.now();
      let result: JobResult | { job: JobName; ok: false; error: string };
      try {
        result = await runJob(db, name, { monthsAhead });
      } catch (err) {
        result = { job: name, ok: false, error: (err as Error).message };
      }
      if (!result.ok) code = 1;
      io.out(JSON.stringify({ ...result, duracionMs: Date.now() - t0 }));
    }
  } finally {
    await db.onModuleDestroy();
  }
  return code;
}

if (require.main === module) {
  runCli(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }));
      process.exit(1);
    },
  );
}
