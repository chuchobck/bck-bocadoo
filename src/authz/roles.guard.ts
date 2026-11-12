import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SecurityEventsService } from '../security/security-events.service';
import { RequestContextStore } from '../tenancy/request-context';
import type { AuthedRequest } from './current-user';
import { ROLES_KEY, type Rol } from './roles.decorator';

/** Comprueba el rol que TenantGuard dejó en el contexto del request. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly events: SecurityEventsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Rol[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles) return true;
    const ctx = RequestContextStore.get();
    if (ctx?.role && roles.includes(ctx.role)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    await this.events.record('ACCESO_DENEGADO', {
      ip: req.ip, userAgent: req.headers['user-agent'], usuarioId: ctx?.userId,
      detalle: { motivo: 'ROL_INSUFICIENTE', rol: ctx?.role ?? null, requeridos: roles, ruta: req.url.split('?')[0] },
    });
    throw new ForbiddenException('Tu rol no permite esta acción.');
  }
}
