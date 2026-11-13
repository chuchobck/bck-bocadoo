import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DbService } from '../db/db.service';
import { SecurityEventsService } from '../security/security-events.service';
import { RequestContextStore } from '../tenancy/request-context';
import type { AuthedRequest } from './current-user';
import { ROLES_KEY, type Rol } from './roles.decorator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Segunda capa de autorización: el tenant sale de la pertenencia del usuario (personal_restaurante),
 * nunca de un id que mande el cliente sin comprobar. La tercera capa es RLS en la base.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
    private readonly events: SecurityEventsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<Rol[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new ForbiddenException('Acceso denegado.');
    const raw = req.headers['x-restaurant-id'];
    if (typeof raw !== 'string' || !UUID_RE.test(raw))
      throw new BadRequestException('Falta el encabezado x-restaurant-id o no es un UUID.');

    // Como bck_api con el usuario del request: RLS solo deja ver sus propias filas de personal.
    const found = await this.db.scope({ userId: req.user.userId, readOnly: true }, (q) =>
      q.query<{ restaurante_id: string; rol: Rol }>(
        `SELECT p.restaurante_id, p.rol FROM personal_restaurante p
           JOIN restaurante r ON r.restaurante_id = p.restaurante_id
          WHERE p.usuario_id = app_user_id() AND r.public_id = $1 AND p.activo`,
        [raw.toLowerCase()],
      ),
    );
    const row = found.rows[0];
    if (!row) {
      await this.events.record('ACCESO_DENEGADO', {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        usuarioId: req.user.userId,
        detalle: { motivo: 'SIN_ACCESO_AL_RESTAURANTE', restaurante: raw.toLowerCase(), ruta: req.url.split('?')[0] },
      });
      throw new ForbiddenException('No tienes acceso a este restaurante.');
    }
    RequestContextStore.set({ tenantId: String(row.restaurante_id), role: row.rol });
    return true;
  }
}
