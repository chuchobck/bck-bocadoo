import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { badRequest } from '../common/errors';
import type { Queryable } from '../db/db.service';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;

export const DIA = { message: 'Usa una fecha AAAA-MM-DD.' };

/** Rango de fechas LOCALES del restaurante, ambos extremos incluidos. Sin él: los últimos 30 días, hoy incluido. */
export class RangeQuery {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Primer día (hora local del restaurante). Por defecto, hace 29 días.' })
  @IsOptional()
  @Matches(ISO_DATE, DIA)
  desde?: string;
  @ApiPropertyOptional({ example: '2026-10-31', description: 'Último día incluido (hora local). Por defecto, hoy.' })
  @IsOptional()
  @Matches(ISO_DATE, DIA)
  hasta?: string;
}

/** Un solo día; sin `fecha` es "hoy" en la zona horaria del restaurante. */
export class DayQuery {
  @ApiPropertyOptional({ example: '2026-10-31', description: 'Día local del restaurante. Por defecto, hoy.' })
  @IsOptional()
  @Matches(ISO_DATE, DIA)
  fecha?: string;
}

export interface LocalRange {
  desde: string;
  hasta: string;
  zonaHoraria: string;
  moneda: string;
}

const isRealDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/**
 * Resuelve el rango con la zona horaria del restaurante activo: "hoy" no es el de la hora del servidor ni el de UTC,
 * sino el del local. Todas las consultas de reportes filtran por estas fechas locales.
 */
export async function resolveRange(q: Queryable, desde?: string, hasta?: string): Promise<LocalRange> {
  for (const d of [desde, hasta]) if (d !== undefined && !isRealDate(d)) throw badRequest('FECHA_INVALIDA', `Fecha inválida: ${d}.`);
  const r = await q.query<{ desde: string; hasta: string; zona_horaria: string; moneda_codigo: string }>(
    `WITH h AS (SELECT r.zona_horaria, r.moneda_codigo, COALESCE($2::date, (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date) AS hasta
                  FROM restaurante r WHERE r.restaurante_id = app_tenant_id())
     SELECT COALESCE($1::date, h.hasta - 29)::text AS desde, h.hasta::text AS hasta, h.zona_horaria, h.moneda_codigo FROM h`,
    [desde ?? null, hasta ?? null],
  );
  const x = r.rows[0]!;
  if (x.desde > x.hasta) throw badRequest('RANGO_INVALIDO', '`desde` no puede ser posterior a `hasta`.');
  const days = (Date.parse(`${x.hasta}T00:00:00Z`) - Date.parse(`${x.desde}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_DAYS) throw badRequest('RANGO_MUY_LARGO', `El rango máximo es de ${MAX_DAYS} días.`);
  return { desde: x.desde, hasta: x.hasta, zonaHoraria: x.zona_horaria, moneda: x.moneda_codigo };
}

export const num = (v: string | number | null | undefined) => Number(v ?? 0);
