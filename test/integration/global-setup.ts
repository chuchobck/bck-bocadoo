import pg from 'pg';
import { describeTarget, isDbEnvKey, neonTenantId, nonLocalDbTargets } from '../../scripts/db-guard.mjs';

/**
 * Corre una vez, antes de cualquier suite de `pnpm test:db`, en el proceso principal de vitest (los workers heredan este
 * mismo entorno). Aborta toda la corrida si alguna conexión podría ir a Neon. Detalle en docs/pruebas.md.
 */
export default async function setup(): Promise<void> {
  // 1) Host parseado de cada variable de conexión: todas deben ser de esta máquina.
  const bad = nonLocalDbTargets(process.env);
  if (bad.length) {
    throw new Error(
      `ABORTADO: las pruebas de integración solo corren contra un Postgres local. Apuntan fuera:\n` +
        bad.map((b) => `  ${b.key}: ${b.motivo}`).join('\n') +
        `\nUsa \`pnpm test:db:local\` (bocadoo-test-pg) o exporta URLs a localhost.`,
    );
  }
  for (const key of ['DATABASE_URL', 'DATABASE_SERVICE_URL']) {
    if (!process.env[key]) {
      throw new Error(`ABORTADO: falta ${key}. Este config no lee .env: usa \`pnpm test:db:local\` o exporta las URLs locales.`);
    }
  }

  // 2) Ya conectados: un túnel a Neon en localhost pasaría el chequeo de host, pero Neon define neon.tenant_id.
  const urls = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (isDbEnvKey(key) && value && /^postgres(ql)?:/i.test(value.trim())) urls.set(value, key);
  }
  for (const [url, key] of urls) {
    let tenant: string | null;
    try {
      tenant = await neonTenantId(pg, url);
    } catch (err) {
      throw new Error(
        `No se pudo conectar con ${key} (${describeTarget(url)}): ${(err as Error).message}. ` +
          `¿Está corriendo bocadoo-test-pg? (docker start bocadoo-test-pg)`,
        { cause: err },
      );
    }
    if (tenant) throw new Error(`ABORTADO: ${key} (${describeTarget(url)}) es un servidor de Neon (neon.tenant_id=${tenant}).`);
  }
  if (!process.env.PROBE_DATABASE_URL) {
    console.warn('Aviso: sin PROBE_DATABASE_URL se saltan las suites probe y las de concurrencia.');
  }
}
