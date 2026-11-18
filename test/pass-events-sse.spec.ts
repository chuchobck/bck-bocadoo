import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { TokenService } from '../src/auth/token.service';
import { PassEventBus, type CanjeRegistrado } from '../src/pass-events/bus';
import { PassStreamHub } from '../src/pass-events/stream';

/**
 * GET /v1/pase/eventos sobre HTTP real (puerto efímero): `inject` espera el fin de la respuesta y no sirve para un
 * stream. No usa base de datos: el guard JWT solo verifica la firma.
 */
interface Stream {
  res: IncomingMessage;
  text: () => string;
  /** Espera hasta que lo recibido contenga `s`. */
  until: (s: string) => Promise<void>;
  ended: Promise<void>;
  close: () => void;
}

describe('GET /v1/pase/eventos (SSE)', () => {
  let app: NestFastifyApplication;
  let port: number;
  let tokens: TokenService;
  let bus: PassEventBus;
  const open: Stream[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.getHttpServer().address() as AddressInfo).port;
    tokens = app.get(TokenService);
    bus = app.get(PassEventBus);
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await app.close();
  });

  const user = async (uid: string) => tokens.signAccess({ sub: randomUUID(), uid });

  function connect(token?: string): Promise<Stream> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/v1/pase/eventos', headers: token ? { authorization: `Bearer ${token}` } : {} },
        (res) => {
          let buf = '';
          const waiters: Array<() => void> = [];
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            buf += c;
            waiters.splice(0).forEach((w) => w());
          });
          const ended = new Promise<void>((r) => res.on('close', () => r()));
          const until = async (s: string) => {
            const deadline = Date.now() + 2_000;
            while (!buf.includes(s)) {
              if (Date.now() > deadline) throw new Error(`no llegó ${JSON.stringify(s)}; recibido: ${JSON.stringify(buf)}`);
              await new Promise<void>((r) => {
                waiters.push(r);
                setTimeout(r, 50);
              });
            }
          };
          const stream = { res, text: () => buf, until, ended, close: () => req.destroy() };
          open.push(stream);
          resolve(stream);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  const evento = (consumoId: string): CanjeRegistrado => ({
    tipo: 'CANJE_REGISTRADO',
    consumoId,
    restauranteNombre: 'La Sazón',
    saldoRestante: 4,
    platoNombre: null,
    hora: new Date().toISOString(),
  });

  it('sin token → 401 problem+json (nunca abre el stream)', async () => {
    const s = await connect();
    expect(s.res.statusCode).toBe(401);
    expect(s.res.headers['content-type']).toContain('application/problem+json');
  });

  it('cabeceras SSE: text/event-stream, no-store, sin buffering; trae x-request-id', async () => {
    const s = await connect(await user('1001'));
    expect(s.res.statusCode).toBe(200);
    expect(s.res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.res.headers['cache-control']).toBe('no-store');
    expect(s.res.headers['x-accel-buffering']).toBe('no');
    expect(s.res.headers['x-request-id']).toBeTruthy();
    await s.until('retry: 5000\n');
    s.close();
  });

  it('el evento llega solo al comensal del token, no a otro conectado', async () => {
    const a = await connect(await user('2001'));
    const b = await connect(await user('2002'));
    await a.until(': conectado');
    await b.until(': conectado');
    bus.publish('2001', evento('para-a'));
    await a.until('"consumoId":"para-a"');
    expect(a.text()).toContain('event: CANJE_REGISTRADO\n');
    bus.publish('2002', evento('para-b'));
    await b.until('"consumoId":"para-b"');
    expect(b.text()).not.toContain('para-a');
    expect(a.text()).not.toContain('para-b');
    a.close();
    b.close();
  });

  it('la 3.ª conexión del mismo usuario cierra la más vieja; cerrar el socket libera el lugar', async () => {
    const hub = app.get(PassStreamHub);
    const token = await user('3001');
    const s1 = await connect(token);
    await s1.until(': conectado');
    const s2 = await connect(token);
    await s2.until(': conectado');
    const s3 = await connect(token);
    await s1.until('"motivo":"REEMPLAZADA"');
    await s1.ended;
    await s3.until(': conectado');
    expect(hub.connectionsOf('3001')).toBe(2);
    s2.close();
    s3.close();
    await Promise.all([s2.ended, s3.ended]);
    await expect.poll(() => hub.connectionsOf('3001')).toBe(0);
    await expect.poll(() => bus.listenerCount('3001')).toBe(0);
  });
});
