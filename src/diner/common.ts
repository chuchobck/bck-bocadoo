import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { badRequest, conflict } from '../common/errors';
import type { Queryable } from '../db/db.service';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Hoy" de cada restaurante, en su zona horaria. */
export const HOY_LOCAL = (alias: string) => `(CURRENT_TIMESTAMP AT TIME ZONE ${alias}.zona_horaria)::date`;

/**
 * Exige que el restaurante haya publicado el menú de HOY (fecha local del restaurante, no la del servidor); si no,
 * 409 `MENU_NO_PUBLICADO`. Sin `restauranteId` usa el tenant de la petición (personal). Devuelve el id del menú.
 */
export async function assertMenuPublicado(q: Queryable, restauranteId?: string): Promise<string> {
  const r = await q.query<{ menu_diario_id: string }>(
    `SELECT m.menu_diario_id FROM restaurante r
       JOIN menu_diario_cabecera m ON m.restaurante_id = r.restaurante_id AND m.fecha_local = ${HOY_LOCAL('r')} AND m.publicado_en IS NOT NULL
      WHERE r.restaurante_id = COALESCE($1::bigint, app_tenant_id())`,
    [restauranteId ?? null],
  );
  if (!r.rows[0]) throw conflict('MENU_NO_PUBLICADO', 'El restaurante aún no publicó el menú de hoy.');
  return r.rows[0].menu_diario_id;
}

/** 409 `RESTAURANTE_PAUSADO`: un local pausado no admite órdenes nuevas (lo ya creado no se toca). */
export const restaurantePausado = () =>
  conflict('RESTAURANTE_PAUSADO', 'El restaurante está pausado y no recibe pedidos nuevos por ahora.');

/** Paginación por cursor opaco (fecha + public_id: nunca ids internos). */
export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'nextCursor de la página anterior' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,200}$/, { message: 'cursor inválido' })
  cursor?: string;
}

/** Marca de tiempo con microsegundos, para cursores (un Date de JS los perdería). */
export const CURSOR_TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const encodeCursor = (t: string, id: string) => Buffer.from(JSON.stringify({ t, p: id })).toString('base64url');

export function decodeCursor(cursor: string): { t: string; p: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; p?: unknown };
    if (typeof c.t === 'string' && !Number.isNaN(Date.parse(c.t)) && typeof c.p === 'string' && UUID_RE.test(c.p))
      return { t: c.t, p: c.p };
  } catch {
    /* cae al error de abajo */
  }
  throw badRequest('CURSOR_INVALIDO', 'cursor inválido.');
}

export const restauranteRef = (r: { restaurante_public_id: string; restaurante_nombre: string; restaurante_slug: string }) => ({
  id: r.restaurante_public_id,
  nombre: r.restaurante_nombre,
  slug: r.restaurante_slug,
});
