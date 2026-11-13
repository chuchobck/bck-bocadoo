import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Roles } from '../authz/roles.decorator';
import { DbService, Queryable } from '../db/db.service';
import { num, resolveRange } from '../reports/common';

const ESTADOS = ['TRIAL', 'FREEMIUM', 'ACTIVA_PRO', 'MOROSA', 'SUSPENDIDA', 'CANCELADA', 'SIN_SUSCRIPCION'] as const;
type Estado = (typeof ESTADOS)[number];
const NIVELES = ['ILIMITADO', 'NORMAL', 'CERCA_DEL_LIMITE', 'LIMITE_ALCANZADO'] as const;

class CicloResponse {
  @ApiProperty({ example: '2026-11-01', description: 'Primer día del ciclo' }) inicio!: string;
  @ApiProperty({ example: '2026-12-01', description: 'Día en que termina el ciclo' }) fin!: string;
  @ApiProperty({ description: 'Días desde hoy (hora local del local) hasta `fin`; 0 si ya pasó' }) diasRestantes!: number;
  @ApiProperty({ description: 'true si `fin` ya pasó y el ciclo no se renovó: los contadores siguen del ciclo anterior' })
  vencido!: boolean;
}
class PlanSaasResponse {
  @ApiProperty({ example: 'FREEMIUM' }) codigo!: string;
  @ApiProperty({ example: 'Gratis' }) nombre!: string;
  @ApiPropertyOptional({ description: 'Precio mensual vigente en el país del local (centavos); null si el plan no tiene precio ahí' })
  precioMensualCentavos!: number | null;
  @ApiPropertyOptional({ example: 'USD' }) moneda!: string | null;
}
class LimitesResponse {
  @ApiPropertyOptional({ description: 'Escaneos por ciclo; null = sin límite' }) escaneosMes!: number | null;
  @ApiProperty() mesaGrupal!: boolean;
  @ApiProperty() reportesAvanzados!: boolean;
}
class SuscripcionResponse {
  @ApiProperty({ enum: ESTADOS, description: '`SIN_SUSCRIPCION`: el local aún no tiene plan SaaS asignado (se comporta como sin límite)' })
  estado!: Estado;
  @ApiPropertyOptional({ type: PlanSaasResponse }) plan!: PlanSaasResponse | null;
  @ApiPropertyOptional({ type: CicloResponse }) ciclo!: CicloResponse | null;
  @ApiPropertyOptional({ example: '2026-12-01', description: 'null en planes gratuitos' }) proximoCobro!: string | null;
  @ApiProperty({ type: LimitesResponse }) limites!: LimitesResponse;
}
class UsoResponse {
  @ApiPropertyOptional({ type: CicloResponse }) ciclo!: CicloResponse | null;
  @ApiProperty({ description: 'Escaneos válidos del ciclo (un almuerzo descontado cuenta uno; deshacerlo no lo devuelve)' })
  escaneosUsados!: number;
  @ApiPropertyOptional({ description: 'null = sin límite' }) limite!: number | null;
  @ApiPropertyOptional({ description: 'Lo que queda antes del tope; null = sin límite' }) restantes!: number | null;
  @ApiPropertyOptional({ description: 'Porcentaje entero del límite usado (puede pasar de 100); null = sin límite' }) porcentaje!:
    number | null;
  @ApiProperty({
    enum: NIVELES,
    description: 'CERCA_DEL_LIMITE desde el 80 %; LIMITE_ALCANZADO desde el 100 %: la caja responde `LIMITE_SAAS`',
  })
  nivel!: (typeof NIVELES)[number];
  @ApiProperty({ description: 'Escaneos que la caja rechazó con `LIMITE_SAAS` desde que empezó el ciclo' }) rechazadosPorLimite!: number;
}

interface Row {
  estado: Exclude<Estado, 'SIN_SUSCRIPCION'>;
  codigo: string;
  nombre: string;
  limite: number | null;
  mesa: boolean;
  reportes: boolean;
  usados: number;
  inicio: string;
  fin: string;
  cobro: string | null;
  plan_saas_id: string;
}

/**
 * Suscripción SaaS del local: lo que el local le paga a Bocadoo es una mensualidad por plan (con un tope de escaneos
 * por ciclo en los planes bajos). Bocadoo no cobra comisión sobre lo que el local vende: aquí no existe ningún campo
 * ni endpoint de comisión. El local solo lee su suscripción (RLS: `tenant_lee`); la escribe el rol de servicio.
 */
@Injectable()
export class SaasService {
  constructor(private readonly db: DbService) {}

  private async current(q: Queryable) {
    const { hasta: hoy } = await resolveRange(q);
    const r = await q.query<Row>(
      `SELECT s.estado, p.codigo, p.nombre, p.limite_escaneos_mes AS limite, p.permite_mesa_grupal AS mesa,
              p.permite_reportes_avanzados AS reportes, s.escaneos_usados_ciclo_actual AS usados,
              s.inicio_ciclo_actual::text AS inicio, s.fin_ciclo_actual::text AS fin, s.proximo_cobro::text AS cobro, p.plan_saas_id
         FROM suscripcion_saas_restaurante s JOIN catalogo_plan_saas p ON p.plan_saas_id = s.plan_saas_id
        WHERE s.restaurante_id = app_tenant_id() AND s.vigente`,
    );
    const row = r.rows[0] ?? null;
    const ciclo: CicloResponse | null = row
      ? {
          inicio: row.inicio,
          fin: row.fin,
          diasRestantes: Math.max(0, (Date.parse(`${row.fin}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000),
          vencido: row.fin < hoy,
        }
      : null;
    return { row, ciclo, hoy };
  }

  subscription(): Promise<SuscripcionResponse> {
    return this.db.forRequest(
      async (q) => {
        const { row, ciclo, hoy } = await this.current(q);
        if (!row) {
          return {
            estado: 'SIN_SUSCRIPCION',
            plan: null,
            ciclo: null,
            proximoCobro: null,
            limites: { escaneosMes: null, mesaGrupal: false, reportesAvanzados: false },
          };
        }
        const precio = await q.query<{ centavos: string; moneda: string }>(
          `SELECT pr.precio_mensual_centavos AS centavos, pr.moneda_codigo AS moneda
             FROM plan_saas_precio pr JOIN restaurante r ON r.pais_codigo = pr.pais_codigo
            WHERE r.restaurante_id = app_tenant_id() AND pr.plan_saas_id = $1 AND pr.vigente_desde <= $2::date
              AND (pr.vigente_hasta IS NULL OR pr.vigente_hasta >= $2::date)
            ORDER BY pr.vigente_desde DESC LIMIT 1`,
          [row.plan_saas_id, hoy],
        );
        return {
          estado: row.estado,
          plan: {
            codigo: row.codigo,
            nombre: row.nombre,
            precioMensualCentavos: precio.rows[0] ? num(precio.rows[0].centavos) : null,
            moneda: precio.rows[0]?.moneda ?? null,
          },
          ciclo,
          proximoCobro: row.cobro,
          limites: { escaneosMes: row.limite, mesaGrupal: row.mesa, reportesAvanzados: row.reportes },
        };
      },
      { readOnly: true },
    );
  }

  usage(): Promise<UsoResponse> {
    return this.db.forRequest(
      async (q) => {
        const { row, ciclo } = await this.current(q);
        if (!row || !ciclo) {
          return {
            ciclo: null,
            escaneosUsados: 0,
            limite: null,
            restantes: null,
            porcentaje: null,
            nivel: 'ILIMITADO',
            rechazadosPorLimite: 0,
          };
        }
        const rechazados = await q.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM intento_escaneo i JOIN restaurante r ON r.restaurante_id = i.restaurante_id
            WHERE i.restaurante_id = app_tenant_id() AND i.resultado = 'LIMITE_SAAS'
              AND (i.creado_en AT TIME ZONE r.zona_horaria)::date >= $1::date`,
          [row.inicio],
        );
        const limite = row.limite;
        const porcentaje = limite === null ? null : Math.floor((row.usados * 100) / limite);
        return {
          ciclo,
          escaneosUsados: row.usados,
          limite,
          restantes: limite === null ? null : Math.max(0, limite - row.usados),
          porcentaje,
          nivel:
            porcentaje === null ? 'ILIMITADO' : porcentaje >= 100 ? 'LIMITE_ALCANZADO' : porcentaje >= 80 ? 'CERCA_DEL_LIMITE' : 'NORMAL',
          rechazadosPorLimite: rechazados.rows[0]!.n,
        };
      },
      { readOnly: true },
    );
  }
}

@ApiTags('saas')
@Controller('v1/suscripcion')
export class SaasController {
  constructor(private readonly svc: SaasService) {}

  @Roles('DUENO')
  @Get()
  @ApiOperation({
    summary: 'Suscripción SaaS del local',
    description:
      'Plan, estado, ciclo, próximo cobro y límites. Modelo SaaS: el local paga una mensualidad y se queda con todo lo que cobra; no hay comisión.',
  })
  @ApiOkResponse({ type: SuscripcionResponse })
  subscription() {
    return this.svc.subscription();
  }

  @Roles('DUENO', 'CAJERO')
  @Get('uso')
  @ApiOperation({
    summary: 'Uso de escaneos del ciclo',
    description:
      'Cuántos escaneos lleva el local en el ciclo actual frente al tope de su plan. También lo ve el cajero: al llegar al tope la caja responde `LIMITE_SAAS`.',
  })
  @ApiOkResponse({ type: UsoResponse })
  usage() {
    return this.svc.usage();
  }
}

@Module({ controllers: [SaasController], providers: [SaasService] })
export class SaasModule {}
