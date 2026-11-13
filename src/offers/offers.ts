import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Public } from '../authz/public.decorator';
import { Roles } from '../authz/roles.decorator';
import { PERSONAL_ACTUAL } from '../checkout/checkout';
import { ApiProblems, notFound, unprocessable } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { CURSOR_TS, PageQuery, decodeCursor, encodeCursor } from '../diner/common';
import { Text } from '../security/sanitize';

export const ESTADOS_OFERTA = ['VIGENTE', 'PROGRAMADA', 'AGOTADA', 'EXPIRADA', 'CERRADA'] as const;
type EstadoOferta = (typeof ESTADOS_OFERTA)[number];

class PublicarOfertaDto {
  @ApiProperty({ example: 'Churrasco a mitad de tarde', maxLength: 80 }) @Text() @IsString() @Length(1, 80) titulo!: string;
  @ApiPropertyOptional({ example: 'Últimos churrascos del día', maxLength: 300 })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 300)
  descripcion?: string;
  @ApiPropertyOptional({ description: 'Plato del catálogo (public_id) al que corresponde la oferta' })
  @IsOptional()
  @IsUUID()
  platoId?: string;
  @ApiProperty({ example: 450, description: 'Precio de la oferta en centavos; debe ser menor que el original' })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  precioCentavos!: number;
  @ApiProperty({ example: 650, description: 'Precio normal en centavos' }) @IsInt() @Min(1) @Max(1_000_000) precioOriginalCentavos!: number;
  @ApiProperty({ example: 8, minimum: 1, maximum: 1000, description: 'Unidades disponibles' }) @IsInt() @Min(1) @Max(1000) stock!: number;
  @ApiPropertyOptional({ example: 120, minimum: 5, maximum: 1440, default: 120, description: 'Cuánto dura desde que se publica' })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  duracionMinutos?: number;
}

class OfertasQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ESTADOS_OFERTA, description: 'Sin filtro devuelve todas' })
  @IsOptional()
  @IsIn(ESTADOS_OFERTA)
  estado?: EstadoOferta;
}

class OfertaResponse {
  @ApiProperty({ description: 'public_id' }) id!: string;
  @ApiProperty() titulo!: string;
  @ApiPropertyOptional() descripcion!: string | null;
  @ApiPropertyOptional({ example: { id: 'uuid', nombre: 'Churrasco' } }) plato!: { id: string; nombre: string } | null;
  @ApiProperty({ description: 'Centavos' }) precioCentavos!: number;
  @ApiProperty({ description: 'Centavos' }) precioOriginalCentavos!: number;
  @ApiProperty({ description: 'Descuento entero sobre el precio original' }) descuentoPorcentaje!: number;
  @ApiProperty({ example: 'USD' }) moneda!: string;
  @ApiProperty() stockTotal!: number;
  @ApiProperty({ description: 'Nunca negativo' }) stockRestante!: number;
  @ApiProperty({ description: 'Unidades ya canjeadas' }) canjeadas!: number;
  @ApiProperty() iniciaEn!: Date;
  @ApiProperty() expiraEn!: Date;
  @ApiProperty({ enum: ESTADOS_OFERTA, description: 'CERRADA tiene prioridad; luego AGOTADA, EXPIRADA, PROGRAMADA y VIGENTE' })
  estado!: EstadoOferta;
}
class OfertasPage {
  @ApiProperty({ type: [OfertaResponse] }) items!: OfertaResponse[];
  @ApiPropertyOptional() nextCursor!: string | null;
}
class OfertasPublicas {
  @ApiProperty({ type: [OfertaResponse], description: 'Solo vigentes con stock' }) items!: OfertaResponse[];
}

interface OfertaRow {
  public_id: string;
  titulo: string;
  descripcion: string | null;
  plato_public_id: string | null;
  plato_nombre: string | null;
  precio_centavos: string;
  precio_original_centavos: string;
  moneda_codigo: string;
  stock_total: number;
  stock_restante: number;
  canjeadas: number;
  inicia_en: Date;
  expira_en: Date;
  estado: EstadoOferta;
  cursor_t: string;
}

/** Estado derivado de la oferta; la hora es la de la base (CURRENT_TIMESTAMP), nunca la del cliente. */
export const OFERTAS = `SELECT o.public_id, o.titulo, o.descripcion, o.precio_centavos, o.precio_original_centavos, o.moneda_codigo,
       o.stock_total, o.stock_restante, o.inicia_en, o.expira_en, o.creada_en,
       p.public_id AS plato_public_id, p.nombre AS plato_nombre,
       (SELECT COALESCE(SUM(c.cantidad), 0)::int FROM canje_oferta_flash c
         WHERE c.restaurante_id = o.restaurante_id AND c.oferta_flash_id = o.oferta_flash_id) AS canjeadas,
       CASE WHEN NOT o.activa THEN 'CERRADA'
            WHEN o.stock_restante = 0 THEN 'AGOTADA'
            WHEN o.expira_en <= CURRENT_TIMESTAMP THEN 'EXPIRADA'
            WHEN o.inicia_en > CURRENT_TIMESTAMP THEN 'PROGRAMADA'
            ELSE 'VIGENTE' END AS estado,
       ${CURSOR_TS('o.creada_en')} AS cursor_t
  FROM oferta_flash o
  LEFT JOIN plato p ON p.restaurante_id = o.restaurante_id AND p.plato_id = o.plato_id`;

export const toOferta = (r: OfertaRow): OfertaResponse => {
  const precio = Number(r.precio_centavos);
  const original = Number(r.precio_original_centavos);
  return {
    id: r.public_id,
    titulo: r.titulo,
    descripcion: r.descripcion,
    plato: r.plato_public_id ? { id: r.plato_public_id, nombre: r.plato_nombre! } : null,
    precioCentavos: precio,
    precioOriginalCentavos: original,
    descuentoPorcentaje: Math.round(((original - precio) * 100) / original),
    moneda: r.moneda_codigo,
    stockTotal: r.stock_total,
    stockRestante: r.stock_restante,
    canjeadas: r.canjeadas,
    iniciaEn: r.inicia_en,
    expiraEn: r.expira_en,
    estado: r.estado,
  };
};

/** Oferta del local activo por public_id, o 404 (también si es de otro local: RLS no la deja ver). */
export async function offerOf(q: Queryable, publicId: string): Promise<OfertaResponse> {
  const r = await q.query<OfertaRow>(`${OFERTAS} WHERE o.restaurante_id = app_tenant_id() AND o.public_id = $1`, [publicId]);
  if (!r.rows[0]) throw notFound('OFERTA_NO_ENCONTRADA', 'Oferta no encontrada.');
  return toOferta(r.rows[0]);
}

/**
 * Ofertas flash: el dueño publica una cantidad limitada de unidades a precio rebajado por un rato. Modelo SaaS: el
 * local paga su suscripción y se queda con todo lo que cobra; Bocadoo no cobra comisión por canje.
 */
@Injectable()
export class OffersService {
  constructor(private readonly db: DbService) {}

  async publish(dto: PublicarOfertaDto, key: string): Promise<OfertaResponse> {
    if (dto.precioCentavos >= dto.precioOriginalCentavos)
      throw unprocessable('OFERTA_PRECIO_INVALIDO', 'El precio de la oferta debe ser menor que el precio original.');
    try {
      return await this.db.forRequest(async (q) => {
        const again = await q.query<{ public_id: string }>(
          'SELECT public_id FROM oferta_flash WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1',
          [key],
        );
        if (again.rows[0]) return offerOf(q, again.rows[0].public_id);
        let platoId: string | null = null;
        if (dto.platoId) {
          const p = await q.query<{ plato_id: string }>(
            'SELECT plato_id FROM plato WHERE restaurante_id = app_tenant_id() AND public_id = $1 AND activo',
            [dto.platoId],
          );
          if (!p.rows[0]) throw notFound('PLATO_NO_ENCONTRADO', 'El plato no existe o está inactivo.');
          platoId = p.rows[0].plato_id;
        }
        const r = await q.query<{ public_id: string }>(
          `INSERT INTO oferta_flash (restaurante_id, plato_id, titulo, descripcion, precio_centavos, precio_original_centavos, moneda_codigo,
                                     stock_total, stock_restante, inicia_en, expira_en, creada_por_personal_id, clave_idempotencia)
           SELECT app_tenant_id(), $1, $2, $3, $4, $5, r.moneda_codigo, $6, $6, CURRENT_TIMESTAMP,
                  CURRENT_TIMESTAMP + make_interval(mins => $7), ${PERSONAL_ACTUAL}, $8
             FROM restaurante r WHERE r.restaurante_id = app_tenant_id()
           RETURNING public_id`,
          [
            platoId,
            dto.titulo,
            dto.descripcion ?? null,
            dto.precioCentavos,
            dto.precioOriginalCentavos,
            dto.stock,
            dto.duracionMinutos ?? 120,
            key,
          ],
        );
        return offerOf(q, r.rows[0]!.public_id);
      });
    } catch (err) {
      // Misma clave en dos peticiones simultáneas: gana una y la otra devuelve esa misma oferta.
      if (
        (err as { code?: string }).code === '23505' &&
        (err as { constraint?: string }).constraint === 'oferta_flash_clave_idempotencia_key'
      ) {
        return this.db.forRequest(async (q) => {
          const r = await q.query<{ public_id: string }>(
            'SELECT public_id FROM oferta_flash WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1',
            [key],
          );
          return offerOf(q, r.rows[0]!.public_id);
        });
      }
      throw err;
    }
  }

  list(f: OfertasQuery): Promise<OfertasPage> {
    const limit = f.limit ?? 20;
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<OfertaRow>(
          `SELECT * FROM (${OFERTAS} WHERE o.restaurante_id = app_tenant_id()) x
            WHERE ($1::text IS NULL OR x.estado = $1)
              AND ($2::timestamptz IS NULL OR (x.creada_en, x.public_id) < ($2::timestamptz, $3::uuid))
            ORDER BY x.creada_en DESC, x.public_id DESC
            LIMIT $4`,
          [f.estado ?? null, cur?.t ?? null, cur?.p ?? null, limit + 1],
        );
        const page = r.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(toOferta),
          nextCursor: r.rows.length > limit && last ? encodeCursor(last.cursor_t, last.public_id) : null,
        };
      },
      { readOnly: true },
    );
  }

  /** Cerrar es definitivo y repetirlo no hace daño: la oferta queda CERRADA y deja de aceptar canjes. */
  close(id: string): Promise<OfertaResponse> {
    return this.db.forRequest(async (q) => {
      const r = await q.query('UPDATE oferta_flash SET activa = false WHERE restaurante_id = app_tenant_id() AND public_id = $1', [id]);
      if (!r.rowCount) throw notFound('OFERTA_NO_ENCONTRADA', 'Oferta no encontrada.');
      return offerOf(q, id);
    });
  }

  /** Vitrina: lo que el comensal puede canjear ahora mismo en un local activo. */
  async publicList(slug: string): Promise<OfertasPublicas> {
    return this.db.scope({ readOnly: true }, async (q) => {
      const rest = await q.query<{ restaurante_id: string }>(
        `SELECT restaurante_id FROM restaurante WHERE slug = $1 AND estado = 'ACTIVO'`,
        [slug],
      );
      if (!rest.rows[0]) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
      const r = await q.query<OfertaRow>(
        `SELECT * FROM (${OFERTAS} WHERE o.restaurante_id = $1) x WHERE x.estado = 'VIGENTE' ORDER BY x.expira_en, x.public_id`,
        [rest.rows[0].restaurante_id],
      );
      return { items: r.rows.map(toOferta) };
    });
  }
}

@ApiTags('ofertas')
@Controller('v1/ofertas')
export class OffersController {
  constructor(private readonly svc: OffersService) {}

  @Roles('DUENO')
  @Post()
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Publicar una oferta flash',
    description: 'Empieza al publicarse y dura `duracionMinutos`. El stock nunca baja de cero aunque se canjee en paralelo.',
  })
  @ApiCreatedResponse({ type: OfertaResponse })
  @ApiProblems({ 404: ['PLATO_NO_ENCONTRADO'], 422: ['OFERTA_PRECIO_INVALIDO'] })
  publish(@Body() dto: PublicarOfertaDto, @IdempotencyKey() key: string) {
    return this.svc.publish(dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Ofertas del local', description: 'Más recientes primero, con cursor. Filtro opcional por estado.' })
  @ApiOkResponse({ type: OfertasPage })
  list(@Query() q: OfertasQuery) {
    return this.svc.list(q);
  }

  @Roles('DUENO')
  @Post(':id/cerrar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cerrar una oferta', description: 'Deja de aceptar canjes. Repetirlo devuelve la misma oferta ya cerrada.' })
  @ApiOkResponse({ type: OfertaResponse })
  @ApiProblems({ 404: ['OFERTA_NO_ENCONTRADA'] })
  close(@Param('id', UuidPipe) id: string) {
    return this.svc.close(id);
  }
}

@Public()
@ApiTags('vitrina')
@Controller('v1/restaurantes')
export class PublicOffersController {
  constructor(private readonly svc: OffersService) {}

  @Get(':slug/ofertas')
  @ApiOperation({ summary: 'Ofertas flash vigentes de un local', description: 'Sin token. Solo las que están vigentes y con stock.' })
  @ApiOkResponse({ type: OfertasPublicas })
  @ApiProblems({ 404: ['RESTAURANTE_NO_ENCONTRADO'] })
  list(@Param('slug') slug: string) {
    return this.svc.publicList(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 ? slug : '');
  }
}

@Module({ controllers: [OffersController, PublicOffersController], providers: [OffersService] })
export class OffersModule {}
