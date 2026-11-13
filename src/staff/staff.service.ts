import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UsersLookupService } from '../auth/users-lookup.service';
import { DbService } from '../db/db.service';

interface StaffRow {
  usuario_public_id: string;
  nombre: string;
  nombre_visible: string;
  rol: string;
  activo: boolean;
}

const toStaff = (r: StaffRow) => ({
  usuarioId: r.usuario_public_id,
  nombre: r.nombre,
  nombreVisible: r.nombre_visible,
  rol: r.rol,
  activo: r.activo,
});

const SELECT = `SELECT u.public_id AS usuario_public_id, u.nombre, p.nombre_visible, p.rol, p.activo
                  FROM personal_restaurante p JOIN usuario u ON u.usuario_id = p.usuario_id`;

@Injectable()
export class StaffService {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersLookupService,
  ) {}

  list() {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<StaffRow>(`${SELECT} WHERE p.restaurante_id = app_tenant_id() ORDER BY p.rol, p.nombre_visible`);
        return r.rows.map(toStaff);
      },
      { readOnly: true },
    );
  }

  /** Da de alta como cajero a una cuenta que ya existe (la persona se registra primero). */
  async inviteCashier(correo: string, nombreVisible?: string) {
    const user = await this.users.findActiveByEmail(correo);
    if (!user) throw new NotFoundException('No existe una cuenta con ese correo. Pídele a la persona que se registre primero.');
    return this.db.forRequest(async (q) => {
      const dup = await q.query('SELECT 1 FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = $1', [
        user.usuarioId,
      ]);
      if (dup.rowCount) throw new ConflictException('Esa persona ya forma parte del personal de este restaurante.');
      await q.query(
        `INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible) VALUES (app_tenant_id(), $1, 'CAJERO', $2)`,
        [user.usuarioId, nombreVisible ?? user.nombre],
      );
      const r = await q.query<StaffRow>(`${SELECT} WHERE p.restaurante_id = app_tenant_id() AND u.public_id = $1`, [user.publicId]);
      return toStaff(r.rows[0]!);
    });
  }

  /** Activa o desactiva a un cajero. Al dueño no se le toca. */
  async setActive(usuarioPublicId: string, activo: boolean) {
    return this.db.forRequest(async (q) => {
      const cur = await q.query<{ rol: string }>(
        `SELECT p.rol FROM personal_restaurante p JOIN usuario u ON u.usuario_id = p.usuario_id
          WHERE p.restaurante_id = app_tenant_id() AND u.public_id = $1`,
        [usuarioPublicId],
      );
      if (!cur.rows[0]) throw new NotFoundException('Esa persona no es parte del personal de este restaurante.');
      if (cur.rows[0].rol !== 'CAJERO') throw new ConflictException('Solo se puede activar o desactivar a un cajero.');
      await q.query(
        `UPDATE personal_restaurante SET activo = $2
          WHERE restaurante_id = app_tenant_id() AND usuario_id = (SELECT usuario_id FROM usuario WHERE public_id = $1)`,
        [usuarioPublicId, activo],
      );
      const r = await q.query<StaffRow>(`${SELECT} WHERE p.restaurante_id = app_tenant_id() AND u.public_id = $1`, [usuarioPublicId]);
      return toStaff(r.rows[0]!);
    });
  }
}
