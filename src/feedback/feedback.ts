import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { PERSONAL_ACTUAL } from '../checkout/checkout';
import { ApiProblems, badRequest, conflict, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { CURSOR_TS, PageQuery, decodeCursor, encodeCursor, restauranteRef } from '../diner/common';
import { CONSUMOS_DEL_COMENSAL, ConsumoRow, ownLunch } from '../diner/history';
import { Text } from '../security/sanitize';

/** La tarjeta "¿Qué tal hoy?" aparece 25 minutos después del almuerzo y caduca a las 24 horas. */
export const OPINION_DELAY_MINUTES = 25;
export const OPINION_TTL_HOURS = 24;
export const ETIQUETAS = [
  'RICO',
  'BUENA_PORCION',
  'RAPIDO',
  'BUENA_ATENCION',
  'LIMPIO',
  'FRIO',
  'SALADO',
  'PORCION_PEQUENA',
  'DEMORA',
  'MALA_ATENCION',
] as const;

class OpinarDto {
  @ApiPropertyOptional({ enum: ETIQUETAS, isArray: true, example: ['RICO', 'BUENA_PORCION'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ArrayUnique()
  @IsIn(ETIQUETAS, { each: true })
  etiquetas?: string[];
  @ApiPropertyOptional({ description: 'Solo lo lee el restaurante; no se publica', example: 'La sopa llegó tibia.' })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 500)
  comentario?: string;
}

class OpinionResponse {
  @ApiProperty({
    example: { id: 'uuid', fecha: '2026-11-13T17:00:00Z', restaurante: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } },
  })
  consumo!: { id: string; fecha: Date; restaurante: { id: string; nombre: string; slug: string } };
  @ApiProperty({ enum: ETIQUETAS, isArray: true }) etiquetas!: string[];
  @ApiPropertyOptional() comentario!: string | null;
  @ApiProperty({ description: 'Cerró la tarjeta sin opinar' }) descartada!: boolean;
  @ApiProperty() creadoEn!: Date;
  @ApiPropertyOptional({ example: { texto: '¡Gracias! Lo corregimos.', respondidoEn: '2026-11-13T18:00:00Z' } })
  respuesta!: { texto: string; respondidoEn: Date } | null;
}
class PendienteResponse {
  @ApiProperty({
    example: { id: 'uuid', fecha: '2026-11-13T17:00:00Z', restaurante: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } },
  })
  consumo!: { id: string; fecha: Date; restaurante: { id: string; nombre: string; slug: string } };
  @ApiProperty() expiraEn!: Date;
  @ApiProperty({ enum: ETIQUETAS, isArray: true }) etiquetasDisponibles!: readonly string[];
}

interface OpinionRow {
  consumo_public_id: string;
  consumo_en: Date;
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
  etiquetas: string[];
  comentario_privado: string | null;
  descartada: boolean;
  creado_en: Date;
  respuesta_restaurante: string | null;
  respondido_en: Date | null;
  clave_idempotencia: string | null;
}

const MIS_OPINIONES = `SELECT k.public_id AS consumo_public_id, k.creado_en AS consumo_en, r.public_id AS restaurante_public_id,
       r.nombre AS restaurante_nombre, r.slug AS restaurante_slug, o.etiquetas, o.comentario_privado, o.descartada, o.creado_en,
       o.respuesta_restaurante, o.respondido_en, o.clave_idempotencia
  FROM opinion o
  JOIN cliente_restaurante c ON c.restaurante_id = o.restaurante_id AND c.cliente_id = o.cliente_id
  JOIN consumo_almuerzo k ON k.restaurante_id = o.restaurante_id AND k.consumo_id = o.consumo_id
  JOIN restaurante r ON r.restaurante_id = o.restaurante_id
 WHERE c.usuario_id = app_user_id()`;

const toOpinion = (o: OpinionRow): OpinionResponse => ({
  consumo: { id: o.consumo_public_id, fecha: o.consumo_en, restaurante: restauranteRef(o) },
  etiquetas: o.etiquetas,
  comentario: o.comentario_privado,
  descartada: o.descartada,
  creadoEn: o.creado_en,
  respuesta: o.respuesta_restaurante === null ? null : { texto: o.respuesta_restaurante, respondidoEn: o.respondido_en! },
});

/**
 * Opiniones del comensal sobre sus almuerzos. Corre como el comensal (userId, sin tenant); la base (comensal_crea)
 * exige además almuerzo propio, no revertido y dentro de la ventana de 25 min a 24 h.
 */
@Injectable()
export class DinerFeedbackService {
  constructor(private readonly db: DbService) {}

  pending(user: AuthUser): Promise<PendienteResponse[]> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<ConsumoRow>(
        `${CONSUMOS_DEL_COMENSAL}
           AND x.consumo_id IS NULL
           AND k.creado_en <= CURRENT_TIMESTAMP - make_interval(mins => $1)
           AND k.creado_en >  CURRENT_TIMESTAMP - make_interval(hours => $2)
           AND NOT EXISTS (SELECT 1 FROM opinion o WHERE o.consumo_id = k.consumo_id)
         ORDER BY k.creado_en DESC LIMIT 20`,
        [OPINION_DELAY_MINUTES, OPINION_TTL_HOURS],
      );
      return r.rows.map((k) => ({
        consumo: { id: k.public_id, fecha: k.creado_en, restaurante: restauranteRef(k) },
        expiraEn: new Date(k.creado_en.getTime() + OPINION_TTL_HOURS * 3_600_000),
        etiquetasDisponibles: ETIQUETAS,
      }));
    });
  }

  list(user: AuthUser): Promise<OpinionResponse[]> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) =>
      (await q.query<OpinionRow>(`${MIS_OPINIONES} AND NOT o.descartada ORDER BY o.creado_en DESC LIMIT 50`)).rows.map(toOpinion),
    );
  }

  submit(user: AuthUser, consumoId: string, dto: OpinarDto, key: string) {
    if (!dto.etiquetas?.length && !dto.comentario)
      throw badRequest('OPINION_VACIA', 'Elige al menos una etiqueta o escribe un comentario.');
    return this.save(user, consumoId, key, { etiquetas: dto.etiquetas ?? [], comentario: dto.comentario ?? null, descartada: false });
  }

  dismiss(user: AuthUser, consumoId: string, key: string) {
    return this.save(user, consumoId, key, { etiquetas: [], comentario: null, descartada: true });
  }

  /** Una sola fila por almuerzo (opinión o descarte). Reintentar con la misma clave devuelve la misma. */
  private async save(
    user: AuthUser,
    consumoId: string,
    key: string,
    v: { etiquetas: string[]; comentario: string | null; descartada: boolean },
  ) {
    const attempt = () =>
      this.db.scope({ userId: user.userId }, async (q) => {
        const prev = await this.existing(q, consumoId, key);
        if (prev) return prev;
        const k = await ownLunch(q, consumoId);
        const w = (
          await q.query<{ antes: boolean; vencida: boolean }>(
            `SELECT $1::timestamptz > CURRENT_TIMESTAMP - make_interval(mins => $2) AS antes,
                    $1::timestamptz <= CURRENT_TIMESTAMP - make_interval(hours => $3) AS vencida`,
            [k.creado_en, OPINION_DELAY_MINUTES, OPINION_TTL_HOURS],
          )
        ).rows[0]!;
        if (k.revertido_en) throw conflict('CONSUMO_REVERTIDO', 'Ese almuerzo se devolvió al plan: no hay nada que opinar.');
        if (w.antes) throw conflict('OPINION_AUN_NO_DISPONIBLE', `Podrás opinar ${OPINION_DELAY_MINUTES} minutos después de almorzar.`);
        if (w.vencida) throw conflict('OPINION_VENCIDA', `Solo se puede opinar en las ${OPINION_TTL_HOURS} horas siguientes al almuerzo.`);
        await q.query(
          `INSERT INTO opinion (restaurante_id, consumo_id, cliente_id, etiquetas, comentario_privado, descartada, clave_idempotencia)
           SELECT k.restaurante_id, k.consumo_id, k.cliente_id, $2, $3, $4, $5 FROM consumo_almuerzo k WHERE k.consumo_id = $1`,
          [k.consumo_id, v.etiquetas, v.comentario, v.descartada, key],
        );
        return this.one(q, consumoId);
      });
    try {
      return await attempt();
    } catch (err) {
      // Dos envíos a la vez: UNIQUE (consumo_id) deja pasar uno; el otro se resuelve como reintento o como "ya enviada".
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'opinion_consumo_id_key') return attempt();
      throw err;
    }
  }

  private async existing(q: Queryable, consumoId: string, key: string) {
    const r = await q.query<OpinionRow>(`${MIS_OPINIONES} AND k.public_id = $1`, [consumoId]);
    const o = r.rows[0];
    if (!o) return null;
    if (o.clave_idempotencia === key) return toOpinion(o);
    throw conflict('OPINION_YA_ENVIADA', o.descartada ? 'Ya cerraste la tarjeta de ese almuerzo.' : 'Ya opinaste sobre ese almuerzo.');
  }

  private async one(q: Queryable, consumoId: string) {
    return toOpinion((await q.query<OpinionRow>(`${MIS_OPINIONES} AND k.public_id = $1`, [consumoId])).rows[0]!);
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis')
export class DinerFeedbackController {
  constructor(private readonly svc: DinerFeedbackService) {}

  @Get('opiniones/pendientes')
  @ApiOperation({
    summary: 'Tarjetas "¿Qué tal hoy?" por responder',
    description: `Almuerzos propios no revertidos, de ${OPINION_DELAY_MINUTES} minutos a ${OPINION_TTL_HOURS} horas de antigüedad, sin opinión ni descarte.`,
  })
  @ApiOkResponse({ type: [PendienteResponse] })
  pending(@CurrentUser() user: AuthUser) {
    return this.svc.pending(user);
  }

  @Get('opiniones')
  @ApiOperation({ summary: 'Mis opiniones enviadas, con la respuesta del restaurante' })
  @ApiOkResponse({ type: [OpinionResponse] })
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Post('consumos/:id/opinion')
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Opinar sobre un almuerzo mío',
    description: `Una por almuerzo. Etiquetas cerradas y comentario privado (solo lo lee el restaurante).`,
  })
  @ApiCreatedResponse({ type: OpinionResponse })
  @ApiProblems({
    400: ['OPINION_VACIA', 'IDEMPOTENCY_KEY_INVALIDA'],
    404: ['CONSUMO_NO_ENCONTRADO'],
    409: ['OPINION_AUN_NO_DISPONIBLE', 'OPINION_VENCIDA', 'OPINION_YA_ENVIADA', 'CONSUMO_REVERTIDO'],
  })
  submit(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @Body() dto: OpinarDto, @IdempotencyKey() key: string) {
    return this.svc.submit(user, id, dto, key);
  }

  @Post('consumos/:id/opinion/descartar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Cerrar la tarjeta sin opinar', description: 'Cuenta como la única opinión de ese almuerzo.' })
  @ApiOkResponse({ type: OpinionResponse })
  @ApiProblems({
    404: ['CONSUMO_NO_ENCONTRADO'],
    409: ['OPINION_AUN_NO_DISPONIBLE', 'OPINION_VENCIDA', 'OPINION_YA_ENVIADA', 'CONSUMO_REVERTIDO'],
  })
  dismiss(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @IdempotencyKey() key: string) {
    return this.svc.dismiss(user, id, key);
  }
}

// --- Bandeja del dueño ------------------------------------------------------------------------------------------

const FILTROS = ['TODAS', 'SIN_RESPONDER', 'RESPONDIDAS'] as const;

class BandejaQuery extends PageQuery {
  @ApiPropertyOptional({ enum: FILTROS, default: 'TODAS' }) @IsOptional() @IsIn(FILTROS) estado?: (typeof FILTROS)[number];
}
class ResponderDto {
  @ApiProperty({ example: '¡Gracias por avisar! Mañana la sopa sale bien caliente.' })
  @Text()
  @IsString()
  @Length(1, 500)
  respuesta!: string;
}

class OpinionBandeja {
  @ApiProperty({ description: 'La opinión se identifica por el public_id de su almuerzo (una por almuerzo)' }) id!: string;
  @ApiProperty({ example: { nombre: 'Ana Pérez' } }) cliente!: { nombre: string };
  @ApiProperty({ description: 'Cuándo almorzó' }) almuerzoEn!: Date;
  @ApiProperty({ example: { nombre: 'Plan semanal' } }) plan!: { nombre: string };
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ enum: ETIQUETAS, isArray: true }) etiquetas!: string[];
  @ApiPropertyOptional() comentario!: string | null;
  @ApiPropertyOptional({ example: { texto: '¡Gracias!', respondidoEn: '2026-11-13T18:00:00Z' } }) respuesta!: {
    texto: string;
    respondidoEn: Date;
  } | null;
}
class BandejaResponse {
  @ApiProperty({ type: [OpinionBandeja] }) items!: OpinionBandeja[];
  @ApiPropertyOptional() nextCursor!: string | null;
  @ApiProperty({
    description: 'Últimos 30 días (sin descartes)',
    example: { total: 12, sinResponder: 3, conComentario: 5, etiquetas: { RICO: 8, FRIO: 2 } },
  })
  resumen!: { total: number; sinResponder: number; conComentario: number; etiquetas: Record<string, number> };
}

interface InboxRow {
  consumo_public_id: string;
  cliente_nombre: string;
  consumo_en: Date;
  nombre_plan: string;
  creado_en: Date;
  etiquetas: string[];
  comentario_privado: string | null;
  respuesta_restaurante: string | null;
  respondido_en: Date | null;
  cursor_t: string;
}

const INBOX = `SELECT k.public_id AS consumo_public_id, c.nombre AS cliente_nombre, k.creado_en AS consumo_en, s.nombre_plan, o.creado_en,
       o.etiquetas, o.comentario_privado, o.respuesta_restaurante, o.respondido_en, ${CURSOR_TS('o.creado_en')} AS cursor_t
  FROM opinion o
  JOIN consumo_almuerzo k ON k.restaurante_id = o.restaurante_id AND k.consumo_id = o.consumo_id
  JOIN suscripcion_plan s ON s.suscripcion_id = k.suscripcion_id
  JOIN cliente_restaurante c ON c.restaurante_id = o.restaurante_id AND c.cliente_id = o.cliente_id
 WHERE o.restaurante_id = app_tenant_id() AND NOT o.descartada`;

const toInbox = (o: InboxRow): OpinionBandeja => ({
  id: o.consumo_public_id,
  cliente: { nombre: o.cliente_nombre },
  almuerzoEn: o.consumo_en,
  plan: { nombre: o.nombre_plan },
  creadoEn: o.creado_en,
  etiquetas: o.etiquetas,
  comentario: o.comentario_privado,
  respuesta: o.respuesta_restaurante === null ? null : { texto: o.respuesta_restaurante, respondidoEn: o.respondido_en! },
});

/** Bandeja de opiniones del dueño (con tenant: RLS tenant_total). Los descartes no se muestran. */
@Injectable()
export class InboxService {
  constructor(private readonly db: DbService) {}

  list(f: BandejaQuery): Promise<BandejaResponse> {
    const limit = f.limit ?? 20;
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<InboxRow>(
          `${INBOX}
             AND ($1 = 'TODAS' OR ($1 = 'SIN_RESPONDER') = (o.respuesta_restaurante IS NULL))
             AND ($2::timestamptz IS NULL OR (o.creado_en, k.public_id) < ($2::timestamptz, $3::uuid))
           ORDER BY o.creado_en DESC, k.public_id DESC LIMIT $4`,
          [f.estado ?? 'TODAS', cur?.t ?? null, cur?.p ?? null, limit + 1],
        );
        const sum = (
          await q.query<{ total: number; sin_responder: number; con_comentario: number; etiquetas: Record<string, number> | null }>(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE respuesta_restaurante IS NULL)::int AS sin_responder,
                    count(*) FILTER (WHERE comentario_privado IS NOT NULL)::int AS con_comentario,
                    (SELECT jsonb_object_agg(e, n) FROM (SELECT e, count(*)::int AS n FROM opinion o2, unnest(o2.etiquetas) e
                       WHERE o2.restaurante_id = app_tenant_id() AND NOT o2.descartada AND o2.creado_en > CURRENT_TIMESTAMP - interval '30 days'
                       GROUP BY e) t) AS etiquetas
               FROM opinion WHERE restaurante_id = app_tenant_id() AND NOT descartada AND creado_en > CURRENT_TIMESTAMP - interval '30 days'`,
          )
        ).rows[0]!;
        const page = r.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(toInbox),
          nextCursor: r.rows.length > limit && last ? encodeCursor(last.cursor_t, last.consumo_public_id) : null,
          resumen: { total: sum.total, sinResponder: sum.sin_responder, conComentario: sum.con_comentario, etiquetas: sum.etiquetas ?? {} },
        };
      },
      { readOnly: true },
    );
  }

  /** Una respuesta por opinión. Reenviar el mismo texto no falla; otro texto → 409. */
  reply(id: string, respuesta: string): Promise<OpinionBandeja> {
    return this.db.forRequest(async (q) => {
      const o = (
        await q.query<{ opinion_id: string; respuesta_restaurante: string | null }>(
          `SELECT o.opinion_id, o.respuesta_restaurante FROM opinion o JOIN consumo_almuerzo k ON k.consumo_id = o.consumo_id
            WHERE o.restaurante_id = app_tenant_id() AND k.public_id = $1 AND NOT o.descartada FOR UPDATE OF o`,
          [id],
        )
      ).rows[0];
      if (!o) throw notFound('OPINION_NO_ENCONTRADA', 'Opinión no encontrada.');
      if (o.respuesta_restaurante !== null && o.respuesta_restaurante !== respuesta)
        throw conflict('OPINION_YA_RESPONDIDA', 'Esa opinión ya tiene respuesta.');
      if (o.respuesta_restaurante === null)
        await q.query(
          `UPDATE opinion SET respuesta_restaurante = $2, respondido_en = CURRENT_TIMESTAMP, respondido_por_personal_id = ${PERSONAL_ACTUAL}
            WHERE restaurante_id = app_tenant_id() AND opinion_id = $1`,
          [o.opinion_id, respuesta],
        );
      return toInbox((await q.query<InboxRow>(`${INBOX} AND o.opinion_id = $1`, [o.opinion_id])).rows[0]!);
    });
  }
}

@ApiTags('opiniones')
@Controller('v1/opiniones')
export class InboxController {
  constructor(private readonly svc: InboxService) {}

  @Roles('DUENO')
  @Get()
  @ApiOperation({
    summary: 'Bandeja de opiniones de los comensales',
    description: 'Más recientes primero, con cursor. Incluye un resumen de los últimos 30 días por etiqueta.',
  })
  @ApiOkResponse({ type: BandejaResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'] })
  list(@Query() q: BandejaQuery) {
    return this.svc.list(q);
  }

  @Roles('DUENO')
  @Post(':id/responder')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Responder una opinión',
    description: 'El comensal ve la respuesta en `GET /v1/mis/opiniones`. Una por opinión.',
  })
  @ApiOkResponse({ type: OpinionBandeja })
  @ApiProblems({ 404: ['OPINION_NO_ENCONTRADA'], 409: ['OPINION_YA_RESPONDIDA'] })
  reply(@Param('id', UuidPipe) id: string, @Body() dto: ResponderDto) {
    return this.svc.reply(id, dto.respuesta);
  }
}

@Module({ controllers: [DinerFeedbackController, InboxController], providers: [DinerFeedbackService, InboxService] })
export class FeedbackModule {}
