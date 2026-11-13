import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Public } from '../authz/public.decorator';
import { Text } from '../security/sanitize';
import { CatalogService } from './catalog.service';

class SearchQuery {
  @IsOptional() @Text() @IsString() @Length(1, 60) q?: string;
  @IsOptional() @Matches(/^[1-9][0-9]{0,17}$/, { message: 'zonaId inválido' }) zonaId?: string;
  @IsOptional() @Matches(/^[1-9][0-9]{0,17}$/, { message: 'ciudadId inválido' }) ciudadId?: string;
  @IsOptional() @Text() @IsString() @Length(1, 30) etiqueta?: string;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @IsOptional() @IsString() @Length(1, 300) cursor?: string;
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
  detail(@Param('slug') slug: string) {
    return this.catalog.detail(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 ? slug : '');
  }
}
