import { createParamDecorator, ExecutionContext, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee el encabezado obligatorio `Idempotency-Key` (UUID). Repetir la petición con la misma clave no duplica el cobro. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const v = ctx.switchToHttp().getRequest<FastifyRequest>().headers['idempotency-key'];
  if (typeof v !== 'string' || !UUID.test(v))
    throw badRequest('IDEMPOTENCY_KEY_INVALIDA', 'Falta el encabezado Idempotency-Key (UUID) o no es válido.');
  return v.toLowerCase();
});

export const ApiIdempotent = () =>
  applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'UUID generado por el cliente. Si se reintenta con la misma clave, se devuelve el mismo resultado sin cobrar dos veces.',
    }),
  );
