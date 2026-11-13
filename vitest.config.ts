import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['test/**/*.spec.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      DATABASE_SERVICE_URL: 'postgresql://u:p@localhost:5432/db',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
