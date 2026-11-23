import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.factory';

describe('Logs sin datos personales', () => {
  let app: NestFastifyApplication;
  const lines: unknown[][] = [];
  beforeAll(async () => {
    app = await createApp();
    vi.spyOn(app.get(Logger), 'log').mockImplementation((...args: unknown[]) => void lines.push(args));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  it('la línea de log lleva ruta sin query, requestId, método, status y duración; el teléfono de ?q= no aparece', async () => {
    const res = await app.inject({ method: 'GET', url: '/health?q=0991234567&correo=ana@correo.com', remoteAddress: '10.90.0.1' });
    const entry = lines.find((l) => (l[0] as { requestId?: string }).requestId === res.headers['x-request-id']);
    expect(entry).toBeDefined();
    const [fields, msg] = entry as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ url: '/health', method: 'GET', statusCode: res.statusCode, requestId: res.headers['x-request-id'] });
    expect(typeof fields.ms).toBe('number');
    const serializado = JSON.stringify([fields, msg]);
    expect(serializado).not.toContain('0991234567');
    expect(serializado).not.toContain('ana@correo.com');
    expect(serializado).not.toContain('?');
  });
});
