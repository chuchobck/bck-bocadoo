import { Controller, Get, Injectable, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, notFound } from '../common/errors';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { CURSOR_TS, PageQuery, UUID_RE, decodeCursor, encodeCursor, restauranteRef } from './common';

class HistorialQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'public_id del restaurante para filtrar' })
  @IsOptional()
  @Matches(UUID_RE, { message: 'restaurante debe ser un UUID' })
  restaurante?: string;
}

export class ConsumoItem {
  @ApiProperty({ description: 'public_id del consumo' }) id!: string;
  @ApiProperty() fecha!: Date;
  @ApiProperty({ example: '2026-11-13', description: 'Día del almuerzo en la hora local del restaurante' }) fechaLocal!: string;
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } }) restaurante!: {
    id: string;
    nombre: string;
    slug: string;
  };
  @ApiProperty({ example: { id: 'uuid', nombre: 'Plan semanal' } }) plan!: { id: string; nombre: string };
  @ApiProperty({ enum: ['QR', 'MANUAL', 'PREORDEN', 'MESA'] }) canal!: string;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({ description: 'El almuerzo se devolvió al plan (deshacer en caja o reclamo aceptado)' }) revertido!: boolean;
  @ApiPropertyOptional({ type: Date, nullable: true }) revertidoEn!: Date | null;
}
class HistorialResponse {
  @ApiProperty({ type: [ConsumoItem] }) items!: ConsumoItem[];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null si no hay más páginas' }) nextCursor!: string | null;
}

export interface ConsumoRow {
  consumo_id: string;
  public_id: string;
  creado_en: Date;
  fecha_local: string;
  canal: string;
  para_llevar: boolean;
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
  plan_public_id: string;
  nombre_plan: string;
  revertido_en: Date | null;
  cursor_t: string;
}

/**
 * Consumos (cantidad = +1) del comensal en todos sus locales. Los reversos no salen como filas: marcan el original.
 * El filtro por app_user_id() es explícito y además RLS (comensal_lee) solo deja ver sus consumos.
 */
export const CONSUMOS_DEL_COMENSAL = `SELECT k.consumo_id, k.public_id, k.creado_en, k.fecha_local::text AS fecha_local, k.canal, k.para_llevar,
       r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug,
       s.public_id AS plan_public_id, s.nombre_plan, x.creado_en AS revertido_en, ${CURSOR_TS('k.creado_en')} AS cursor_t
  FROM consumo_almuerzo k
  JOIN cliente_restaurante c ON c.restaurante_id = k.restaurante_id AND c.cliente_id = k.cliente_id
  JOIN restaurante r ON r.restaurante_id = k.restaurante_id
  JOIN suscripcion_plan s ON s.suscripcion_id = k.suscripcion_id
  LEFT JOIN consumo_almuerzo x ON x.revierte_a_consumo_id = k.consumo_id
 WHERE c.usuario_id = app_user_id() AND k.cantidad = 1`;

export const toConsumo = (r: ConsumoRow): ConsumoItem => ({
  id: r.public_id,
  fecha: r.creado_en,
  fechaLocal: r.fecha_local,
  restaurante: restauranteRef(r),
  plan: { id: r.plan_public_id, nombre: r.nombre_plan },
  canal: r.canal,
  paraLlevar: r.para_llevar,
  revertido: r.revertido_en !== null,
  revertidoEn: r.revertido_en,
});

/** Consumo propio por public_id, o 404 (también si es de otro comensal: no se revela que existe). */
export async function ownLunch(q: Queryable, publicId: string): Promise<ConsumoRow> {
  const r = await q.query<ConsumoRow>(`${CONSUMOS_DEL_COMENSAL} AND k.public_id = $1`, [publicId]);
  if (!r.rows[0]) throw notFound('CONSUMO_NO_ENCONTRADO', 'Consumo no encontrado.');
  return r.rows[0];
}

@Injectable()
export class HistoryService {
  constructor(private readonly db: DbService) {}

  list(user: AuthUser, f: HistorialQuery): Promise<HistorialResponse> {
    const limit = f.limit ?? 20;
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<ConsumoRow>(
        `${CONSUMOS_DEL_COMENSAL}
           AND ($1::uuid IS NULL OR r.public_id = $1)
           AND ($2::timestamptz IS NULL OR (k.creado_en, k.public_id) < ($2::timestamptz, $3::uuid))
         ORDER BY k.creado_en DESC, k.public_id DESC
         LIMIT $4`,
        [f.restaurante?.toLowerCase() ?? null, cur?.t ?? null, cur?.p ?? null, limit + 1],
      );
      const page = r.rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(toConsumo), nextCursor: r.rows.length > limit && last ? encodeCursor(last.cursor_t, last.public_id) : null };
    });
  }

  one(user: AuthUser, id: string): Promise<ConsumoItem> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => toConsumo(await ownLunch(q, id)));
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis/consumos')
export class HistoryController {
  constructor(private readonly svc: HistoryService) {}

  @Get()
  @ApiOperation({
    summary: 'Mis almuerzos consumidos (todos los locales)',
    description: 'Del más reciente al más antiguo, con paginación por cursor (máximo 50 por página).',
  })
  @ApiOkResponse({ type: HistorialResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'] })
  list(@CurrentUser() user: AuthUser, @Query() q: HistorialQuery) {
    return this.svc.list(user, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Un almuerzo consumido' })
  @ApiOkResponse({ type: ConsumoItem })
  @ApiProblems({ 404: ['CONSUMO_NO_ENCONTRADO'] })
  one(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.one(user, id);
  }
}
