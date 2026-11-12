import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DbService, Queryable } from '../db/db.service';
import { ClientInfo, SecurityEventsService } from '../security/security-events.service';

/** 32 bytes aleatorios en base64url = 43 caracteres. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface RotatedSession {
  usuarioId: string;
  publicId: string;
  refreshToken: string;
}

type Outcome =
  | { kind: 'ok'; usuarioId: string; publicId: string; refreshToken: string }
  | { kind: 'reuse' | 'invalid' | 'unknown' | 'inactive'; usuarioId?: string };

/**
 * Refresh tokens opacos y rotativos. En base solo se guarda el hash SHA-256: un volcado de la
 * tabla no sirve para iniciar sesión. Reutilizar un token ya rotado revoca toda la familia.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly db: DbService,
    private readonly events: SecurityEventsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Crea un refresh token (nueva familia si no se indica) dentro de la transacción dada. */
  async issue(q: Queryable, usuarioId: string, info: ClientInfo, familiaId: string = randomUUID()): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await q.query(
      `INSERT INTO sesion_refresh (familia_id, usuario_id, token_hash, expira_en, ip, user_agent)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + make_interval(days => $4), $5::inet, $6)`,
      [familiaId, usuarioId, sha256(token), this.env.REFRESH_TOKEN_TTL_DAYS, info.ip ?? null, info.userAgent?.slice(0, 300) ?? null],
    );
    return token;
  }

  async rotate(raw: string, info: ClientInfo): Promise<RotatedSession> {
    if (!TOKEN_RE.test(raw)) {
      await this.events.record('REFRESH_INVALIDO', { ...info, detalle: { motivo: 'FORMATO' } });
      throw new UnauthorizedException('Sesión inválida o expirada.');
    }
    const hash = sha256(raw);
    const out = await this.db.service<Outcome>(async (q) => {
      // Un solo UPDATE atómico: de dos rotaciones simultáneas del mismo token, solo una gana.
      const upd = await q.query<{ familia_id: string; usuario_id: string }>(
        `UPDATE sesion_refresh SET usado_en = CURRENT_TIMESTAMP
          WHERE token_hash = $1 AND usado_en IS NULL AND revocado_en IS NULL AND expira_en > CURRENT_TIMESTAMP
          RETURNING familia_id, usuario_id`,
        [hash],
      );
      const won = upd.rows[0];
      if (won) {
        const u = await q.query<{ public_id: string; activo: boolean }>('SELECT public_id, activo FROM usuario WHERE usuario_id = $1', [won.usuario_id]);
        const user = u.rows[0];
        if (!user?.activo) {
          await this.revokeFamily(q, won.familia_id, 'ADMIN');
          return { kind: 'inactive', usuarioId: String(won.usuario_id) };
        }
        const refreshToken = await this.issue(q, String(won.usuario_id), info, won.familia_id);
        return { kind: 'ok', usuarioId: String(won.usuario_id), publicId: user.public_id, refreshToken };
      }
      const prev = await q.query<{ familia_id: string; usuario_id: string; usado_en: Date | null; revocado_en: Date | null; motivo_revocacion: string | null }>(
        'SELECT familia_id, usuario_id, usado_en, revocado_en, motivo_revocacion FROM sesion_refresh WHERE token_hash = $1',
        [hash],
      );
      const row = prev.rows[0];
      if (!row) return { kind: 'unknown' };
      const usuarioId = String(row.usuario_id);
      // Token ya rotado: alguien lo está reutilizando (robo probable) → se corta toda la familia.
      if (row.usado_en && !row.revocado_en) {
        await this.revokeFamily(q, row.familia_id, 'REUSO');
        return { kind: 'reuse', usuarioId };
      }
      if (row.motivo_revocacion === 'REUSO') return { kind: 'reuse', usuarioId };
      return { kind: 'invalid', usuarioId };
    });

    if (out.kind === 'ok') return { usuarioId: out.usuarioId, publicId: out.publicId, refreshToken: out.refreshToken };
    const tipo = { reuse: 'REFRESH_REUSO', invalid: 'REFRESH_INVALIDO', unknown: 'REFRESH_INVALIDO', inactive: 'REFRESH_INVALIDO' }[out.kind];
    await this.events.record(tipo, { ...info, usuarioId: out.usuarioId, detalle: { motivo: out.kind.toUpperCase() } });
    throw new UnauthorizedException('Sesión inválida o expirada.');
  }

  /** Cierra la sesión del dispositivo (toda la familia del token). Idempotente: un token desconocido no es error. */
  async logout(raw: string, info: ClientInfo): Promise<void> {
    if (!TOKEN_RE.test(raw)) return;
    const usuarioId = await this.db.service(async (q) => {
      const r = await q.query<{ familia_id: string; usuario_id: string }>('SELECT familia_id, usuario_id FROM sesion_refresh WHERE token_hash = $1', [sha256(raw)]);
      if (!r.rows[0]) return undefined;
      await this.revokeFamily(q, r.rows[0].familia_id, 'LOGOUT');
      return String(r.rows[0].usuario_id);
    });
    if (usuarioId) await this.events.record('LOGOUT', { ...info, usuarioId });
  }

  /** Cierra todas las sesiones del usuario en todos los dispositivos. */
  async logoutAll(usuarioId: string, info: ClientInfo): Promise<number> {
    const n = await this.db.service(async (q) => {
      const r = await q.query(
        `UPDATE sesion_refresh SET revocado_en = CURRENT_TIMESTAMP, motivo_revocacion = 'LOGOUT_TODOS'
          WHERE usuario_id = $1 AND revocado_en IS NULL`,
        [usuarioId],
      );
      return r.rowCount ?? 0;
    });
    await this.events.record('LOGOUT_TODOS', { ...info, usuarioId, detalle: { sesiones: n } });
    return n;
  }

  private revokeFamily(q: Queryable, familiaId: string, motivo: 'LOGOUT' | 'REUSO' | 'ADMIN') {
    return q.query(
      `UPDATE sesion_refresh SET revocado_en = CURRENT_TIMESTAMP, motivo_revocacion = $2
        WHERE familia_id = $1 AND revocado_en IS NULL`,
      [familiaId, motivo],
    );
  }
}
