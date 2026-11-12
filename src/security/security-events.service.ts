import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** Registra en evento_seguridad (solo inserción). Un fallo al registrar nunca rompe el request. */
@Injectable()
export class SecurityEventsService {
  private readonly logger = new Logger(SecurityEventsService.name);

  constructor(private readonly db: DbService) {}

  async record(
    tipo: string,
    info: ClientInfo & { usuarioId?: string; detalle?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      await this.db.service((q) =>
        q.query(
          'INSERT INTO evento_seguridad (tipo, usuario_id, ip, user_agent, detalle) VALUES ($1, $2, $3::inet, $4, $5::jsonb)',
          [tipo, info.usuarioId ?? null, info.ip ?? null, info.userAgent?.slice(0, 300) ?? null, JSON.stringify(info.detalle ?? {})],
        ),
      );
    } catch (err) {
      this.logger.error({ err, tipo }, 'No se pudo registrar el evento de seguridad');
    }
  }
}
