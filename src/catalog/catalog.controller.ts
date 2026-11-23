import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { Public } from '../authz/public.decorator';
import { ApiProblems } from '../common/errors';
import { Text } from '../security/sanitize';
import { CatalogService } from './catalog.service';
import { CartaResponse, RestauranteBusquedaResponse, RestauranteDetalleResponse } from './dto';

/** La carta cambia cuando el dueño o el cajero tocan un plato: ningún cliente ni intermediario debe guardarla. */
const CARTA_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';
const CARTA_HEADERS = {
  'Cache-Control': {
    description: 'Siempre `no-store, no-cache, must-revalidate`: la carta no se guarda en caché (tampoco el 404).',
    schema: { type: 'string', example: CARTA_CACHE_CONTROL },
  },
} as const;

class SearchQuery {
  @ApiPropertyOptional({ description: 'Texto a buscar en el nombre' }) @IsOptional() @Text() @IsString() @Length(1, 60) q?: string;
  @ApiPropertyOptional({ description: 'zona_id del catálogo' })
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,17}$/, { message: 'zonaId inválido' })
  zonaId?: string;
  @ApiPropertyOptional({ description: 'ciudad_id del catálogo' })
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,17}$/, { message: 'ciudadId inválido' })
  ciudadId?: string;
  @ApiPropertyOptional({ description: 'Etiqueta del local' }) @IsOptional() @Text() @IsString() @Length(1, 30) etiqueta?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ description: 'nextCursor de la página anterior' }) @IsOptional() @IsString() @Length(1, 300) cursor?: string;
}

@Public()
@ApiTags('vitrina')
@Controller('v1/restaurantes')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'Buscar restaurantes por zona, ciudad, texto o etiqueta',
    description:
      'Público, sin token. Solo restaurantes activos. Paginación por cursor: máximo 50 por página; pasa `nextCursor` como `cursor`.',
  })
  @ApiOkResponse({ type: RestauranteBusquedaResponse })
  search(@Query() q: SearchQuery) {
    return this.catalog.search({
      q: q.q,
      zonaId: q.zonaId,
      ciudadId: q.ciudadId,
      etiqueta: q.etiqueta,
      limit: q.limit ?? 20,
      cursor: q.cursor,
    });
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Detalle de un restaurante: horarios, menú publicado de hoy, planes visibles y ocupación',
    description: 'Público, sin token. Un menú sin publicar o un local en borrador o pausado no aparecen.',
  })
  @ApiOkResponse({ type: RestauranteDetalleResponse })
  @ApiProblems({ 404: ['NOT_FOUND'] })
  detail(@Param('slug') slug: string) {
    return this.catalog.detail(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 ? slug : '');
  }

  @Get(':slug/carta')
  @ApiOperation({
    summary: 'Carta fija de un restaurante (a la carta, extras y bebidas)',
    description:
      'Público, sin token. Solo platos activos con precio de un local ACTIVO; no depende del menú del día. `agotado` vale hasta medianoche (hora del local).',
  })
  @ApiOkResponse({ type: CartaResponse, headers: CARTA_HEADERS })
  @ApiProblems({ 404: ['RESTAURANTE_NO_ENCONTRADO'] }, { headers: CARTA_HEADERS })
  carta(@Param('slug') slug: string, @Res({ passthrough: true }) reply: FastifyReply) {
    // Antes de consultar: así el 404 del filtro de errores (misma respuesta) también la lleva.
    void reply.header('cache-control', CARTA_CACHE_CONTROL);
    return this.catalog.carta(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 ? slug : '');
  }
}
