import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from '../db/db.service';
import { ClientInfo, SecurityEventsService } from '../security/security-events.service';
import { LoginDto, RegisterDto, RegisterOwnerDto, RegisterResponseDto, TokenResponseDto } from './dto';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'local';

const TERMINOS_VERSION = 'v1';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly passwords: PasswordService,
    private readonly events: SecurityEventsService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  /** Mismo 401 y mismo trabajo (un argon2) exista o no el usuario: no se puede enumerar cuentas. */
  async login(dto: LoginDto, info: ClientInfo): Promise<TokenResponseDto> {
    const found = await this.db.service((q) =>
      q.query<{ usuario_id: string; public_id: string; nombre: string; activo: boolean; password_hash: string }>(
        `SELECT u.usuario_id, u.public_id, u.nombre, u.activo, ui.password_hash
           FROM usuario u JOIN usuario_identidad ui ON ui.usuario_id = u.usuario_id AND ui.proveedor = 'PASSWORD'
          WHERE u.correo = $1 OR u.nombre_usuario = $1 LIMIT 1`,
        [dto.identificador],
      ),
    );
    const user = found.rows[0];
    const ok = user ? await this.passwords.verify(user.password_hash, dto.password) : await this.passwords.verifyDummy(dto.password);
    if (!user || !ok || !user.activo) {
      const motivo = !user ? 'USUARIO_INEXISTENTE' : !ok ? 'PASSWORD' : 'INACTIVO';
      await this.events.record('LOGIN_FALLIDO', { ...info, usuarioId: user ? String(user.usuario_id) : undefined, detalle: { motivo } });
      throw new UnauthorizedException('Credenciales inválidas.');
    }
    const usuarioId = String(user.usuario_id);
    const refreshToken = await this.db.service(async (q) => {
      await q.query('UPDATE usuario_identidad SET ultimo_acceso_en = CURRENT_TIMESTAMP WHERE usuario_id = $1 AND proveedor = $2', [
        usuarioId,
        'PASSWORD',
      ]);
      return this.sessions.issue(q, usuarioId, info);
    });
    await this.events.record('LOGIN_OK', { ...info, usuarioId });
    return this.response(usuarioId, user.public_id, user.nombre, refreshToken);
  }

  async refresh(raw: string, info: ClientInfo): Promise<TokenResponseDto> {
    const s = await this.sessions.rotate(raw, info);
    const u = await this.db.service((q) => q.query<{ nombre: string }>('SELECT nombre FROM usuario WHERE usuario_id = $1', [s.usuarioId]));
    return this.response(s.usuarioId, s.publicId, u.rows[0]?.nombre ?? '', s.refreshToken);
  }

  private async response(usuarioId: string, publicId: string, nombre: string, refreshToken: string): Promise<TokenResponseDto> {
    return {
      accessToken: await this.tokens.signAccess({ sub: publicId, uid: usuarioId }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      usuario: { id: publicId, nombre },
    };
  }

  register(dto: RegisterDto, info: ClientInfo): Promise<RegisterResponseDto> {
    return this.create(dto, undefined, info);
  }

  registerOwner(dto: RegisterOwnerDto, info: ClientInfo): Promise<RegisterResponseDto> {
    return this.create(dto, dto.restaurante, info);
  }

  private async create(
    dto: RegisterDto,
    rest: RegisterOwnerDto['restaurante'] | undefined,
    info: ClientInfo,
  ): Promise<RegisterResponseDto> {
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const out = await this.db.service(async (q) => {
        const u = await q.query<{ usuario_id: string; public_id: string }>(
          `INSERT INTO usuario (nombre, correo, nombre_usuario, acepto_terminos_version, acepto_terminos_en)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING usuario_id, public_id`,
          [dto.nombre, dto.correo, dto.nombreUsuario ?? null, TERMINOS_VERSION],
        );
        const { usuario_id: usuarioId, public_id: publicId } = u.rows[0]!;
        // Desde aquí la auditoría de la base registra a este usuario como autor.
        await q.query("SELECT set_config('app.current_user_id', $1, true)", [String(usuarioId)]);
        await q.query(`INSERT INTO usuario_identidad (usuario_id, proveedor, sujeto, password_hash) VALUES ($1, 'PASSWORD', $2, $3)`, [
          usuarioId,
          dto.correo,
          passwordHash,
        ]);
        let restaurante: RegisterResponseDto['restaurante'];
        if (rest) {
          const c = await q.query<{ pais_codigo: string }>('SELECT pais_codigo FROM ciudad WHERE ciudad_id = $1', [rest.ciudadId]);
          if (!c.rows[0]) throw new BadRequestException('ciudadId no existe.');
          const slug = `${slugify(rest.nombre)}-${randomBytes(3).toString('hex')}`;
          const r = await q.query<{ restaurante_id: string; public_id: string; estado: string }>(
            `INSERT INTO restaurante (nombre, slug, pais_codigo, ciudad_id, moneda_codigo, zona_horaria, precio_suelto_centavos)
             VALUES ($1, $2, $3, $4, 'USD', 'America/Guayaquil', 0) RETURNING restaurante_id, public_id, estado`,
            [rest.nombre, slug, c.rows[0].pais_codigo, rest.ciudadId],
          );
          const row = r.rows[0]!;
          await q.query(`INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible) VALUES ($1, $2, 'DUENO', $3)`, [
            row.restaurante_id,
            usuarioId,
            dto.nombre,
          ]);
          restaurante = { id: row.public_id, nombre: rest.nombre, slug, estado: row.estado };
        }
        return { usuarioId: String(usuarioId), publicId, restaurante };
      });
      await this.events.record('REGISTRO', { ...info, usuarioId: out.usuarioId, detalle: { dueno: Boolean(rest) } });
      return {
        usuario: { id: out.publicId, nombre: dto.nombre, correo: dto.correo },
        ...(out.restaurante && { restaurante: out.restaurante }),
      };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Mensaje genérico: no confirma cuál dato ya existía.
        throw new ConflictException('No se pudo completar el registro con esos datos.');
      }
      throw err;
    }
  }
}
