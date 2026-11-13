import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export const RATE_LIMIT_KEY = 'rateLimitPreset';
export type RateLimitPreset = 'auth' | 'signup' | 'invite';
/** Límite más estricto que el global para un endpoint sensible. */
export const RateLimit = (preset: RateLimitPreset) => SetMetadata(RATE_LIMIT_KEY, preset);

interface Bucket {
  count: number;
  resetAt: number;
}
const MAX_ENTRIES = 100_000;

/**
 * Límite de peticiones en memoria (ventana fija). Vale para una sola instancia de la API;
 * si se escala a varias hay que moverlo a un almacén compartido (documentado en el modelo de amenazas).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const now = Date.now();
    if (this.buckets.size > MAX_ENTRIES) this.sweep(now);

    // Tope general por IP, para todos los endpoints.
    const checks: Array<[string, number, number]> = [[`g:${req.ip}`, this.env.RATE_LIMIT_MAX, 60]];
    const preset = this.reflector.getAllAndOverride<RateLimitPreset | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (preset === 'auth') {
      const id = String((req.body as { identificador?: unknown } | undefined)?.identificador ?? '')
        .toLowerCase()
        .slice(0, 254);
      const { AUTH_RATE_LIMIT_MAX: max, AUTH_RATE_LIMIT_WINDOW_SECONDS: win } = this.env;
      checks.push([`a:${req.ip}:${id}`, max, win]); // intentos por IP y cuenta
      checks.push([`c:${id}`, max * 4, win]); // contra ataques que rotan de IP sobre una cuenta
    } else if (preset === 'invite') {
      checks.push([`i:${req.ip}`, this.env.INVITE_RATE_LIMIT_MAX, 3600]); // busca cuentas por correo: se limita para no enumerar
    } else if (preset === 'signup') {
      checks.push([`s:${req.ip}`, this.env.SIGNUP_RATE_LIMIT_MAX, 3600]);
    }

    let retryAfter = 0;
    for (const [key, max, windowSeconds] of checks) {
      let b = this.buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowSeconds * 1000 };
        this.buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > max) retryAfter = Math.max(retryAfter, Math.ceil((b.resetAt - now) / 1000));
    }
    if (retryAfter > 0) {
      void reply.header('retry-after', String(retryAfter));
      throw new HttpException('Demasiadas solicitudes. Intenta de nuevo más tarde.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
