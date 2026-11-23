import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export const RATE_LIMIT_KEY = 'rateLimitPreset';
export type RateLimitPreset = 'auth' | 'signup' | 'invite' | 'events';
/** Límite más estricto que el global para un endpoint sensible. */
export const RateLimit = (preset: RateLimitPreset) => SetMetadata(RATE_LIMIT_KEY, preset);

interface Bucket {
  count: number;
  resetAt: number;
}
/**
 * Tope duro de memoria: nunca más de esta cantidad de claves vivas a la vez, sin importar cuántas IPs o
 * identificadores distintos mande un atacante. `buckets` es un Map (orden de inserción); al llegar al tope,
 * cada inserción nueva expulsa primero la entrada más vieja (O(1), nunca un recorrido completo).
 */
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

    // Tope general por IP primero, y solo por sí solo: si ya está excedido, ni se miran ni se crean las
    // claves del preset (p. ej. a:/c: de login, con un identificador que elige el atacante). Sin este corte,
    // una ráfaga desde una sola IP crea una clave nueva en cada petición aunque todas respondan 429, y el
    // mapa crece sin límite real (ver docs/seguridad.md).
    const globalKey = `g:${req.ip}`;
    const globalRetry = this.hit(globalKey, this.env.RATE_LIMIT_MAX, 60, now);
    if (globalRetry > 0) return this.block(reply, globalRetry);

    const checks: Array<[string, number, number]> = [];
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
    } else if (preset === 'events') {
      checks.push([`e:${req.ip}`, this.env.EVENTS_RATE_LIMIT_MAX, 60]); // ingesta de eventos: tope por IP además del tope por usuario
    } else if (preset === 'signup') {
      checks.push([`s:${req.ip}`, this.env.SIGNUP_RATE_LIMIT_MAX, 3600]);
    }

    let retryAfter = 0;
    for (const [key, max, windowSeconds] of checks) retryAfter = Math.max(retryAfter, this.hit(key, max, windowSeconds, now));
    if (retryAfter > 0) return this.block(reply, retryAfter);
    return true;
  }

  /** Cuenta una petición contra `key`; devuelve en cuántos segundos reintentar, o 0 si todavía no se excede. */
  private hit(key: string, max: number, windowSeconds: number, now: number): number {
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.evictIfFull(key);
      this.buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : 0;
  }

  /** Al tope, expulsa la entrada insertada hace más tiempo antes de agregar una nueva (no toca una `key` ya existente). */
  private evictIfFull(key: string) {
    if (this.buckets.size < MAX_ENTRIES || this.buckets.has(key)) return;
    const oldest = this.buckets.keys().next().value;
    if (oldest !== undefined) this.buckets.delete(oldest);
  }

  private block(reply: FastifyReply, retryAfter: number): never {
    void reply.header('retry-after', String(retryAfter));
    throw new HttpException('Demasiadas solicitudes. Intenta de nuevo más tarde.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
