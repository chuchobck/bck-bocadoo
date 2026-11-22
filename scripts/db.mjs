// Runner de migraciones: dbmate con la conexión DIRECTA del dueño (DATABASE_MIGRATE_URL).
// Uso: node scripts/db.mjs <up|status|rollback|new NOMBRE|baseline> [--remoto]
//
// Siempre imprime el host de destino. Si no es local (Neon), exige --remoto, se niega con cambios sin commitear en
// db/migrations y pide escribir el host para confirmar. No exige estar en main: la migración se aplica a Neon desde la
// rama, antes del merge. En local corre sin banderas. Detalle en docs/pruebas.md.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { askHost, describeTarget, hostsOf, isLocalHost, neonTenantId } from './db-guard.mjs';

const args = process.argv.slice(2);
const remoto = args.includes('--remoto');
const [cmd, ...rest] = args.filter((a) => a !== '--remoto');
const BASELINE = '20261112000000';

const dbmateArgs = { up: ['up'], status: ['status'], rollback: ['rollback'], new: ['new', ...rest] }[cmd];
if (!dbmateArgs && cmd !== 'baseline') {
  console.error('Uso: db.mjs <up|status|rollback|new NOMBRE|baseline> [--remoto]');
  process.exit(1);
}

const url = process.env.DATABASE_MIGRATE_URL;
if (!url) {
  console.error('Falta DATABASE_MIGRATE_URL (en .env para Neon, o inline para la base local; ver docs/pruebas.md).');
  process.exit(1);
}

let hosts;
try {
  hosts = hostsOf(url);
} catch (err) {
  console.error(`DATABASE_MIGRATE_URL ilegible: ${err.message}`);
  process.exit(1);
}
const local = hosts.length > 0 && hosts.every(isLocalHost);
console.log(`Destino: ${describeTarget(url)} (${local ? 'local' : 'REMOTO'})`);

if (cmd === 'new') {
  // `dbmate new` solo crea el archivo: no se conecta, así que no se le pasa la URL.
  const r = spawnSync('dbmate', ['--migrations-dir', 'db/migrations', 'new', ...rest], { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}

if (/-pooler\./.test(url)) {
  console.error('DATABASE_MIGRATE_URL debe ser la conexión DIRECTA (sin -pooler): el DDL no va por pgbouncer.');
  process.exit(1);
}

if (local) {
  // Un túnel a Neon en localhost pasaría el chequeo de host: Neon define neon.tenant_id.
  let tenant;
  try {
    tenant = await neonTenantId(pg, url);
  } catch (err) {
    console.error(`No se pudo conectar con la base local: ${err.message}. ¿Está corriendo? (docker start bocadoo-test-pg)`);
    process.exit(1);
  }
  if (tenant) {
    console.error(`Negado: el host es local pero el servidor es Neon (neon.tenant_id=${tenant}). Usa la URL real con --remoto.`);
    process.exit(1);
  }
} else {
  const host = hosts.find((h) => !isLocalHost(h));
  if (!remoto) {
    console.error(`Negado: ${host} no es local. Para operar sobre él, repite el comando con --remoto.`);
    process.exit(1);
  }
  const git = spawnSync('git', ['status', '--porcelain', '--', 'db/migrations'], { encoding: 'utf8' });
  if (git.status !== 0) {
    console.error('Negado: no se pudo revisar db/migrations con git status.');
    process.exit(1);
  }
  if (git.stdout.trim()) {
    console.error('Negado: hay cambios sin commitear en db/migrations (lo que se aplica tiene que ser lo que se revisa):');
    console.error(git.stdout.trimEnd());
    process.exit(1);
  }
  const typed = await askHost(`Vas a correr "${cmd}" sobre ${host}. Escribe el host para confirmar: `);
  if (typed !== host) {
    console.error('Negado: el host escrito no coincide. No se hizo nada.');
    process.exit(1);
  }
}

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

const r = spawnSync('dbmate', ['--migrations-dir', 'db/migrations', '--no-dump-schema', ...dbmateArgs], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);
