import { HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { RateLimitGuard, UserRateLimitGuard } from '../../src/security/rate-limit';

const base = { DATABASE_URL: 'postgresql://a:b@h/db', DATABASE_SERVICE_URL: 'postgresql://a:b@h/db' };
const env = loadEnv({ ...base, RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_WINDOW_SECONDS: '900' } as NodeJS.ProcessEnv);

const reflector = (preset: string | undefined): Reflector => ({ getAllAndOverride: () => preset }) as unknown as Reflector;

/** Contexto mínimo: lo único que RateLimitGuard mira es ip, body y las cabeceras de la respuesta. */
function ctxFor(ip: string, body: unknown = {}) {
  const req = { ip, body };
  const headers: Record<string, string> = {};
  const reply = { header: (name: string, value: string) => (headers[name] = value) };
  return {
    ctx: {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    headers,
  };
}

const buckets = (g: RateLimitGuard) => (g as unknown as { buckets: Map<string, unknown> }).buckets;

describe('RateLimitGuard', () => {
  it('deja pasar hasta el tope global y bloquea con Retry-After después', () => {
    const guard = new RateLimitGuard(reflector(undefined), env);
    const { ctx } = ctxFor('1.2.3.4');
    for (let i = 0; i < 3; i++) expect(guard.canActivate(ctx)).toBe(true);
    const { ctx: fourth, headers } = ctxFor('1.2.3.4');
    expect(() => guard.canActivate(fourth)).toThrow(HttpException);
    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
    // Otra IP tiene su propio contador.
    expect(guard.canActivate(ctxFor('5.6.7.8').ctx)).toBe(true);
  });

  it('con el tope global ya excedido, no mira ni crea las claves del preset (el ataque del hallazgo ALTO)', () => {
    const guard = new RateLimitGuard(reflector('auth'), env);
    const ip = '9.9.9.9';
    // Agota el tope global (3) de esta IP.
    for (let i = 0; i < 3; i++) guard.canActivate(ctxFor(ip, { identificador: `real${i}@correo.com` }).ctx);
    const before = buckets(guard).size;
    // 200 peticiones más, cada una con un identificador distinto: antes del arreglo, cada una creaba
    // hasta dos claves nuevas (a:ip:id y c:id) aunque todas fueran a dar 429 por el tope global.
    for (let i = 0; i < 200; i++) {
      expect(() => guard.canActivate(ctxFor(ip, { identificador: `atacante${i}@correo.com` }).ctx)).toThrow(HttpException);
    }
    expect(buckets(guard).size).toBe(before);
  });

  it('un identificador real sigue limitándose por su cuenta cuando el tope global no se ha excedido', () => {
    const guard = new RateLimitGuard(reflector('auth'), env);
    const id = 'victima@correo.com';
    const ip = '10.0.0.1';
    // AUTH_RATE_LIMIT_MAX = 2 por IP+cuenta: dos intentos pasan (el tope global de esta prueba es 3, no interfiere),
    // el tercero debe bloquear por el preset (a:ip:id), no por el global.
    expect(guard.canActivate(ctxFor(ip, { identificador: id }).ctx)).toBe(true);
    expect(guard.canActivate(ctxFor(ip, { identificador: id }).ctx)).toBe(true);
    expect(() => guard.canActivate(ctxFor(ip, { identificador: id }).ctx)).toThrow(HttpException);
    // Por cuenta (c:id), sin importar la IP: max = AUTH_RATE_LIMIT_MAX * 4 = 8 intentos antes de bloquear.
    const guard2 = new RateLimitGuard(reflector('auth'), env);
    for (let i = 0; i < 8; i++) expect(guard2.canActivate(ctxFor(`10.1.0.${i}`, { identificador: id }).ctx)).toBe(true);
    expect(() => guard2.canActivate(ctxFor('10.1.0.9', { identificador: id }).ctx)).toThrow(HttpException);
  });

  it('nunca guarda más de MAX_ENTRIES claves, aunque lleguen decenas de miles de IPs distintas (botnet)', () => {
    const guard = new RateLimitGuard(reflector(undefined), env);
    const MAX_ENTRIES = 100_000; // debe coincidir con la constante privada de rate-limit.ts
    for (let i = 0; i < MAX_ENTRIES + 50; i++) guard.canActivate(ctxFor(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`).ctx);
    expect(buckets(guard).size).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(buckets(guard).size).toBe(MAX_ENTRIES);
  });

  it('al tope, expulsa la clave más vieja (la primera insertada), no una recién creada', () => {
    const guard = new RateLimitGuard(reflector(undefined), env);
    const MAX_ENTRIES = 100_000;
    const primeraIp = '172.16.0.1';
    guard.canActivate(ctxFor(primeraIp).ctx); // la primera clave del mapa
    for (let i = 0; i < MAX_ENTRIES; i++) guard.canActivate(ctxFor(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`).ctx);
    expect(buckets(guard).has(`g:${primeraIp}`)).toBe(false);
    // La clave más reciente sigue viva y sigue contando correctamente (no se reinició a 0 por accidente).
    const ultimaIp = `10.${((MAX_ENTRIES - 1) >> 16) & 255}.${((MAX_ENTRIES - 1) >> 8) & 255}.${(MAX_ENTRIES - 1) & 255}`;
    expect(buckets(guard).has(`g:${ultimaIp}`)).toBe(true);
  });
});

describe('UserRateLimitGuard', () => {
  const userCtx = (userId: string | undefined) => {
    const headers: Record<string, string> = {};
    const req = { ip: '1.1.1.1', user: userId ? { publicId: 'x', userId } : undefined };
    const reply = { header: (n: string, v: string) => (headers[n] = v) };
    return {
      ctx: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }) } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      headers,
    };
  };

  it('deja pasar 10 por usuario y hora y bloquea la 11 con Retry-After; otro usuario tiene su propio contador', () => {
    const limiter = new RateLimitGuard(reflector(undefined), env);
    const guard = new UserRateLimitGuard(limiter);
    for (let i = 0; i < 10; i++) expect(guard.canActivate(userCtx('7').ctx)).toBe(true);
    const { ctx, headers } = userCtx('7');
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
    expect(guard.canActivate(userCtx('8').ctx)).toBe(true);
  });

  it('sin usuario autenticado no crea ninguna clave', () => {
    const limiter = new RateLimitGuard(reflector(undefined), env);
    const guard = new UserRateLimitGuard(limiter);
    expect(guard.canActivate(userCtx(undefined).ctx)).toBe(true);
    expect(buckets(limiter).size).toBe(0);
  });
});
