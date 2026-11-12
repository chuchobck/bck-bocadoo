import 'dotenv/config';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Pruebas de integración: usan las URLs reales de .env (Neon o un Postgres 16 local).
export default defineConfig({
  test: { globals: true, root: '.', include: ['test/integration/**/*.int.ts'], testTimeout: 20_000, fileParallelism: false },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
