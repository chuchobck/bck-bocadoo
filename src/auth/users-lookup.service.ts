import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface FoundUser {
  usuarioId: string;
  publicId: string;
  nombre: string;
}

/**
 * Búsqueda de cuentas por correo. Vive en src/auth porque `bocadoo_app` no puede leer la columna `correo`
 * (privacidad): hace falta el rol de servicio, así que solo se expone esto, nunca consultas libres.
 */
@Injectable()
export class UsersLookupService {
  constructor(private readonly db: DbService) {}

  async findActiveByEmail(correo: string): Promise<FoundUser | null> {
    const r = await this.db.service((q) =>
      q.query<{ usuario_id: string; public_id: string; nombre: string }>(
        'SELECT usuario_id, public_id, nombre FROM usuario WHERE correo = $1 AND activo',
        [correo.trim().toLowerCase()],
      ),
    );
    const u = r.rows[0];
    return u ? { usuarioId: String(u.usuario_id), publicId: u.public_id, nombre: u.nombre } : null;
  }
}
