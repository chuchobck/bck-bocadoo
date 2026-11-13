import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { IdPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';

const TIPOS = ['SEMANAL', 'QUINCENAL', 'MENSUAL', 'LIBRE'] as const;
const present = () => ValidateIf((_: unknown, v: unknown) => v !== undefined);

export class CrearPlanDto {
  @ApiProperty({ enum: TIPOS }) @IsIn(TIPOS) tipo!: string;
  @ApiProperty({ example: 'Plan semanal' }) @Text() @IsString() @Length(2, 80) nombre!: string;
  @ApiProperty({ example: 5 }) @IsInt() @Min(1) @Max(200) almuerzos!: number;
  @ApiProperty({ example: 1500, description: 'Centavos' }) @IsInt() @Min(1) @Max(100_000_000) precioCentavos!: number;
  @ApiProperty({ example: 7, description: 'Días de vigencia desde la compra' }) @IsInt() @Min(1) @Max(366) vigenciaDias!: number;
  @ApiPropertyOptional({ nullable: true, description: 'Máximo de planes activos vendidos a la vez; vacío = sin límite' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  cupos?: number | null;
  @ApiPropertyOptional({ example: [1, 2, 3, 4, 5], description: 'ISO: 1 = lunes … 7 = domingo' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  diasValidos?: number[];
  @ApiPropertyOptional({ type: [String], example: ['jugo', 'sopa', 'segundo'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  incluye?: string[];
  @ApiPropertyOptional({ description: 'Mostrar en la vitrina pública' }) @IsOptional() @IsBoolean() visibleEnMarketplace?: boolean;
}

export class ActualizarPlanDto {
  @ApiPropertyOptional({ enum: TIPOS }) @present() @IsIn(TIPOS) tipo?: string;
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(2, 80) nombre?: string;
  @ApiPropertyOptional() @present() @IsInt() @Min(1) @Max(200) almuerzos?: number;
  @ApiPropertyOptional() @present() @IsInt() @Min(1) @Max(100_000_000) precioCentavos?: number;
  @ApiPropertyOptional() @present() @IsInt() @Min(1) @Max(366) vigenciaDias?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(1) @Max(100_000) cupos?: number | null;
  @ApiPropertyOptional()
  @present()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  diasValidos?: number[];
  @ApiPropertyOptional()
  @present()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  incluye?: string[];
  @ApiPropertyOptional() @present() @IsBoolean() visibleEnMarketplace?: boolean;
  @ApiPropertyOptional() @present() @IsBoolean() activo?: boolean;
}

const COLS = {
  tipo: 'tipo',
  nombre: 'nombre',
  almuerzos: 'almuerzos',
  precioCentavos: 'precio_centavos',
  vigenciaDias: 'vigencia_dias',
  cupos: 'cupos',
  diasValidos: 'dias_validos',
  incluye: 'incluye',
  visibleEnMarketplace: 'visible_en_marketplace',
  activo: 'activo',
} as const;

interface PlanRow {
  plantilla_plan_id: string;
  tipo: string;
  nombre: string;
  almuerzos: number;
  precio_centavos: string;
  vigencia_dias: number;
  cupos: number | null;
  dias_validos: number[];
  incluye: string[];
  visible_en_marketplace: boolean;
  activo: boolean;
  activos: number;
}

const SELECT = `SELECT p.plantilla_plan_id, p.tipo, p.nombre, p.almuerzos, p.precio_centavos, p.vigencia_dias, p.cupos, p.dias_validos, p.incluye,
       p.visible_en_marketplace, p.activo,
       (SELECT count(*)::int FROM suscripcion_plan s WHERE s.restaurante_id = p.restaurante_id AND s.plantilla_plan_id = p.plantilla_plan_id AND s.estado = 'ACTIVA') AS activos
  FROM plantilla_plan p`;

const toPlan = (p: PlanRow) => ({
  id: p.plantilla_plan_id,
  tipo: p.tipo,
  nombre: p.nombre,
  almuerzos: p.almuerzos,
  precioCentavos: Number(p.precio_centavos),
  vigenciaDias: p.vigencia_dias,
  cupos: p.cupos,
  cuposDisponibles: p.cupos === null ? null : Math.max(0, p.cupos - p.activos),
  vendidosActivos: p.activos,
  diasValidos: p.dias_validos,
  incluye: p.incluye,
  visibleEnMarketplace: p.visible_en_marketplace,
  activo: p.activo,
});

/** Plantillas de plan. Editarlas nunca toca lo ya vendido: la venta copia nombre, almuerzos, precio, días y vencimiento. */
@Injectable()
export class PlansService {
  constructor(private readonly db: DbService) {}

  list() {
    return this.db.forRequest(
      async (q) =>
        (
          await q.query<PlanRow>(`${SELECT} WHERE p.restaurante_id = app_tenant_id() ORDER BY p.activo DESC, p.almuerzos, p.nombre`)
        ).rows.map(toPlan),
      { readOnly: true },
    );
  }

  create(d: CrearPlanDto) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ plantilla_plan_id: string }>(
        `INSERT INTO plantilla_plan (restaurante_id, tipo, nombre, almuerzos, precio_centavos, vigencia_dias, cupos, dias_validos, incluye, visible_en_marketplace)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, COALESCE($7::smallint[], '{1,2,3,4,5}'), $8, $9) RETURNING plantilla_plan_id`,
        [
          d.tipo,
          d.nombre,
          d.almuerzos,
          d.precioCentavos,
          d.vigenciaDias,
          d.cupos ?? null,
          d.diasValidos ?? null,
          d.incluye ?? [],
          d.visibleEnMarketplace ?? false,
        ],
      );
      return this.one(q, r.rows[0]!.plantilla_plan_id);
    });
  }

  update(id: string, d: ActualizarPlanDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, col] of Object.entries(COLS) as [keyof ActualizarPlanDto, string][]) {
      if (d[k] === undefined) continue;
      params.push(d[k]);
      sets.push(`${col} = $${params.length}${col === 'dias_validos' ? '::smallint[]' : ''}`);
    }
    if (!sets.length) throw new BadRequestException('No hay nada que actualizar.');
    return this.db.forRequest(async (q) => {
      const r = await q.query(
        `UPDATE plantilla_plan SET ${sets.join(', ')}, actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND plantilla_plan_id = $1`,
        params,
      );
      if (!r.rowCount) throw new NotFoundException('Plan no encontrado.');
      return this.one(q, id);
    });
  }

  private async one(q: Queryable, id: string) {
    const r = await q.query<PlanRow>(`${SELECT} WHERE p.restaurante_id = app_tenant_id() AND p.plantilla_plan_id = $1`, [id]);
    return toPlan(r.rows[0]!);
  }
}

@ApiTags('planes')
@Controller('v1/planes')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Plantillas de plan del restaurante, con cupos disponibles' })
  list() {
    return this.plans.list();
  }

  @Roles('DUENO')
  @Post()
  @ApiOperation({ summary: 'Crear una plantilla de plan' })
  create(@Body() dto: CrearPlanDto) {
    return this.plans.create(dto);
  }

  @Roles('DUENO')
  @Patch(':id')
  @ApiOperation({ summary: 'Editar o desactivar una plantilla', description: 'No cambia los planes ya vendidos.' })
  update(@Param('id', IdPipe) id: string, @Body() dto: ActualizarPlanDto) {
    return this.plans.update(id, dto);
  }
}

@Module({ controllers: [PlansController], providers: [PlansService] })
export class PlansModule {}
