import { Controller, Get, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { Public } from '../src/authz/public.decorator';
import { loadEnv } from '../src/config/env';

@Public()
@Controller('t-ip')
class IpController {
  @Get()
  ip(@Req() req: FastifyRequest) {
    return { ip: req.ip };
  }
}

describe('TRUST_PROXY_HOPS', () => {
  let app: NestFastifyApplication | undefined;
  afterEach(async () => {
    delete process.env.TRUST_PROXY_HOPS;
    delete process.env.RATE_LIMIT_MAX;
    await app?.close();
    app = undefined;
  });

  async function start(hops: string, rateMax?: string) {
    process.env.TRUST_PROXY_HOPS = hops;
    if (rateMax) process.env.RATE_LIMIT_MAX = rateMax;
    app = await createApp({ controllers: [IpController] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return (xff: string) => app!.inject({ method: 'GET', url: '/t-ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': xff } });
  }

  it('con 3 saltos, request.ip es el cliente y cada IP tiene su propio contador', async () => {
    const get = await start('3', '2');
    expect((await get('203.0.113.7, 172.70.0.1, 10.0.0.5')).json().ip).toBe('203.0.113.7');
    expect((await get('203.0.113.7, 172.70.0.1, 10.0.0.5')).statusCode).toBe(200);
    expect((await get('203.0.113.7, 172.70.0.1, 10.0.0.5')).statusCode).toBe(429); // 3.ª del mismo cliente
    const otro = await get('198.51.100.9, 172.70.0.1, 10.0.0.5');
    expect(otro.statusCode).toBe(200); // otro cliente: contador aparte
    expect(otro.json().ip).toBe('198.51.100.9');
  });

  it('una cabecera falsificada antepuesta no cambia request.ip ni libera el contador', async () => {
    const get = await start('3', '2');
    const real = '203.0.113.7, 172.70.0.1, 10.0.0.5';
    expect((await get(`1.2.3.4, ${real}`)).json().ip).toBe('203.0.113.7');
    expect((await get(`5.6.7.8, ${real}`)).statusCode).toBe(200);
    expect((await get(`9.9.9.9, ${real}`)).statusCode).toBe(429); // sigue siendo el mismo cliente
  });

  it('con TRUST_PROXY_HOPS=0 se ignora x-forwarded-for', async () => {
    const get = await start('0');
    expect((await get('203.0.113.7, 172.70.0.1, 10.0.0.5')).json().ip).toBe('127.0.0.1');
  });
});

describe('loadEnv: TRUST_PROXY_HOPS', () => {
  const base = { DATABASE_URL: 'postgresql://a:b@h/db', DATABASE_SERVICE_URL: 'postgresql://c:d@h/db' } as NodeJS.ProcessEnv;
  const prod = { ...base, NODE_ENV: 'production', JWT_PRIVATE_KEY: 'x', QR_SECRET_KEY: 'y' } as NodeJS.ProcessEnv;

  it('por defecto: 0 en desarrollo y test, 3 en producción', () => {
    expect(loadEnv(base).TRUST_PROXY_HOPS).toBe(0);
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).TRUST_PROXY_HOPS).toBe(0);
    expect(loadEnv(prod).TRUST_PROXY_HOPS).toBe(3);
    expect(loadEnv({ ...prod, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS).toBe(3);
  });
  it('acepta 0-5 y rechaza lo demás', () => {
    expect(loadEnv({ ...prod, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    expect(loadEnv({ ...base, TRUST_PROXY_HOPS: '5' }).TRUST_PROXY_HOPS).toBe(5);
    for (const v of ['6', '-1', '1.5', 'true', 'abc']) expect(() => loadEnv({ ...base, TRUST_PROXY_HOPS: v })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
