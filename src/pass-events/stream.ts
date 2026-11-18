import { Controller, Get, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodeJwt } from 'jose';
import type { OutgoingHttpHeaders } from 'node:http';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, BusinessError } from '../common/errors';
import { PassEventBus, type PassEvent } from './bus';

export const PASS_STREAM_LIMITS = Symbol('PASS_STREAM_LIMITS');

export interface PassStreamLimits {
  /** Conexiones abiertas por usuario; la que sobra cierra la más vieja. */
  perUser: number;
  /** Conexiones abiertas en toda la instancia; después, 503. */
  total: number;
  heartbeatMs: number;
  /** Cuánto espera el cliente antes de reconectar (campo `retry:` de SSE). */
  retryMs: number;
}

export const DEFAULT_LIMITS: Omit<PassStreamLimits, 'total'> = { perUser: 2, heartbeatMs: 20_000, retryMs: 5_000 };
/** Tras `REEMPLAZADA` el cliente espera más antes de reintentar, para que dos dispositivos no se echen en bucle. */
const RETRY_AFTER_REPLACED_MS = 60_000;
/** Un cliente que no lee (más de esto sin enviar) se corta. */
const MAX_PENDING_BYTES = 64 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;

export type FinMotivo = 'REEMPLAZADA' | 'TOKEN_VENCIDO' | 'APAGADO';

/** Lo mínimo que el hub necesita de la respuesta HTTP (en pruebas, un doble). */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
  /** Bytes escritos que el socket aún no envió. */
  readonly pending: number;
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Connection {
  userId: string;
  sink: SseSink;
  unsubscribe: () => void;
  timers: NodeJS.Timeout[];
  closed: boolean;
}

/**
 * Conexiones SSE abiertas en esta instancia: topes por usuario y global, latido, vencimiento del token y cierre al
 * apagar. Cada conexión solo se suscribe al bus con el usuario_id del token, así que no puede ver eventos ajenos.
 */
@Injectable()
export class PassStreamHub implements OnModuleDestroy {
  private readonly logger = new Logger(PassStreamHub.name);
  /** Por usuario, de la más vieja a la más nueva. */
  private readonly byUser = new Map<string, Connection[]>();
  private count = 0;
  private shuttingDown = false;

  constructor(
    private readonly bus: PassEventBus,
    @Inject(PASS_STREAM_LIMITS) private readonly limits: PassStreamLimits,
  ) {}

  get size(): number {
    return this.count;
  }

  connectionsOf(userId: string): number {
    return this.byUser.get(userId)?.length ?? 0;
  }

  /** Lanza 503 `EVENTOS_SATURADO` si la instancia está llena o apagándose (antes de escribir nada en la respuesta). */
  assertCapacity(userId: string): void {
    const replaces = this.connectionsOf(userId) >= this.limits.perUser; // reemplaza una suya: el total no sube
    if (this.shuttingDown || (!replaces && this.count >= this.limits.total))
      throw new BusinessError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'EVENTOS_SATURADO',
        'No hay lugar para más conexiones de eventos. Reintenta en unos segundos.',
      );
  }

  /**
   * Abre una conexión ya validada. `expiresAtMs`: cuándo vence el token; ahí se cierra con `TOKEN_VENCIDO` para que el
   * cliente reconecte con uno nuevo. Devuelve la función que la cierra (la llama el controlador al cerrarse el socket).
   */
  open(userId: string, sink: SseSink, expiresAtMs?: number): () => void {
    this.assertCapacity(userId);
    const list = this.byUser.get(userId) ?? [];
    while (list.length >= this.limits.perUser) this.close(list[0]!, 'REEMPLAZADA');

    const conn: Connection = { userId, sink, unsubscribe: () => undefined, timers: [], closed: false };
    sink.write(`retry: ${this.limits.retryMs}\n: conectado\n\n`);
    conn.unsubscribe = this.bus.subscribe(userId, (event: PassEvent) => this.send(conn, event.tipo, event));
    conn.timers.push(setInterval(() => this.send(conn, 'LATIDO', { hora: new Date().toISOString() }), this.limits.heartbeatMs));
    if (expiresAtMs !== undefined)
      conn.timers.push(setTimeout(() => this.close(conn, 'TOKEN_VENCIDO'), Math.min(Math.max(0, expiresAtMs - Date.now()), MAX_TIMER_MS)));
    for (const t of conn.timers) t.unref();

    this.byUser.set(userId, [...(this.byUser.get(userId) ?? []), conn]);
    this.count += 1;
    return () => this.close(conn);
  }

  /** Al apagar la API: avisa y cierra todas, y no acepta nuevas. */
  onModuleDestroy(): void {
    this.shuttingDown = true;
    for (const list of [...this.byUser.values()]) for (const conn of [...list]) this.close(conn, 'APAGADO');
  }

  private send(conn: Connection, event: string, data: unknown): void {
    if (conn.closed) return;
    if (conn.sink.pending > MAX_PENDING_BYTES) {
      this.logger.warn({ userId: conn.userId }, 'Conexión de eventos lenta: se corta');
      this.close(conn);
      return;
    }
    conn.sink.write(frame(event, data));
  }

  /** Idempotente: limpia timers, suscripción y registro; con `motivo`, avisa al cliente antes de cerrar. */
  private close(conn: Connection, motivo?: FinMotivo): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const t of conn.timers) clearTimeout(t);
    conn.unsubscribe();
    const list = this.byUser.get(conn.userId);
    const i = list?.indexOf(conn) ?? -1;
    if (list && i >= 0) {
      list.splice(i, 1);
      if (list.length === 0) this.byUser.delete(conn.userId);
      this.count -= 1;
    }
    try {
      if (motivo === 'REEMPLAZADA') conn.sink.write(`retry: ${RETRY_AFTER_REPLACED_MS}\n\n`);
      if (motivo) conn.sink.write(frame('FIN', { motivo }));
      conn.sink.end();
    } catch {
      // el socket ya estaba cerrado: no hay nada que avisar
    }
  }
}

const EXAMPLE =
  'retry: 5000\n: conectado\n\n' +
  'event: CANJE_REGISTRADO\ndata: {"tipo":"CANJE_REGISTRADO","consumoId":"62fb9399-5082-4571-9169-55b77c49e676","restauranteNombre":"La Sazón","saldoRestante":4,"platoNombre":null,"hora":"2026-11-13T17:00:00.000Z"}\n\n' +
  'event: LATIDO\ndata: {"hora":"2026-11-13T17:00:20.000Z"}\n\n' +
  'event: CANJE_REVERTIDO\ndata: {"tipo":"CANJE_REVERTIDO","consumoId":"62fb9399-5082-4571-9169-55b77c49e676","restauranteNombre":"La Sazón","saldoRestante":5,"hora":"2026-11-13T17:00:06.000Z"}\n\n' +
  'event: FIN\ndata: {"motivo":"TOKEN_VENCIDO"}\n\n';

@ApiTags('pase')
@ApiBearerAuth()
@Controller('v1/pase')
export class PassEventsController {
  constructor(private readonly hub: PassStreamHub) {}

  @Get('eventos')
  @ApiOperation({
    summary: 'Eventos del pase en tiempo real (Server-Sent Events)',
    description:
      'Conexión abierta `text/event-stream` con los eventos **del usuario del token**: `CANJE_REGISTRADO` (la caja descontó un almuerzo) y ' +
      '`CANJE_REVERTIDO` (la caja lo deshizo), con el saldo que queda en ese local. `LATIDO` cada 20 s. `FIN` con `motivo` antes de que el ' +
      'servidor cierre: `REEMPLAZADA` (se abrió una 3.ª conexión del mismo usuario: máximo 2), `TOKEN_VENCIDO` (renovar el token y reconectar) o ' +
      '`APAGADO`. Sin historial: al (re)conectar, la app vuelve a pedir `GET /v1/pase`. 503 `EVENTOS_SATURADO` si la instancia está llena.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: 'Flujo SSE: `event:` con el tipo y `data:` con un JSON',
    content: { 'text/event-stream': { schema: { type: 'string' }, example: EXAMPLE } },
  })
  @ApiProblems({ 503: ['EVENTOS_SATURADO'] })
  stream(@CurrentUser() user: AuthUser, @Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    this.hub.assertCapacity(user.userId); // antes de tocar la respuesta: el 503 sale como problem+json

    const raw = reply.raw;
    reply.hijack();
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v; // CORS, helmet, x-request-id
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // proxies tipo nginx: no acumular
      connection: 'keep-alive',
    });
    req.raw.socket.setTimeout(0);
    req.raw.socket.setNoDelay(true);
    req.raw.socket.setKeepAlive(true);

    const close = this.hub.open(
      user.userId,
      {
        write: (chunk) => void raw.write(chunk),
        end: () => raw.end(),
        get pending() {
          return raw.writableLength;
        },
      },
      tokenExpiry(req.headers.authorization),
    );
    raw.on('close', close);
  }
}

/** `exp` del access token (el guard ya lo verificó; aquí solo se lee). */
function tokenExpiry(header: string | undefined): number | undefined {
  try {
    const exp = decodeJwt(header?.replace(/^Bearer /, '') ?? '').exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
