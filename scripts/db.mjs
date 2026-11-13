// Runner de migraciones: dbmate con la conexión DIRECTA del dueño (DATABASE_MIGRATE_URL).
// Uso: node scripts/db.mjs <up|status|rollback|new NOMBRE|baseline>
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const url = process.env.DATABASE_MIGRATE_URL;
if (!url) {
  console.error('Falta DATABASE_MIGRATE_URL en .env (conexión directa de neondb_owner).');
  process.exit(1);
}
if (/-pooler\./.test(url)) {
  console.error('DATABASE_MIGRATE_URL debe ser la conexión DIRECTA (sin -pooler): el DDL no va por pgbouncer.');
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const BASELINE = '20261112000000';

if (cmd === 'baseline') {
  // La baseline se aplicó a mano con psql: se registra sin volver a ejecutarla.
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const t = await c.query("SELECT to_regclass('public.restaurante') AS t");
    if (!t.rows[0].t) {
      console.error('La base no tiene el esquema: aplica la baseline antes de registrarla.');
      process.exit(1);
    }
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version varchar PRIMARY KEY)');
    const r = await c.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [BASELINE]);
    console.log(r.rowCount ? `Baseline ${BASELINE} registrada.` : `Baseline ${BASELINE} ya estaba registrada.`);
  } finally {
    await c.end();
  }
  process.exit(0);
}

const dbmateArgs = { up: ['up'], status: ['status'], rollback: ['rollback'], new: ['new', ...rest] }[cmd];
if (!dbmateArgs) {
  console.error('Uso: db.mjs <up|status|rollback|new NOMBRE|baseline>');
  process.exit(1);
}
const r = spawnSync('dbmate', ['--migrations-dir', 'db/migrations', '--no-dump-schema', ...dbmateArgs], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);
