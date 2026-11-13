import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, BusinessError, badRequest, conflict, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { UUID_RE, restauranteRef } from '../diner/common';

const MODOS = ['CADA_UNO', 'INVITO_YO'] as const;
/** La hora de llegada va de 5 minutos atrás a 12 horas adelante. */
const ARRIVAL_WINDOW = { pastMs: 5 * 60_000, futureMs: 12 * 3_600_000 };

class CrearMesaDto {
  @ApiProperty({ description: 'public_id del restaurante' })
  @Matches(UUID_RE, { message: 'restaurante debe ser un UUID' })
  restaurante!: string;
  @ApiProperty({ example: '2026-11-13T17:30:00Z', description: 'Hora de llegada (de ahora a 12 horas)' })
  @IsISO8601({ strict: true })
  horaLlegada!: string;
  @ApiPropertyOptional({ enum: MODOS, default: 'CADA_UNO', description: 'CADA_UNO: cada quien con su plan. INVITO_YO: paga el anfitrión.' })
  @IsOptional()
  @IsIn(MODOS)
  modo?: (typeof MODOS)[number];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() paraLlevar?: boolean;
}

class UnirseDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() paraLlevar?: boolean;
}

class MiembroMesa {
  @ApiProperty() nombre!: string;
  @ApiProperty() esAnfitrion!: boolean;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({ description: 'Es el comensal que consulta' }) soyYo!: boolean;
}
class MesaResponse {
  @ApiProperty({ description: 'public_id de la mesa' }) id!: string;
  @ApiProperty({ description: 'Lo que va en el link de invitación (bocadoo://mesa/<invitacion>): el public_id de la mesa' })
  invitacion!: string;
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } }) restaurante!: {
    id: string;
    nombre: string;
    slug: string;
  };
  @ApiProperty({ example: { nombre: 'Ana Pérez' } }) anfitrion!: { nombre: string };
  @ApiProperty() soyAnfitrion!: boolean;
  @ApiProperty() horaLlegada!: Date;
  @ApiProperty({ enum: MODOS }) modo!: string;
  @ApiProperty({ enum: ['ABIERTA', 'EN_CAMINO', 'EN_MESA', 'FINALIZADA', 'CANCELADA'] }) estado!: string;
  @ApiPropertyOptional({ description: 'Cuándo la validó la caja' }) validadaEn!: Date | null;
  @ApiProperty({ type: [MiembroMesa] }) miembros!: MiembroMesa[];
}
class InvitacionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } }) restaurante!: {
    id: string;
    nombre: string;
    slug: string;
  };
  @ApiProperty({ example: { nombre: 'Ana Pérez' } }) anfitrion!: { nombre: string };
  @ApiProperty() horaLlegada!: Date;
  @ApiProperty({ enum: MODOS }) modo!: string;
  @ApiProperty() estado!: string;
  @ApiProperty() personas!: number;
  @ApiProperty() capacidad!: number;
  @ApiProperty() puedeUnirse!: boolean;
  @ApiPropertyOptional({
    enum: ['MESA_CERRADA', 'MESA_VENCIDA', 'MESA_LLENA', 'RESTAURANTE_NO_DISPONIBLE', 'YA_ERES_MIEMBRO'],
    description: 'Por qué no puede unirse; null si puede',
  })
  motivo!: string | null;
}

/** Motivos de fn_mesa_invitacion / fn_unirse_mesa → error HTTP con código estable. */
const MOTIVOS: Record<string, { status: HttpStatus; detail: string }> = {
  NO_ENCONTRADA: { status: HttpStatus.NOT_FOUND, detail: 'Mesa no encontrada.' },
  MESA_CERRADA: { status: HttpStatus.CONFLICT, detail: 'La mesa ya no recibe invitados.' },
  MESA_VENCIDA: { status: HttpStatus.CONFLICT, detail: 'La invitación venció.' },
  MESA_LLENA: { status: HttpStatus.CONFLICT, detail: 'La mesa está llena.' },
  RESTAURANTE_NO_DISPONIBLE: { status: HttpStatus.CONFLICT, detail: 'El restaurante no está disponible.' },
};

interface MesaRow {
  mesa_compartida_id: string;
  public_id: string;
  modo: string;
  estado: string;
  hora_llegada: Date;
  validada_en: Date | null;
  soy_anfitrion: boolean;
  anfitrion_nombre: string;
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
}

const MESA_SELECT = `SELECT m.mesa_compartida_id, m.public_id, m.modo, m.estado, m.hora_llegada, m.validada_en,
       m.anfitrion_usuario_id = app_user_id() AS soy_anfitrion, u.nombre AS anfitrion_nombre,
       r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug
  FROM mesa_compartida m
  JOIN restaurante r ON r.restaurante_id = m.restaurante_id
  JOIN usuario u ON u.usuario_id = m.anfitrion_usuario_id
 WHERE (m.anfitrion_usuario_id = app_user_id() OR m.mesa_compartida_id IN (SELECT fn_mis_mesas()))`;

/**
 * Mesas compartidas desde la app. Corre como el comensal (userId, sin tenant). RLS: solo ve las mesas donde es
 * anfitrión o miembro; para unirse a una ajena usa fn_unirse_mesa, que valida el link (estado, vencimiento, cupo).
 */
@Injectable()
export class TablesService {
  constructor(private readonly db: DbService) {}

  async create(user: AuthUser, dto: CrearMesaDto, key: string): Promise<MesaResponse> {
    const llegada = new Date(dto.horaLlegada);
    const now = Date.now();
    if (llegada.getTime() < now - ARRIVAL_WINDOW.pastMs || llegada.getTime() > now + ARRIVAL_WINDOW.futureMs)
      throw badRequest('HORA_LLEGADA_INVALIDA', 'La hora de llegada debe estar entre ahora y las próximas 12 horas.');
    const restaurante = dto.restaurante.toLowerCase();
    try {
      return await this.db.scope({ userId: user.userId }, async (q) => {
        const prev = await this.byKey(q, key, restaurante);
        if (prev) return prev;
        const rest = (
          await q.query<{ restaurante_id: string }>(`SELECT restaurante_id FROM restaurante WHERE public_id = $1 AND estado = 'ACTIVO'`, [
            restaurante,
          ])
        ).rows[0];
        if (!rest) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
        const m = (
          await q.query<{ mesa_compartida_id: string; public_id: string }>(
            `INSERT INTO mesa_compartida (restaurante_id, anfitrion_usuario_id, hora_llegada, modo, clave_idempotencia)
             VALUES ($1, app_user_id(), $2, $3, $4) RETURNING mesa_compartida_id, public_id`,
            [rest.restaurante_id, llegada, dto.modo ?? 'CADA_UNO', key],
          )
        ).rows[0]!;
        await q.query(
          `INSERT INTO mesa_compartida_miembro (mesa_compartida_id, restaurante_id, usuario_id, nombre, es_anfitrion, para_llevar)
           SELECT $1, $2, app_user_id(), nombre, true, $3 FROM usuario WHERE usuario_id = app_user_id()`,
          [m.mesa_compartida_id, rest.restaurante_id, dto.paraLlevar ?? false],
        );
        return this.view(q, m.public_id);
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_mesa_anfitrion_clave') {
        const again = await this.db.scope({ userId: user.userId, readOnly: true }, (q) => this.byKey(q, key, restaurante));
        if (again) return again;
      }
      throw err;
    }
  }

  private async byKey(q: Queryable, key: string, restaurante: string) {
    const r = await q.query<{ public_id: string; restaurante_public_id: string }>(
      `SELECT m.public_id, r.public_id AS restaurante_public_id FROM mesa_compartida m JOIN restaurante r USING (restaurante_id)
        WHERE m.anfitrion_usuario_id = app_user_id() AND m.clave_idempotencia = $1`,
      [key],
    );
    if (!r.rows[0]) return null;
    if (r.rows[0].restaurante_public_id !== restaurante)
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó para otra mesa.');
    return this.view(q, r.rows[0].public_id);
  }

  list(user: AuthUser) {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<MesaRow>(`${MESA_SELECT} ORDER BY m.hora_llegada DESC, m.public_id LIMIT 50`);
      return Promise.all(r.rows.map((m) => this.render(q, m)));
    });
  }

  one(user: AuthUser, id: string) {
    return this.db.scope({ userId: user.userId, readOnly: true }, (q) => this.view(q, id));
  }

  /** Solo el anfitrión, y antes de que la caja la valide. */
  cancel(user: AuthUser, id: string) {
    return this.db.scope({ userId: user.userId }, async (q) => {
      const m = await this.load(q, id);
      if (!m.soy_anfitrion) throw new BusinessError(HttpStatus.FORBIDDEN, 'SOLO_ANFITRION', 'Solo el anfitrión puede cancelar la mesa.');
      if (m.estado === 'CANCELADA') return this.render(q, m);
      if (m.validada_en || !['ABIERTA', 'EN_CAMINO'].includes(m.estado)) throw conflict('MESA_CERRADA', 'La mesa ya fue validada en caja.');
      await q.query(
        `UPDATE mesa_compartida SET estado = 'CANCELADA' WHERE mesa_compartida_id = $1 AND anfitrion_usuario_id = app_user_id()`,
        [m.mesa_compartida_id],
      );
      return this.view(q, id);
    });
  }

  /** Validar el link antes de unirse: quién invita, a dónde, a qué hora, cuántos van y si todavía se puede. */
  preview(user: AuthUser, id: string): Promise<InvitacionResponse> {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<{
        restaurante_public_id: string;
        restaurante_nombre: string;
        restaurante_slug: string;
        anfitrion_nombre: string;
        hora_llegada: Date;
        modo: string;
        estado: string;
        personas: number;
        capacidad: number;
        motivo: string | null;
      }>('SELECT * FROM fn_mesa_invitacion($1)', [id]);
      const i = r.rows[0];
      if (!i) throw notFound('MESA_NO_ENCONTRADA', 'Mesa no encontrada.');
      return {
        id,
        restaurante: restauranteRef(i),
        anfitrion: { nombre: i.anfitrion_nombre },
        horaLlegada: i.hora_llegada,
        modo: i.modo,
        estado: i.estado,
        personas: i.personas,
        capacidad: i.capacidad,
        puedeUnirse: i.motivo === null,
        motivo: i.motivo,
      };
    });
  }

  /** Unirse por link. Repetirlo no duplica al miembro: devuelve la mesa. */
  join(user: AuthUser, id: string, dto: UnirseDto): Promise<MesaResponse> {
    return this.db.scope({ userId: user.userId }, async (q) => {
      const r = (await q.query<{ r: string }>('SELECT fn_unirse_mesa($1, $2) AS r', [id, dto.paraLlevar ?? false])).rows[0]!.r;
      if (r !== 'UNIDO' && r !== 'YA_ERES_MIEMBRO') {
        const m = MOTIVOS[r] ?? { status: HttpStatus.CONFLICT, detail: 'No puedes unirte a esta mesa.' };
        throw new BusinessError(m.status, r === 'NO_ENCONTRADA' ? 'MESA_NO_ENCONTRADA' : r, m.detail);
      }
      return this.view(q, id);
    });
  }

  private async load(q: Queryable, id: string): Promise<MesaRow> {
    const r = await q.query<MesaRow>(`${MESA_SELECT} AND m.public_id = $1`, [id]);
    if (!r.rows[0]) throw notFound('MESA_NO_ENCONTRADA', 'Mesa no encontrada.');
    return r.rows[0];
  }

  private async view(q: Queryable, id: string) {
    return this.render(q, await this.load(q, id));
  }

  private async render(q: Queryable, m: MesaRow): Promise<MesaResponse> {
    const members = await q.query<{ nombre: string; es_anfitrion: boolean; para_llevar: boolean; soy_yo: boolean }>(
      `SELECT nombre, es_anfitrion, para_llevar, usuario_id IS NOT DISTINCT FROM app_user_id() AS soy_yo
         FROM mesa_compartida_miembro WHERE mesa_compartida_id = $1 ORDER BY es_anfitrion DESC, unido_en, miembro_id`,
      [m.mesa_compartida_id],
    );
    return {
      id: m.public_id,
      invitacion: m.public_id,
      restaurante: restauranteRef(m),
      anfitrion: { nombre: m.anfitrion_nombre },
      soyAnfitrion: m.soy_anfitrion,
      horaLlegada: m.hora_llegada,
      modo: m.modo,
      estado: m.estado,
      validadaEn: m.validada_en,
      miembros: members.rows.map((x) => ({ nombre: x.nombre, esAnfitrion: x.es_anfitrion, paraLlevar: x.para_llevar, soyYo: x.soy_yo })),
    };
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis/mesas')
export class TablesController {
  constructor(private readonly svc: TablesService) {}

  @Post()
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Crear una mesa compartida e invitar por link',
    description: 'El anfitrión entra como primer miembro. Comparte `invitacion` en un link; la caja valida la mesa entera al llegar.',
  })
  @ApiCreatedResponse({ type: MesaResponse })
  @ApiProblems({
    400: ['HORA_LLEGADA_INVALIDA', 'IDEMPOTENCY_KEY_INVALIDA'],
    404: ['RESTAURANTE_NO_ENCONTRADO'],
    409: ['IDEMPOTENCY_KEY_REUTILIZADA'],
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CrearMesaDto, @IdempotencyKey() key: string) {
    return this.svc.create(user, dto, key);
  }

  @Get()
  @ApiOperation({ summary: 'Mis mesas (como anfitrión o invitado)' })
  @ApiOkResponse({ type: [MesaResponse] })
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Una mesa mía, con sus miembros' })
  @ApiOkResponse({ type: MesaResponse })
  @ApiProblems({ 404: ['MESA_NO_ENCONTRADA'] })
  one(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.one(user, id);
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar la mesa (solo el anfitrión, antes de la caja)' })
  @ApiOkResponse({ type: MesaResponse })
  @ApiProblems({ 403: ['SOLO_ANFITRION'], 404: ['MESA_NO_ENCONTRADA'], 409: ['MESA_CERRADA'] })
  cancel(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.cancel(user, id);
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mesas/invitacion')
export class InvitationsController {
  constructor(private readonly svc: TablesService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Validar un link de invitación antes de unirse',
    description: 'Dice quién invita, a dónde y a qué hora, cuántos van y si todavía se puede (`puedeUnirse`, `motivo`).',
  })
  @ApiOkResponse({ type: InvitacionResponse })
  @ApiProblems({ 404: ['MESA_NO_ENCONTRADA'] })
  preview(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.preview(user, id);
  }

  @Post(':id/unirse')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Unirse a la mesa por su link',
    description: 'Vuelve a validar con la mesa bloqueada (cupo, estado, vencimiento). Unirse dos veces no duplica al miembro.',
  })
  @ApiOkResponse({ type: MesaResponse })
  @ApiProblems({
    404: ['MESA_NO_ENCONTRADA'],
    409: ['MESA_CERRADA', 'MESA_VENCIDA', 'MESA_LLENA', 'RESTAURANTE_NO_DISPONIBLE'],
  })
  join(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @Body() dto: UnirseDto, @IdempotencyKey() _key: string) {
    return this.svc.join(user, id, dto);
  }
}

@Module({ controllers: [TablesController, InvitationsController], providers: [TablesService] })
export class TablesModule {}
