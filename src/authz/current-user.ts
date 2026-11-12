import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Usuario autenticado, puesto en el request por JwtAuthGuard. */
export interface AuthUser {
  /** public_id (UUID): lo único que sale hacia afuera. */
  publicId: string;
  /** usuario_id interno. */
  userId: string;
}

export type AuthedRequest = FastifyRequest & { user?: AuthUser };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new Error('CurrentUser usado en un endpoint público');
  return user;
});
