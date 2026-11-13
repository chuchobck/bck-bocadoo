import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { badRequest } from '../common/errors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Hoy" de cada restaurante, en su zona horaria. */
export const HOY_LOCAL = (alias: string) => `(CURRENT_TIMESTAMP AT TIME ZONE ${alias}.zona_horaria)::date`;

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

export const encodeCursor = (t: Date, id: string) => Buffer.from(JSON.stringify({ t: t.toISOString(), p: id })).toString('base64url');

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
