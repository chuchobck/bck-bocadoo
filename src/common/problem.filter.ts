import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mapPgError } from '../db/pg-errors';
import { problemCode } from './errors';

/** Respuesta de error según RFC 9457 (application/problem+json). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(raw: unknown, host: ArgumentsHost): void {
    const exception = mapPgError(raw) ?? raw;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : null;

    // Nunca filtrar detalles internos en errores 5xx.
    let detail = 'Solicitud inválida.';
    if (status >= 500) detail = 'Error interno del servidor.';
    else if (typeof body === 'string') detail = body;
    else if (body && typeof body === 'object' && 'message' in body) {
      const m = (body as { message: unknown }).message;
      detail = Array.isArray(m) ? m.join('; ') : String(m);
    } else if (exception instanceof Error) detail = exception.message;

    if (status >= 500) this.logger.error({ err: raw, requestId: req.id }, 'Excepción no controlada');

    void res
      .status(status)
      .header('content-type', 'application/problem+json; charset=utf-8')
      .send({
        type: 'about:blank',
        title: HttpStatus[status]?.replaceAll('_', ' ') ?? 'Error',
        status,
        code: status >= 500 ? 'ERROR_INTERNO' : problemCode(status, body),
        detail,
        instance: req.url,
        requestId: req.id,
      });
  }
}
