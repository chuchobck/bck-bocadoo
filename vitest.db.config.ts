import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Pruebas de integración: SOLO contra un Postgres local (bocadoo-test-pg o el servicio de CI). No lee .env: las URLs
// llegan del entorno (`pnpm test:db:local` las pone) y global-setup.ts aborta si alguna apunta fuera de esta máquina o
// si el servidor resulta ser Neon. Ver docs/pruebas.md.
export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['test/integration/**/*.int.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 20_000,
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
