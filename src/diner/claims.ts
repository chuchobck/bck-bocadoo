import { Body, Controller, Get, Injectable, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, conflict } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';
import { restauranteRef } from './common';
import { ownLunch } from './history';

/** Días que tiene el comensal para reclamar por un almuerzo. */
export const CLAIM_DAYS = 7;

class ReclamarDto {
  @ApiProperty({ example: 'Me descontaron el almuerzo pero ese día no fui.', minLength: 10, maxLength: 500 })
  @Text()
  @IsString()
  @Length(10, 500)
  mensaje!: string;
}

class ReclamoResponse {
  @ApiProperty({
    example: { id: 'uuid', fecha: '2026-11-13T17:00:00Z', restaurante: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } },
  })
  consumo!: { id: string; fecha: Date; restaurante: { id: string; nombre: string; slug: string } };
  @ApiProperty({ enum: ['PENDIENTE', 'DEVUELTO', 'RECHAZADO'], description: 'DEVUELTO: el almuerzo volvió a tu plan' }) estado!: string;
  @ApiProperty() mensaje!: string;
  @ApiPropertyOptional({ description: 'Respuesta del restaurante' }) respuesta!: string | null;
  @ApiProperty() creadoEn!: Date;
  @ApiPropertyOptional() resueltoEn!: Date | null;
}

interface Row {
  consumo_public_id: string;
  consumo_en: Date;
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
  estado: string;
  mensaje: string;
  respuesta: string | null;
  creado_en: Date;
  resuelto_en: Date | null;
  clave_idempotencia: string | null;
}

const MIS_RECLAMOS = `SELECT k.public_id AS consumo_public_id, k.creado_en AS consumo_en, r.public_id AS restaurante_public_id,
       r.nombre AS restaurante_nombre, r.slug AS restaurante_slug, x.estado, x.mensaje, x.respuesta, x.creado_en, x.resuelto_en,
       x.clave_idempotencia
  FROM reclamo x
  JOIN cliente_restaurante c ON c.restaurante_id = x.restaurante_id AND c.cliente_id = x.cliente_id
  JOIN consumo_almuerzo k ON k.restaurante_id = x.restaurante_id AND k.consumo_id = x.consumo_id
  JOIN restaurante r ON r.restaurante_id = x.restaurante_id
 WHERE c.usuario_id = app_user_id()`;

const toClaim = (x: Row): ReclamoResponse => ({
  consumo: { id: x.consumo_public_id, fecha: x.consumo_en, restaurante: restauranteRef(x) },
  estado: x.estado,
  mensaje: x.mensaje,
  respuesta: x.respuesta,
  creadoEn: x.creado_en,
  resueltoEn: x.resuelto_en,
});

/**
 * Reclamos del comensal. Corre como el comensal (userId, sin tenant); la base (comensal_crea) exige además almuerzo
 * propio, no revertido, de los últimos 7 días, y que nazca PENDIENTE. El dueño lo resuelve en `/v1/reclamos` (fase 7).
 */
@Injectable()
export class DinerClaimsService {
  constructor(private readonly db: DbService) {}

  list(user: AuthUser): Promise<ReclamoResponse[]> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) =>
      (await q.query<Row>(`${MIS_RECLAMOS} ORDER BY x.creado_en DESC LIMIT 50`)).rows.map(toClaim),
    );
  }

  /** Un reclamo por almuerzo. Reintentar con la misma clave devuelve el mismo. */
  async create(user: AuthUser, consumoId: string, mensaje: string, key: string): Promise<ReclamoResponse> {
    const attempt = () =>
      this.db.scope({ userId: user.userId }, async (q) => {
        const prev = await this.existing(q, consumoId, key);
        if (prev) return prev;
        const k = await ownLunch(q, consumoId);
        if (k.revertido_en) throw conflict('CONSUMO_REVERTIDO', 'Ese almuerzo ya se devolvió a tu plan.');
        const old = (
          await q.query<{ vencido: boolean }>('SELECT $1::timestamptz <= CURRENT_TIMESTAMP - make_interval(days => $2) AS vencido', [
            k.creado_en,
            CLAIM_DAYS,
          ])
        ).rows[0]!.vencido;
        if (old) throw conflict('RECLAMO_VENCIDO', `Solo se puede reclamar en los ${CLAIM_DAYS} días siguientes al almuerzo.`);
        await q.query(
          `INSERT INTO reclamo (restaurante_id, consumo_id, cliente_id, mensaje, clave_idempotencia)
           SELECT k.restaurante_id, k.consumo_id, k.cliente_id, $2, $3 FROM consumo_almuerzo k WHERE k.consumo_id = $1`,
          [k.consumo_id, mensaje, key],
        );
        return toClaim((await q.query<Row>(`${MIS_RECLAMOS} AND k.public_id = $1`, [consumoId])).rows[0]!);
      });
    try {
      return await attempt();
    } catch (err) {
      // Dos envíos a la vez: uq_reclamo_abierto deja pasar uno; el otro se resuelve como reintento o como duplicado.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_reclamo_abierto') return attempt();
      throw err;
    }
  }

  private async existing(q: Queryable, consumoId: string, key: string) {
    const r = await q.query<Row>(`${MIS_RECLAMOS} AND k.public_id = $1 ORDER BY x.creado_en DESC LIMIT 1`, [consumoId]);
    const x = r.rows[0];
    if (!x) return null;
    if (x.clave_idempotencia === key) return toClaim(x);
    throw conflict('RECLAMO_YA_EXISTE', 'Ya hiciste un reclamo por ese almuerzo.');
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis')
export class DinerClaimsController {
  constructor(private readonly svc: DinerClaimsService) {}

  @Get('reclamos')
  @ApiOperation({ summary: 'Mis reclamos y cómo se resolvieron' })
  @ApiOkResponse({ type: [ReclamoResponse] })
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Post('consumos/:id/reclamo')
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Reclamar por un almuerzo mío',
    description: `Hasta ${CLAIM_DAYS} días después; uno por almuerzo. Si el restaurante lo acepta, el almuerzo vuelve al plan.`,
  })
  @ApiCreatedResponse({ type: ReclamoResponse })
  @ApiProblems({
    400: ['IDEMPOTENCY_KEY_INVALIDA'],
    404: ['CONSUMO_NO_ENCONTRADO'],
    409: ['CONSUMO_REVERTIDO', 'RECLAMO_VENCIDO', 'RECLAMO_YA_EXISTE'],
  })
  create(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @Body() dto: ReclamarDto, @IdempotencyKey() key: string) {
    return this.svc.create(user, id, dto.mensaje, key);
  }
}
