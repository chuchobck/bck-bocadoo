import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems } from '../common/errors';
import { CheckoutService } from '../checkout/checkout';
import { DbService } from '../db/db.service';
import { HOY_LOCAL, UUID_RE } from './common';

class PaseQuery {
  @ApiPropertyOptional({ description: 'public_id del restaurante: el código solo valdrá en ese local' })
  @IsOptional()
  @Matches(UUID_RE, { message: 'restaurante debe ser un UUID' })
  restaurante?: string;
}

class PlanPase {
  @ApiProperty({ description: 'public_id del plan vendido' }) id!: string;
  @ApiProperty({ example: 'Plan semanal' }) nombre!: string;
  @ApiProperty({ example: 4 }) almuerzosRestantes!: number;
  @ApiProperty({ example: 5 }) almuerzosTotales!: number;
  @ApiProperty({ example: '2026-11-20' }) venceEl!: string;
  @ApiProperty({ example: 6 }) diasParaVencer!: number;
  @ApiProperty({ example: [1, 2, 3, 4, 5] }) diasValidos!: number[];
  @ApiProperty({ description: 'El plan vale hoy (día de la semana permitido)' }) valeHoy!: boolean;
}
class LocalPase {
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa', logoUrl: null } })
  restaurante!: { id: string; nombre: string; slug: string; logoUrl: string | null };
  @ApiProperty({ example: '2026-11-13', description: 'Hoy en la zona horaria del local' }) hoy!: string;
  @ApiProperty({ example: 9, description: 'Suma de los planes vigentes' }) almuerzosDisponibles!: number;
  @ApiProperty({ type: [PlanPase], description: 'En orden FIFO: el primero es el que se descuenta' }) planes!: PlanPase[];
}
class PaseResponse {
  @ApiProperty({ example: { id: 'uuid', nombre: 'Ana Pérez' } }) usuario!: { id: string; nombre: string };
  @ApiProperty({ example: { codigo: 'BCD1.…', validoSegundos: 30, expiraEn: '2026-11-13T17:00:30Z' } })
  codigo!: { codigo: string; validoSegundos: number; expiraEn: Date };
  @ApiProperty({ type: [LocalPase] }) locales!: LocalPase[];
}

interface Row {
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
  logo_url: string | null;
  hoy: string;
  plan_public_id: string;
  nombre_plan: string;
  almuerzos_restantes: number;
  almuerzos_totales: number;
  vence_el: string;
  dias_para_vencer: number;
  dias_validos: number[];
  vale_hoy: boolean;
}

@Injectable()
export class DinerPassService {
  constructor(
    private readonly db: DbService,
    private readonly checkout: CheckoutService,
  ) {}

  /**
   * Pase del comensal: su código QR rotativo y sus planes vigentes en cada local. Corre como el comensal (userId, sin
   * tenant): RLS solo deja ver sus fichas de cliente y sus planes.
   */
  async pass(user: AuthUser, restaurantPublicId?: string): Promise<PaseResponse> {
    const { nombre, rows } = await this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const u = await q.query<{ nombre: string }>('SELECT nombre FROM usuario WHERE usuario_id = app_user_id()');
      const r = await q.query<Row>(
        `SELECT r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug, r.logo_url,
                ${HOY_LOCAL('r')}::text AS hoy, s.public_id AS plan_public_id, s.nombre_plan, s.almuerzos_restantes,
                s.almuerzos_totales, s.vence_el::text AS vence_el, (s.vence_el - ${HOY_LOCAL('r')})::int AS dias_para_vencer,
                s.dias_validos, EXTRACT(ISODOW FROM ${HOY_LOCAL('r')})::smallint = ANY (s.dias_validos) AS vale_hoy
           FROM cliente_restaurante c
           JOIN restaurante r ON r.restaurante_id = c.restaurante_id
           JOIN suscripcion_plan s ON s.restaurante_id = c.restaurante_id AND s.cliente_id = c.cliente_id
          WHERE c.usuario_id = app_user_id() AND c.activo AND r.estado <> 'BAJA'
            AND s.estado = 'ACTIVA' AND s.vence_el >= ${HOY_LOCAL('r')}
          ORDER BY r.nombre, r.public_id, s.vence_el, s.suscripcion_id`,
      );
      return { nombre: u.rows[0]!.nombre, rows: r.rows };
    });

    const locales = new Map<string, LocalPase>();
    for (const r of rows) {
      let l = locales.get(r.restaurante_public_id);
      if (!l) {
        l = {
          restaurante: { id: r.restaurante_public_id, nombre: r.restaurante_nombre, slug: r.restaurante_slug, logoUrl: r.logo_url },
          hoy: r.hoy,
          almuerzosDisponibles: 0,
          planes: [],
        };
        locales.set(r.restaurante_public_id, l);
      }
      l.almuerzosDisponibles += r.almuerzos_restantes;
      l.planes.push({
        id: r.plan_public_id,
        nombre: r.nombre_plan,
        almuerzosRestantes: r.almuerzos_restantes,
        almuerzosTotales: r.almuerzos_totales,
        venceEl: r.vence_el,
        diasParaVencer: r.dias_para_vencer,
        diasValidos: r.dias_validos,
        valeHoy: r.vale_hoy,
      });
    }
    const codigo = await this.checkout.issueCode(user, restaurantPublicId);
    return { usuario: { id: user.publicId, nombre }, codigo, locales: [...locales.values()] };
  }
}

@ApiTags('pase')
@ApiBearerAuth()
@Controller('v1/pase')
export class DinerPassController {
  constructor(private readonly svc: DinerPassService) {}

  @Get()
  @ApiOperation({
    summary: 'Pase del comensal: QR rotativo y planes vigentes por local',
    description:
      'El código cambia cada 30 segundos (`codigo.expiraEn`); la app vuelve a pedir el pase o `GET /v1/pase/codigo` cuando vence. ' +
      'Con `restaurante` el código solo vale en ese local. Solo se listan planes activos y no vencidos, en orden FIFO.',
  })
  @ApiOkResponse({ type: PaseResponse })
  @ApiProblems({ 404: ['RESTAURANTE_NO_ENCONTRADO'] })
  pass(@CurrentUser() user: AuthUser, @Query() q: PaseQuery) {
    return this.svc.pass(user, q.restaurante?.toLowerCase());
  }
}
