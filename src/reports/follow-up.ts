import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { DbService } from '../db/db.service';
import { resolveRange } from './common';

const MOTIVOS = ['POR_VENCER', 'SIN_VENIR', 'PARA_RENOVAR'] as const;
type Motivo = (typeof MOTIVOS)[number];

class SeguimientoQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 3, description: 'POR_VENCER: el plan vence en este número de días o menos' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  diasVencer?: number;
  @ApiPropertyOptional({
    minimum: 3,
    maximum: 90,
    default: 7,
    description: 'SIN_VENIR: con plan vigente, sin actividad en estos días o más',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(90)
  diasSinVenir?: number;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 90,
    default: 30,
    description: 'PARA_RENOVAR: se le acabó el plan hace este número de días o menos',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  diasRenovar?: number;
}

class ClienteSeguimiento {
  @ApiProperty({ example: '12', description: 'Id del cliente dentro del local (el mismo de /v1/clientes)' }) clienteId!: string;
  @ApiProperty() nombre!: string;
  @ApiPropertyOptional({ example: '+593990000123' }) telefono!: string | null;
  @ApiProperty({ enum: MOTIVOS, isArray: true, description: 'Por qué aparece; puede tener más de uno. El primero es el más urgente.' })
  motivos!: Motivo[];
  @ApiProperty({ description: 'Almuerzos que le quedan en planes vigentes (0 si no tiene)' }) almuerzosRestantes!: number;
  @ApiPropertyOptional({ example: '2026-11-15', description: 'Vencimiento más próximo entre sus planes vigentes' }) venceEl!: string | null;
  @ApiPropertyOptional({ example: '2026-11-06', description: 'Último almuerzo servido (día local); null si nunca' }) ultimaVisita!:
    string | null;
  @ApiProperty({ description: 'Días desde su última actividad (último almuerzo o última compra de plan)' }) diasSinActividad!: number;
}
class SeguimientoResponse {
  @ApiProperty({ description: 'Hoy, en la zona del local' }) fecha!: string;
  @ApiProperty() zonaHoraria!: string;
  @ApiProperty({ description: 'Cuántos cumplen algún criterio (puede ser más que los devueltos por `limit`)' }) total!: number;
  @ApiProperty({
    type: [ClienteSeguimiento],
    description:
      'POR_VENCER primero (vence antes, antes), luego SIN_VENIR (más días sin venir, antes) y PARA_RENOVAR (el que se quedó sin plan más recién, antes)',
  })
  items!: ClienteSeguimiento[];
}

interface Row {
  cliente_id: string;
  nombre: string;
  telefono_e164: string | null;
  por_vencer: boolean;
  sin_venir: boolean;
  renovar: boolean;
  restantes: number | null;
  vence: string | null;
  visita: string | null;
  dias: number;
  total: number;
}

/**
 * Clientes a quienes conviene escribirles hoy. Todas las fechas son del día local del restaurante. La actividad de un
 * cliente es lo más reciente entre su último almuerzo servido (sin contar los devueltos) y la compra de su último plan.
 */
@Injectable()
export class FollowUpService {
  constructor(private readonly db: DbService) {}

  list(f: SeguimientoQuery): Promise<SeguimientoResponse> {
    return this.db.forRequest(
      async (q) => {
        const { hasta: hoy, zonaHoraria } = await resolveRange(q);
        const r = await q.query<Row>(
          `WITH vivos AS (
             SELECT s.cliente_id, sum(s.almuerzos_restantes)::int AS restantes, min(s.vence_el) AS vence
               FROM suscripcion_plan s
              WHERE s.restaurante_id = app_tenant_id() AND s.estado = 'ACTIVA' AND s.almuerzos_restantes > 0 AND s.vence_el >= $1::date
              GROUP BY s.cliente_id),
           compras AS (
             SELECT s.cliente_id, max((s.comprada_en AT TIME ZONE $2)::date) AS compra
               FROM suscripcion_plan s WHERE s.restaurante_id = app_tenant_id() AND s.estado <> 'ANULADA' GROUP BY s.cliente_id),
           visitas AS (
             SELECT k.cliente_id, max(k.fecha_local) AS visita
               FROM consumo_almuerzo k
              WHERE k.restaurante_id = app_tenant_id() AND k.cantidad = 1
                AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)
              GROUP BY k.cliente_id),
           base AS (
             SELECT c.cliente_id, c.nombre, c.telefono_e164, v.restantes, v.vence, vi.visita,
                    GREATEST(vi.visita, co.compra) AS actividad,
                    v.cliente_id IS NOT NULL AS vigente
               FROM cliente_restaurante c
               JOIN compras co ON co.cliente_id = c.cliente_id
               LEFT JOIN vivos v ON v.cliente_id = c.cliente_id
               LEFT JOIN visitas vi ON vi.cliente_id = c.cliente_id
              WHERE c.restaurante_id = app_tenant_id() AND c.activo),
           marcados AS (
             SELECT b.*,
                    (b.vigente AND b.vence <= $1::date + $3::int) AS por_vencer,
                    (b.vigente AND b.actividad <= $1::date - $4::int) AS sin_venir,
                    (NOT b.vigente AND b.actividad >= $1::date - $5::int) AS renovar
               FROM base b)
           SELECT m.cliente_id, m.nombre, m.telefono_e164, m.por_vencer, m.sin_venir, m.renovar,
                  COALESCE(m.restantes, 0) AS restantes, m.vence::text AS vence, m.visita::text AS visita,
                  ($1::date - m.actividad)::int AS dias, count(*) OVER ()::int AS total
             FROM marcados m
            WHERE m.por_vencer OR m.sin_venir OR m.renovar
            ORDER BY CASE WHEN m.por_vencer THEN 0 WHEN m.sin_venir THEN 1 ELSE 2 END,
                     CASE WHEN m.por_vencer THEN m.vence END ASC NULLS LAST,
                     CASE WHEN NOT m.por_vencer AND m.sin_venir THEN m.actividad END ASC NULLS LAST,
                     CASE WHEN NOT m.por_vencer AND NOT m.sin_venir THEN m.actividad END DESC NULLS LAST,
                     m.cliente_id
            LIMIT $6`,
          [hoy, zonaHoraria, f.diasVencer ?? 3, f.diasSinVenir ?? 7, f.diasRenovar ?? 30, f.limit ?? 20],
        );
        return {
          fecha: hoy,
          zonaHoraria,
          total: r.rows[0]?.total ?? 0,
          items: r.rows.map((x) => ({
            clienteId: String(x.cliente_id),
            nombre: x.nombre,
            telefono: x.telefono_e164,
            motivos: [x.por_vencer && 'POR_VENCER', x.sin_venir && 'SIN_VENIR', x.renovar && 'PARA_RENOVAR'].filter(Boolean) as Motivo[],
            almuerzosRestantes: x.restantes ?? 0,
            venceEl: x.vence,
            ultimaVisita: x.visita,
            diasSinActividad: x.dias,
          })),
        };
      },
      { readOnly: true },
    );
  }
}

@ApiTags('reportes')
@Controller('v1/reportes')
export class FollowUpController {
  constructor(private readonly svc: FollowUpService) {}

  @Roles('DUENO')
  @Get('clientes-a-contactar')
  @ApiOperation({
    summary: 'Clientes a quienes escribirles',
    description:
      '`POR_VENCER`: plan vigente que vence pronto con almuerzos sin usar. `SIN_VENIR`: pagó un plan vigente pero hace días que no viene. `PARA_RENOVAR`: se le acabó o venció el plan hace poco y no tiene otro. Un cliente trae todos sus motivos; los umbrales se ajustan por query. Sin paginación: el más urgente primero y `total` dice cuántos hay.',
  })
  @ApiOkResponse({ type: SeguimientoResponse })
  list(@Query() q: SeguimientoQuery) {
    return this.svc.list(q);
  }
}
