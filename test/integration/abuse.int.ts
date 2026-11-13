import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe('Cabeceras, CORS, límites y rate limit', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    process.env.CORS_ORIGINS = 'https://app.bocadoo.test,http://localhost:3001';
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => {
    delete process.env.CORS_ORIGINS;
    return app.close();
  });

  const login = (identificador: string, password: string, remoteAddress: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress, payload: { identificador, password } });

  it('helmet: cabeceras de seguridad y CSP cerrada en la API', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.60.0.1' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeTruthy();
  });

  it('/docs lleva una CSP más abierta para que cargue Swagger UI; la API no', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs', remoteAddress: '10.60.0.2' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('CORS: solo los orígenes de la lista blanca reciben permiso', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/v1/auth/login',
        remoteAddress: '10.60.0.3',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
      });
    expect((await preflight('https://app.bocadoo.test')).headers['access-control-allow-origin']).toBe('https://app.bocadoo.test');
    expect((await preflight('https://malo.example')).headers['access-control-allow-origin']).toBeUndefined();
    const simple = await app.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: '10.60.0.3',
      headers: { origin: 'https://malo.example' },
    });
    expect(simple.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('cuerpo por encima del límite (100 kB) → 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.60.0.4',
      payload: { identificador: 'a@b.co', password: 'x'.repeat(200_000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('campos extra en el body → 400; tipos incorrectos → 400', async () => {
    const extra = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '10.60.0.5',
      payload: { identificador: 'a@b.co', password: 'x', admin: true },
    });
    expect(extra.statusCode).toBe(400);
    expect(extra.headers['content-type']).toContain('application/problem+json');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          remoteAddress: '10.60.0.5',
          payload: { identificador: { $ne: '' }, password: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          remoteAddress: '10.60.0.5',
          payload: 'no-json',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('login: tras 5 intentos fallidos el sexto → 429 con Retry-After, aunque la clave sea correcta', async () => {
    const correo = `rate_${unique()}@correo.com`;
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress: '10.60.1.1',
      payload: { nombre: 'Rate Limit', correo, password: 'una-clave-larga-123', aceptaTerminos: true },
    });
    expect(reg.statusCode).toBe(201);
    const ip = '10.60.1.2';
    for (let i = 0; i < 5; i++) expect((await login(correo, 'incorrecta-123456', ip)).statusCode).toBe(401);
    const blocked = await login(correo, 'una-clave-larga-123', ip);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    // Otra IP con la misma cuenta aún puede intentar (el bloqueo es por IP + cuenta), con su propio contador.
    expect((await login(correo, 'una-clave-larga-123', '10.60.1.3')).statusCode).toBe(200);
  });

  it('login: rotar de IP contra una misma cuenta también topa (límite por cuenta)', async () => {
    const correo = `rotar_${unique()}@correo.com`;
    let blocked = 0;
    for (let i = 0; i < 30; i++) {
      const res = await login(correo, 'incorrecta-123456', `10.61.${Math.floor(i / 250)}.${(i % 250) + 1}`);
      if (res.statusCode === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it('registro: más de 10 por IP y hora → 429', async () => {
    const ip = '10.60.2.1';
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: ip, payload: { nombre: 'x' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true); // el límite cuenta aunque la validación falle
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('límite general por IP: 121 peticiones en un minuto → 429', async () => {
    const ip = '10.60.3.1';
    let last = 200;
    for (let i = 0; i < 121; i++) last = (await app.inject({ method: 'GET', url: '/health', remoteAddress: ip })).statusCode;
    expect(last).toBe(429);
  });

  it('Swagger muestra el candado solo en los endpoints protegidos', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/docs-json', remoteAddress: '10.60.4.1' })).json();
    expect(doc.paths['/v1/auth/me'].get.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/v1/auth/logout-all'].post.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/v1/auth/login'].post.security).toBeUndefined();
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});

describe('Swagger apagado', () => {
  it('con SWAGGER_ENABLED=false /docs no existe', async () => {
    process.env.SWAGGER_ENABLED = 'false';
    const app = await createApp();
    try {
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      expect((await app.inject({ method: 'GET', url: '/docs', remoteAddress: '10.62.0.1' })).statusCode).toBe(404);
    } finally {
      delete process.env.SWAGGER_ENABLED;
      await app.close();
    }
  });
});
