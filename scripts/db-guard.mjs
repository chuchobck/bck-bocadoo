// Barreras para que las pruebas y los scripts no toquen Neon por accidente (docs/pruebas.md).
//
// El host se decide PARSEANDO la URL igual que la parsea pg (new URL + el parámetro `host` de la query, que pisa al
// host de la URL), nunca buscando texto: `postgresql://u@ep-x.neon.tech/db?x=localhost:55432` contiene "localhost"
// y apunta a Neon.
//
// Uso como CLI (lo llama scripts/test-db-local.sh): `node scripts/db-guard.mjs check` sale con 1 si alguna variable
// de conexión (DATABASE_*, PROBE_*, PGHOST, PGHOSTADDR) apunta fuera de esta máquina.
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

/** Variables de entorno que deciden a qué servidor se conectan las pruebas y los scripts. */
export function isDbEnvKey(key) {
  return /^(DATABASE_|PROBE_)/.test(key) || key === 'PGHOST' || key === 'PGHOSTADDR';
}

/** ¿Este host es esta máquina? localhost, 127.0.0.0/8, ::1 (también mapeada a IPv4) o un socket Unix (ruta absoluta). */
export function isLocalHost(raw) {
  if (typeof raw !== 'string') return false;
  const h = raw
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  if (h === '') return false;
  if (h.startsWith('/')) return true;
  if (h === 'localhost') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return h.split('.').every((o) => Number(o) <= 255);
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // ::ffff:127.0.0.1 (new URL la normaliza a ::ffff:7f00:1)
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isLocalHost(h.slice(7));
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)) return true;
  return false;
}

/**
 * Hosts a los que puede ir una cadena de conexión. Es una lista porque pg usa `?host=` si viene y si no el host de la
 * URL (y libpq acepta varios separados por coma); se revisan todos. Lanza si la cadena no se puede parsear.
 */
export function hostsOf(connectionString) {
  const s = String(connectionString).trim();
  // Socket Unix en la forma corta de pg: "/var/run/postgresql nombre_db".
  if (s.startsWith('/')) return [s.split(' ')[0]];
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('no es una URL de conexión válida');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`protocolo no admitido (${u.protocol})`);
  const out = [];
  const add = (v) => {
    for (const part of v.split(',')) {
      const p = part.trim();
      if (p) out.push(p);
    }
  };
  let hostname = u.hostname;
  try {
    hostname = decodeURIComponent(hostname);
  } catch {
    /* se revisa tal cual */
  }
  // Varios hosts sin puerto (h1,h2) quedan juntos en hostname; con puertos (h1:5432,h2:5432) new URL ya lanzó arriba.
  add(hostname);
  for (const key of ['host', 'hostaddr']) for (const v of u.searchParams.getAll(key)) add(v);
  return out;
}

/** Para mostrar: host[:puerto]/base, sin usuario ni contraseña. */
export function describeTarget(connectionString) {
  const s = String(connectionString).trim();
  if (s.startsWith('/')) return `socket ${s.split(' ')[0]}`;
  try {
    const u = new URL(s);
    const extra = u.searchParams.get('host');
    const base = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
    return extra ? `${base} (host=${extra})` : base;
  } catch {
    return '(URL ilegible)';
  }
}

/** Variables de conexión que NO apuntan a esta máquina: [{ key, motivo }]. Nunca incluye la contraseña. */
export function nonLocalDbTargets(env) {
  const bad = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isDbEnvKey(key) || value === undefined || value === '') continue;
    if (key === 'PGHOST' || key === 'PGHOSTADDR') {
      const hosts = value
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      const remote = hosts.filter((h) => !isLocalHost(h));
      if (remote.length) bad.push({ key, motivo: `host ${remote.join(', ')}` });
      continue;
    }
    // DATABASE_* y PROBE_* que no son URLs (p. ej. un DATABASE_POOL_MAX) no deciden el destino.
    if (!/^(postgres(ql)?:|\/)/i.test(value.trim())) continue;
    let hosts;
    try {
      hosts = hostsOf(value);
    } catch (err) {
      bad.push({ key, motivo: err.message });
      continue;
    }
    if (hosts.length === 0) bad.push({ key, motivo: 'sin host explícito' });
    const remote = hosts.filter((h) => !isLocalHost(h));
    if (remote.length) bad.push({ key, motivo: `host ${remote.join(', ')}` });
  }
  return bad;
}

/**
 * Segunda barrera, ya conectados: Neon define `neon.tenant_id` (un túnel o port-forward a Neon en localhost pasaría el
 * chequeo de host). Devuelve el tenant o null. Recibe el módulo pg para no cargarlo cuando no hace falta.
 */
export async function neonTenantId(pg, connectionString) {
  const c = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await c.connect();
  try {
    const r = await c.query("SELECT current_setting('neon.tenant_id', true) AS t");
    const t = r.rows[0]?.t;
    return t ? String(t) : null;
  } finally {
    await c.end();
  }
}

/** Pregunta por stdin y devuelve lo escrito (sin espacios). Si stdin se cierra sin respuesta (script, </dev/null), ''. */
export async function askHost(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await new Promise((resolve) => {
    rl.once('close', () => resolve(''));
    rl.question(prompt).then(
      (a) => resolve(a.trim()),
      () => resolve(''),
    );
  });
  rl.close();
  return typed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== 'check') {
    console.error('Uso: node scripts/db-guard.mjs check');
    process.exit(2);
  }
  const bad = nonLocalDbTargets(process.env);
  if (bad.length) {
    console.error('ABORTADO: estas variables apuntan fuera de esta máquina (¿Neon?):');
    for (const b of bad) console.error(`  ${b.key}: ${b.motivo}`);
    process.exit(1);
  }
}
