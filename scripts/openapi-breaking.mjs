#!/usr/bin/env node
// Detecta cambios incompatibles entre el contrato de la rama base (por defecto origin/main) y docs/openapi.json.
// Uso: pnpm openapi:breaking [rama-base]   (necesita Docker: corre la imagen tufin/oasdiff)
// Falla (código 1) ante cualquier cambio que rompa a un cliente existente: ruta o campo quitado, tipo cambiado,
// campo nuevo obligatorio, respuesta de éxito quitada…
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'origin/main';
const dir = mkdtempSync(join(tmpdir(), 'oasdiff-'));

let baseSpec;
try {
  baseSpec = execFileSync('git', ['show', `${base}:docs/openapi.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch {
  console.log(`${base} todavía no tiene docs/openapi.json: no hay contra qué comparar.`);
  process.exit(0);
}
writeFileSync(join(dir, 'base.json'), baseSpec);
copyFileSync('docs/openapi.json', join(dir, 'actual.json'));

const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${dir}:/specs:ro`,
    'tufin/oasdiff:latest',
    'breaking',
    '/specs/base.json',
    '/specs/actual.json',
    '--fail-on',
    'ERR',
  ],
  { stdio: 'inherit' },
);
if (run.error) {
  console.error('No se pudo ejecutar Docker:', run.error.message);
  process.exit(2);
}
process.exit(run.status ?? 1);
