import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems, conflict, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { IdPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { restauranteRef } from '../diner/common';
import { Text } from '../security/sanitize';

class ConfigDto {
  @ApiProperty({ description: 'Encender o apagar la tarjeta' }) @IsBoolean() activa!: boolean;
  @ApiProperty({ example: 10, minimum: 2, maximum: 50, description: 'Sellos para ganar un premio' })
  @IsInt()
  @Min(2)
  @Max(50)
  meta!: number;
  @ApiProperty({ example: 'Un almuerzo gratis' }) @Text() @IsString() @Length(1, 100) premio!: string;
  @ApiPropertyOptional({ example: 'Tarjeta Doña Rosa' }) @IsOptional() @Text() @IsString() @Length(1, 60) nombre?: string;
  @ApiPropertyOptional({ enum: ['ALMUERZO'], default: 'ALMUERZO', description: 'Qué suma un sello. Por ahora, cada almuerzo validado.' })
  @IsOptional()
  @IsIn(['ALMUERZO'])
  cuenta?: 'ALMUERZO';
}

class ConfigResponse {
  @ApiProperty() activa!: boolean;
  @ApiProperty() meta!: number;
  @ApiProperty() premio!: string;
  @ApiPropertyOptional() nombre!: string | null;
  @ApiProperty({ enum: ['ALMUERZO', 'PLATO'] }) cuenta!: string;
}
class TarjetaResponse {
  @ApiProperty() sellos!: number;
  @ApiProperty() meta!: number;
  @ApiProperty({ description: 'Sellos que faltan para el próximo premio' }) faltan!: number;
  @ApiProperty() premiosDisponibles!: number;
  @ApiProperty() premio!: string;
  @ApiPropertyOptional() nombre!: string | null;
  @ApiProperty({ description: 'false si el local apagó la tarjeta (los premios ya ganados se pueden canjear)' }) activa!: boolean;
}
class MiTarjeta extends TarjetaResponse {
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } }) restaurante!: {
    id: string;
    nombre: string;
    slug: string;
  };
}

interface CardRow {
  activa: boolean;
  meta: number;
  premio: string;
  nombre: string | null;
  sellos: number | null;
  premios_disponibles: number | null;
}

const toCard = (r: CardRow): TarjetaResponse => {
  const sellos = r.sellos ?? 0;
  return {
    sellos,
    meta: r.meta,
    faltan: Math.max(r.meta - sellos, 0),
    premiosDisponibles: r.premios_disponibles ?? 0,
    premio: r.premio,
    nombre: r.nombre,
    activa: r.activa,
  };
};

/**
 * Tarjeta de sellos. Los sellos los suma la base (trigger en consumo_almuerzo) con cada almuerzo validado y los quita
 * si el almuerzo se devuelve, así ningún camino de la caja se los salta. Aquí: configurarla, verla y canjear premios.
 */
@Injectable()
export class LoyaltyService {
  constructor(private readonly db: DbService) {}

  // --- Comensal (userId, sin tenant) ---

  mine(user: AuthUser): Promise<MiTarjeta[]> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<CardRow & { restaurante_public_id: string; restaurante_nombre: string; restaurante_slug: string }>(
        `SELECT g.activa, g.meta, g.premio, g.nombre, t.sellos, t.premios_disponibles,
                r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug
           FROM cliente_restaurante c
           JOIN restaurante r ON r.restaurante_id = c.restaurante_id
           JOIN tarjeta_sellos_config g ON g.restaurante_id = c.restaurante_id
           LEFT JOIN tarjeta_sellos_cliente t ON t.restaurante_id = c.restaurante_id AND t.cliente_id = c.cliente_id
          WHERE c.usuario_id = app_user_id() AND c.activo AND (g.activa OR COALESCE(t.premios_disponibles, 0) > 0)
          ORDER BY r.nombre, r.public_id`,
      );
      return r.rows.map((x) => ({ restaurante: restauranteRef(x), ...toCard(x) }));
    });
  }

  // --- Dueño y cajero (tenant) ---

  getConfig(): Promise<ConfigResponse> {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<ConfigResponse>(
          'SELECT activa, meta, premio, nombre, cuenta FROM tarjeta_sellos_config WHERE restaurante_id = app_tenant_id()',
        );
        if (!r.rows[0]) throw notFound('TARJETA_NO_CONFIGURADA', 'El local no tiene tarjeta de sellos.');
        return r.rows[0];
      },
      { readOnly: true },
    );
  }

  setConfig(dto: ConfigDto): Promise<ConfigResponse> {
    return this.db.forRequest(async (q) => {
      const r = await q.query<ConfigResponse>(
        `INSERT INTO tarjeta_sellos_config (restaurante_id, activa, meta, premio, nombre, cuenta)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5)
         ON CONFLICT (restaurante_id) DO UPDATE SET activa = EXCLUDED.activa, meta = EXCLUDED.meta, premio = EXCLUDED.premio,
                                                    nombre = EXCLUDED.nombre, cuenta = EXCLUDED.cuenta
         RETURNING activa, meta, premio, nombre, cuenta`,
        [dto.activa, dto.meta, dto.premio, dto.nombre ?? null, dto.cuenta ?? 'ALMUERZO'],
      );
      return r.rows[0]!;
    });
  }

  customerCard(clienteId: string) {
    return this.db.forRequest((q) => this.cardIn(q, clienteId), { readOnly: true });
  }

  /** Canjear un premio en caja. La misma Idempotency-Key no canjea dos veces. */
  redeem(clienteId: string, key: string) {
    return this.db.forRequest(async (q) => {
      const done = await q.query(
        `SELECT 1 FROM movimiento_sello WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1 AND cliente_id = $2`,
        [key, clienteId],
      );
      if (done.rowCount) return { ...(await this.cardIn(q, clienteId)), yaCanjeado: true };
      const other = await q.query('SELECT 1 FROM movimiento_sello WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1', [
        key,
      ]);
      if (other.rowCount) throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó con otro cliente.');
      await this.cardIn(q, clienteId); // 404 si no hay cliente o tarjeta
      const t = (
        await q.query<{ premios_disponibles: number }>(
          `SELECT premios_disponibles FROM tarjeta_sellos_cliente WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 FOR UPDATE`,
          [clienteId],
        )
      ).rows[0];
      if (!t || t.premios_disponibles < 1) throw conflict('SIN_PREMIOS', 'Este cliente no tiene premios por canjear.');
      await q.query(
        `INSERT INTO movimiento_sello (restaurante_id, cliente_id, tipo, sellos, motivo, clave_idempotencia)
         VALUES (app_tenant_id(), $1, 'PREMIO_CANJEADO', -1, 'Premio canjeado en caja', $2)`,
        [clienteId, key],
      );
      await q.query(
        `UPDATE tarjeta_sellos_cliente SET premios_disponibles = premios_disponibles - 1 WHERE restaurante_id = app_tenant_id() AND cliente_id = $1`,
        [clienteId],
      );
      return { ...(await this.cardIn(q, clienteId)), yaCanjeado: false };
    });
  }

  private async cardIn(q: Queryable, clienteId: string): Promise<TarjetaResponse> {
    const c = await q.query('SELECT 1 FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND cliente_id = $1', [clienteId]);
    if (!c.rowCount) throw notFound('CLIENTE_NO_ENCONTRADO', 'Cliente no encontrado.');
    const r = await q.query<CardRow>(
      `SELECT g.activa, g.meta, g.premio, g.nombre, t.sellos, t.premios_disponibles
         FROM tarjeta_sellos_config g
         LEFT JOIN tarjeta_sellos_cliente t ON t.restaurante_id = g.restaurante_id AND t.cliente_id = $1
        WHERE g.restaurante_id = app_tenant_id()`,
      [clienteId],
    );
    if (!r.rows[0]) throw notFound('TARJETA_NO_CONFIGURADA', 'El local no tiene tarjeta de sellos.');
    return toCard(r.rows[0]);
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis/sellos')
export class DinerLoyaltyController {
  constructor(private readonly svc: LoyaltyService) {}

  @Get()
  @ApiOperation({
    summary: 'Mis tarjetas de sellos',
    description: 'Una por local donde soy cliente y que tiene la tarjeta activa (o donde tengo premios).',
  })
  @ApiOkResponse({ type: [MiTarjeta] })
  mine(@CurrentUser() user: AuthUser) {
    return this.svc.mine(user);
  }
}

@ApiTags('sellos')
@Controller('v1')
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService) {}

  @Roles('DUENO', 'CAJERO')
  @Get('sellos/config')
  @ApiOperation({ summary: 'Configuración de la tarjeta de sellos' })
  @ApiOkResponse({ type: ConfigResponse })
  @ApiProblems({ 404: ['TARJETA_NO_CONFIGURADA'] })
  getConfig() {
    return this.svc.getConfig();
  }

  @Roles('DUENO')
  @Put('sellos/config')
  @ApiOperation({
    summary: 'Configurar la tarjeta de sellos',
    description:
      'Cada almuerzo validado suma un sello; al llegar a la meta se gana un premio. Cambiar la meta no toca los sellos ya ganados.',
  })
  @ApiOkResponse({ type: ConfigResponse })
  setConfig(@Body() dto: ConfigDto) {
    return this.svc.setConfig(dto);
  }

  @Roles('DUENO', 'CAJERO')
  @Get('clientes/:id/sellos')
  @ApiOperation({ summary: 'Tarjeta de sellos de un cliente' })
  @ApiOkResponse({ type: TarjetaResponse })
  @ApiProblems({ 404: ['CLIENTE_NO_ENCONTRADO', 'TARJETA_NO_CONFIGURADA'] })
  card(@Param('id', IdPipe) id: string) {
    return this.svc.customerCard(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('clientes/:id/sellos/canjear')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Canjear un premio de la tarjeta de sellos' })
  @ApiOkResponse({ type: TarjetaResponse })
  @ApiProblems({ 404: ['CLIENTE_NO_ENCONTRADO', 'TARJETA_NO_CONFIGURADA'], 409: ['SIN_PREMIOS', 'IDEMPOTENCY_KEY_REUTILIZADA'] })
  redeem(@Param('id', IdPipe) id: string, @IdempotencyKey() key: string) {
    return this.svc.redeem(id, key);
  }
}

@Module({ controllers: [DinerLoyaltyController, LoyaltyController], providers: [LoyaltyService] })
export class LoyaltyModule {}
