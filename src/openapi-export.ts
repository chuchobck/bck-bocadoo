import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Escribe docs/openapi.json: el mismo documento que sirve GET /docs-json. No necesita base de datos (los pools de pg
 * conectan al primer uso y aquí nunca se usan) ni lee `.env`: fija variables ficticias para que la salida sea
 * reproducible y no dependa de la máquina.
 */
async function main(): Promise<void> {
  Object.assign(process.env, {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'true',
    DATABASE_URL: 'postgresql://export:export@127.0.0.1:1/export',
    DATABASE_SERVICE_URL: 'postgresql://export:export@127.0.0.1:1/export',
  });
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.QR_SECRET_KEY;

  // Import tardío: createApp lee el entorno al cargarse la configuración.
  const { createApp } = await import('./app.factory');
  const app = await createApp();
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const res = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/docs-json' });
    if (res.statusCode !== 200) throw new Error(`/docs-json respondió ${res.statusCode}`);
    const out = resolve(process.argv[2] ?? 'docs/openapi.json');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(JSON.parse(res.body), null, 2)}\n`);
    process.stdout.write(`OpenAPI escrito en ${out}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
