import { Body, Controller, HttpStatus, Inject, Injectable, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, BusinessError, notFound, unprocessable } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DbService, Queryable } from '../db/db.service';
import { RateLimit } from '../security/rate-limit';

/** Un lote trae hasta 50 eventos; cada uno, propiedades de hasta 1 KB y 20 claves; un usuario, hasta 500 eventos por minuto. */
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_PROPS_BYTES = 1024;
export const MAX_PROPS_KEYS = 20;
export const MAX_EVENTS_PER_USER_MINUTE = 500;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_FUTURE_MS = 5 * 60_000;
const TIPO = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const PLATAFORMAS = ['ANDROID', 'IOS', 'WEB'] as const;

class EventoDto {
  @ApiProperty({
    example: 'oferta.impresion',
    description: 'minúsculas, dígitos y `_`, con puntos para agrupar (`menu.visto`)',
    maxLength: 60,
  })
  @IsString()
  @Length(3, 60)
  @Matches(TIPO, { message: 'tipo inválido: usa minúsculas, dígitos, _ y puntos (menu.visto)' })
  tipo!: string;
  @ApiPropertyOptional({
    example: '2026-11-18T15:04:05Z',
    description: 'Cuándo ocurrió en el dispositivo. De hace 7 días a 5 minutos en el futuro; por defecto, ahora.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  ocurridoEn?: string;
  @ApiPropertyOptional({ description: 'Local al que se refiere (public_id)' }) @IsOptional() @IsUUID() restauranteId?: string;
  @ApiPropertyOptional({ description: 'Solo para verificar: si se manda, debe ser el usuario de la sesión; el de otro se rechaza' })
  @IsOptional()
  @IsUUID()
  usuarioId?: string;
  @ApiPropertyOptional({
    example: { oferta: 'uuid', posicion: 2 },
    description: `Objeto plano, hasta ${MAX_PROPS_KEYS} claves y ${MAX_PROPS_BYTES} bytes`,
  })
  @IsOptional()
  @IsObject()
  propiedades?: Record<string, unknown>;
}

class LoteEventosDto {
  @ApiPropertyOptional({ description: 'Sesión de la app (UUID generado por el cliente)' }) @IsOptional() @IsUUID() sesionId?: string;
  @ApiPropertyOptional({ enum: PLATAFORMAS }) @IsOptional() @IsIn(PLATAFORMAS) plataforma?: (typeof PLATAFORMAS)[number];
  @ApiPropertyOptional({ example: '1.4.2', maxLength: 20 }) @IsOptional() @IsString() @Length(1, 20) versionApp?: string;
  @ApiProperty({ type: [EventoDto], minItems: 1, maxItems: MAX_EVENTS_PER_BATCH })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENTS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => EventoDto)
  eventos!: EventoDto[];
}

class LoteResponse {
  @ApiProperty({ example: 12, description: 'Eventos guardados de este lote' }) aceptados!: number;
  @ApiProperty({
    description:
      'true si el usuario no dio su consentimiento de analítica: los eventos se guardaron sin su identidad (sin usuario ni sesión)',
  })
  anonimizado!: boolean;
}

/**
 * Ingesta de eventos de producto. Protegida (JWT): el evento siempre es de quien tiene la sesión, así que un lote que
 * nombre a otro usuario se rechaza completo. Sin consentimiento de analítica los eventos entran anonimizados.
 */
@Injectable()
export class EventsService {
  constructor(
    private readonly db: DbService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ingest(user: AuthUser, dto: LoteEventosDto, key: string): Promise<LoteResponse> {
    const now = Date.now();
    const times = dto.eventos.map((e, i) => {
      if (e.usuarioId !== undefined && e.usuarioId.toLowerCase() !== user.publicId)
        throw new BusinessError(
          HttpStatus.FORBIDDEN,
          'EVENTO_USUARIO_AJENO',
          `El evento ${i} nombra a otro usuario: solo puedes enviar eventos propios.`,
        );
      const props = e.propiedades ?? {};
      if (Object.keys(props).length > MAX_PROPS_KEYS || Buffer.byteLength(JSON.stringify(props)) > MAX_PROPS_BYTES)
        throw unprocessable(
          'EVENTO_MUY_GRANDE',
          `Las propiedades del evento ${i} superan ${MAX_PROPS_KEYS} claves o ${MAX_PROPS_BYTES} bytes.`,
        );
      const t = e.ocurridoEn === undefined ? now : Date.parse(e.ocurridoEn);
      if (Number.isNaN(t) || t < now - MAX_AGE_MS || t > now + MAX_FUTURE_MS)
        throw unprocessable(
          'EVENTO_FECHA_INVALIDA',
          `El evento ${i} ocurrió fuera de la ventana aceptada (7 días atrás a 5 minutos adelante).`,
        );
      return new Date(t).toISOString();
    });

    return this.db.scope({ userId: user.userId }, async (q) => {
      const prev = await this.stored(q, key);
      if (prev) return prev;

      const rate = (
        await q.query<{ lotes: number; eventos: number }>(
          `SELECT count(*)::int AS lotes, COALESCE(sum(eventos), 0)::int AS eventos FROM evento_lote
            WHERE usuario_id = app_user_id() AND creado_en > CURRENT_TIMESTAMP - interval '1 minute'`,
        )
      ).rows[0]!;
      if (rate.lotes >= this.env.EVENTS_USER_BATCHES_PER_MINUTE || rate.eventos + dto.eventos.length > MAX_EVENTS_PER_USER_MINUTE)
        throw new BusinessError(
          HttpStatus.TOO_MANY_REQUESTS,
          'EVENTOS_LIMITE_TASA',
          'Demasiados eventos en el último minuto. Reintenta en unos segundos.',
        );

      const ids = [...new Set(dto.eventos.flatMap((e) => (e.restauranteId ? [e.restauranteId.toLowerCase()] : [])))];
      const rests = new Map<string, { id: string; pais: string; ciudad: string; zona: string | null }>();
      if (ids.length) {
        const r = await q.query<{
          public_id: string;
          restaurante_id: string;
          pais_codigo: string;
          ciudad_id: string;
          zona_id: string | null;
        }>('SELECT public_id, restaurante_id, pais_codigo, ciudad_id, zona_id FROM restaurante WHERE public_id = ANY($1::uuid[])', [ids]);
        for (const x of r.rows) rests.set(x.public_id, { id: x.restaurante_id, pais: x.pais_codigo, ciudad: x.ciudad_id, zona: x.zona_id });
        const missing = ids.find((id) => !rests.has(id));
        if (missing) throw notFound('RESTAURANTE_NO_ENCONTRADO', `El restaurante ${missing} no existe.`);
      }

      const anonimizado = !(await q.query<{ c: boolean }>('SELECT fn_consiente_analitica() AS c')).rows[0]!.c;
      // Reclama la llave: si otra petición simultánea con la misma llave ya la tomó, espera a que termine y devuelve su resultado.
      const claimed = await q.query(
        `INSERT INTO evento_lote (usuario_id, clave_idempotencia, eventos, anonimizado) VALUES (app_user_id(), $1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [key, dto.eventos.length, anonimizado],
      );
      if (!claimed.rowCount) return (await this.stored(q, key))!;

      const rest = dto.eventos.map((e) => (e.restauranteId ? rests.get(e.restauranteId.toLowerCase())! : null));
      await q.query(
        `INSERT INTO evento_analitica (ocurrido_en, tipo, usuario_id, restaurante_id, sesion_id, plataforma, version_app, pais_codigo, ciudad_id, zona_id, propiedades)
         SELECT e.ocurrido_en, e.tipo, $5::bigint, e.restaurante_id, $6::uuid, $7::plataforma_enum, $8, e.pais, e.ciudad, e.zona, e.props::jsonb
           FROM unnest($1::timestamptz[], $2::text[], $3::bigint[], $4::text[], $9::text[], $10::bigint[], $11::bigint[])
                AS e(ocurrido_en, tipo, restaurante_id, props, pais, ciudad, zona)`,
        [
          times,
          dto.eventos.map((e) => e.tipo),
          rest.map((r) => r?.id ?? null),
          dto.eventos.map((e) => JSON.stringify(e.propiedades ?? {})),
          anonimizado ? null : user.userId,
          anonimizado ? null : (dto.sesionId ?? null),
          dto.plataforma ?? null,
          dto.versionApp ?? null,
          rest.map((r) => r?.pais ?? null),
          rest.map((r) => r?.ciudad ?? null),
          rest.map((r) => r?.zona ?? null),
        ],
      );
      return { aceptados: dto.eventos.length, anonimizado };
    });
  }

  private async stored(q: Queryable, key: string): Promise<LoteResponse | null> {
    const r = await q.query<{ eventos: number; anonimizado: boolean }>(
      'SELECT eventos, anonimizado FROM evento_lote WHERE usuario_id = app_user_id() AND clave_idempotencia = $1',
      [key],
    );
    return r.rows[0] ? { aceptados: r.rows[0].eventos, anonimizado: r.rows[0].anonimizado } : null;
  }
}

@ApiTags('eventos')
@ApiBearerAuth()
@Controller('v1/eventos')
export class EventsController {
  constructor(private readonly svc: EventsService) {}

  @Post()
  @RateLimit('events')
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Enviar eventos de producto en lote',
    description: `Hasta ${MAX_EVENTS_PER_BATCH} eventos por lote (cuerpo máximo 100 kB). Todo el lote se guarda o se rechaza. Los eventos son siempre de la sesión: si uno nombra a otro usuario, se rechaza el lote. La misma \`Idempotency-Key\` devuelve el mismo resultado sin duplicar eventos.`,
  })
  @ApiCreatedResponse({ type: LoteResponse })
  @ApiProblems({
    403: ['EVENTO_USUARIO_AJENO'],
    404: ['RESTAURANTE_NO_ENCONTRADO'],
    422: ['EVENTO_MUY_GRANDE', 'EVENTO_FECHA_INVALIDA'],
    429: ['EVENTOS_LIMITE_TASA'],
  })
  ingest(@CurrentUser() user: AuthUser, @Body() dto: LoteEventosDto, @IdempotencyKey() key: string) {
    return this.svc.ingest(user, dto, key);
  }
}

@Module({ controllers: [EventsController], providers: [EventsService] })
export class EventsModule {}
