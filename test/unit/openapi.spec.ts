import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';

/** El contrato para frontend (docs/openapi.json) sale del código: si cambia un endpoint o un DTO, hay que regenerarlo. */
describe('OpenAPI', () => {
  let app: NestFastifyApplication;
  let doc: { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { $ref?: string } }> } }>> };
  beforeAll(async () => {
    process.env.SWAGGER_ENABLED = 'true';
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    doc = (await app.inject({ method: 'GET', url: '/docs-json' })).json();
  });
  afterAll(() => app.close());

  it('docs/openapi.json está al día (pnpm openapi:export)', () => {
    const committed = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(doc).toEqual(committed);
  });

  it('dos DTO con el mismo nombre no se pisan en Swagger', () => {
    const body = (path: string) => doc.paths[path]!.post!.requestBody!.content['application/json']!.schema.$ref;
    expect(body('/v1/restaurante/mesas')).not.toBe(body('/v1/mis/mesas'));
  });
});
