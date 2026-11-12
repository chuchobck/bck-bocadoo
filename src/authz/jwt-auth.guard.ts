import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../auth/token.service';
import { RequestContextStore } from '../tenancy/request-context';
import type { AuthedRequest } from './current-user';
import { IS_PUBLIC } from './public.decorator';

/** Guard global: todo endpoint exige un access token válido salvo que lleve @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
    const claims = match ? await this.tokens.verifyAccess(match[1]!) : null;
    if (!claims) throw new UnauthorizedException('Token ausente o inválido.');

    req.user = { publicId: claims.sub, userId: claims.uid };
    RequestContextStore.set({ userId: claims.uid });
    return true;
  }
}
