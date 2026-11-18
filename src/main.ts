import 'reflect-metadata';
import 'dotenv/config';
import { createApp } from './app.factory';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await createApp();
  // SIGTERM/SIGINT → app.close(): cierra las conexiones SSE y los pools antes de salir.
  app.enableShutdownHooks();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}
void bootstrap();
