import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { ApiProblems, BusinessError, conflict, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { horaLlegadaEnVentana } from '../common/hora-llegada';
import { DbService, Queryable } from '../db/db.service';
import { UUID_RE, restaurantePausado, restauranteRef } from '../diner/common';
import type { PlanPersona } from '../billing/tipos';
import { SIN_PLAN, aRespuesta, type CotizacionRespuesta } from '../cobro/adaptador';
import { CotizacionResponse } from '../cobro/cotizacion.dto';
import { cotizarMesa } from '../cobro/mesa';
import { SeleccionDto, SeleccionMiembroResponse, TableSelectionService, loadSelections, seleccionDe } from './selection';

const MODOS = ['CADA_UNO', 'INVITO_YO'] as const;

class CrearMesaCompartidaDto {
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
  @ApiProperty({
    description:
      'Salió de la mesa (`POST /v1/mis/mesas/{id}/salir`): no ocupa lugar, no se le cobra y su selección y su cotización vienen vacías/null. Puede volver a unirse con el link.',
  })
  salio!: boolean;
  @ApiProperty({
    type: SeleccionMiembroResponse,
    nullable: true,
    description:
      'Lo que eligió este miembro. El anfitrión ve la de todos; un invitado solo la suya (las demás vienen `null`: no se muestran). Vacía = aún no eligió.',
  })
  seleccion!: SeleccionMiembroResponse | null;
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización estimada de lo que pide este miembro (sin selección cuenta 1 almuerzo), con el plan de quien paga y su paraLlevar: es lo que la caja cobrará al validar. ' +
      'Misma visibilidad que `seleccion`: el anfitrión ve la de todos; un invitado solo la suya (las demás `null`). `null` también si el miembro salió de la mesa. ' +
      'Del plan de otra persona solo se usa cuántos almuerzos cubre hoy, acotado al número de miembros (nunca su saldo exacto).',
  })
  cotizacion!: CotizacionRespuesta | null;
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
  @ApiPropertyOptional({ type: Date, nullable: true, description: 'Cuándo la validó la caja' }) validadaEn!: Date | null;
  @ApiProperty({ type: [MiembroMesa] }) miembros!: MiembroMesa[];
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización estimada de toda la mesa (sin los que salieron). Solo el anfitrión (`null` para un invitado y para quien salió).',
  })
  cotizacion!: CotizacionRespuesta | null;
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
    type: String,
    nullable: true,
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

/** Resultados de fn_salir_mesa que no son 200 → error HTTP con código estable (E.7). */
const SALIDA: Record<string, { status: HttpStatus; code: string; detail: string }> = {
  NO_ENCONTRADA: { status: HttpStatus.NOT_FOUND, code: 'MESA_NO_ENCONTRADA', detail: 'Mesa no encontrada.' },
  MESA_CERRADA: { status: HttpStatus.CONFLICT, code: 'MESA_CERRADA', detail: 'La mesa ya fue validada en caja o cancelada.' },
  ANFITRION_NO_PUEDE_SALIR: {
    status: HttpStatus.CONFLICT,
    code: 'ANFITRION_NO_PUEDE_SALIR',
    detail: 'El anfitrión no puede salir de su mesa: puede cancelarla.',
  },
};

interface MesaRow {
  mesa_compartida_id: string;
  restaurante_id: string;
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

const MESA_SELECT = `SELECT m.mesa_compartida_id, m.restaurante_id, m.public_id, m.modo, m.estado, m.hora_llegada, m.validada_en,
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

  async create(user: AuthUser, dto: CrearMesaCompartidaDto, key: string): Promise<MesaResponse> {
    const llegada = horaLlegadaEnVentana(dto.horaLlegada);
    const restaurante = dto.restaurante.toLowerCase();
    try {
      return await this.db.scope({ userId: user.userId }, async (q) => {
        const prev = await this.byKey(q, key, restaurante);
        if (prev) return prev;
        const rest = (
          await q.query<{ restaurante_id: string; estado: string }>(
            `SELECT restaurante_id, estado FROM restaurante WHERE public_id = $1 AND estado IN ('ACTIVO', 'PAUSADO')`,
            [restaurante],
          )
        ).rows[0];
        if (!rest) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
        if (rest.estado === 'PAUSADO') throw restaurantePausado();
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

  /**
   * Salir de la mesa (E.7, D «Miembro que se va»): cualquier miembro menos el anfitrión, mientras la caja no la valide.
   * Borra su selección y marca `salio_en` (fn_salir_mesa, con la mesa bloqueada). Repetir no cambia nada. Desde ahí no
   * ocupa lugar ni se le cobra; puede volver a unirse con el link.
   */
  leave(user: AuthUser, id: string): Promise<MesaResponse> {
    return this.db.scope({ userId: user.userId }, async (q) => {
      const r = (await q.query<{ r: string }>('SELECT fn_salir_mesa($1) AS r', [id])).rows[0]!.r;
      const e = SALIDA[r];
      if (e) throw new BusinessError(e.status, e.code, e.detail);
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
    const members = await q.query<{
      miembro_id: string;
      nombre: string;
      es_anfitrion: boolean;
      para_llevar: boolean;
      soy_yo: boolean;
      salio: boolean;
    }>(
      `SELECT miembro_id, nombre, es_anfitrion, para_llevar, usuario_id IS NOT DISTINCT FROM app_user_id() AS soy_yo, salio_en IS NOT NULL AS salio
         FROM mesa_compartida_miembro WHERE mesa_compartida_id = $1 ORDER BY es_anfitrion DESC, unido_en, miembro_id`,
      [m.mesa_compartida_id],
    );
    const activos = members.rows.filter((x) => !x.salio);
    const selecciones = await loadSelections(q, m.mesa_compartida_id);
    // Cotización informativa (E.6). El comensal lee su propio plan; del plan de otro pagador solo obtiene, con
    // fn_plan_pagador_mesa, cuántos almuerzos cubre hoy (acotado al número de miembros: nunca el saldo exacto).
    const cliente = (
      await q.query<{ cliente_id: string }>(
        'SELECT cliente_id FROM cliente_restaurante WHERE restaurante_id = $1 AND usuario_id = app_user_id() AND activo',
        [m.restaurante_id],
      )
    ).rows[0];
    const ajenos = await this.planesAjenos(q, m, activos);
    const cot = await cotizarMesa(q, {
      mesaId: m.mesa_compartida_id,
      restauranteId: m.restaurante_id,
      modo: m.modo === 'INVITO_YO' ? 'INVITO_YO' : 'CADA_UNO',
      base: 'seleccion',
      miembros: activos.map((x) => ({
        miembroId: String(x.miembro_id),
        esAnfitrion: x.es_anfitrion,
        paraLlevar: x.para_llevar,
        clienteId: x.soy_yo && cliente ? String(cliente.cliente_id) : null,
        planLegible: x.soy_yo || ajenos.has(String(x.miembro_id)),
        plan: ajenos.get(String(x.miembro_id)),
      })),
    });
    const aResp = (c: Parameters<typeof aRespuesta>[0] | null | undefined) => (c ? aRespuesta(c, cot.monedaCodigo) : null);
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
      miembros: members.rows.map((x) => {
        const visible = (m.soy_anfitrion || x.soy_yo) && !x.salio;
        return {
          nombre: x.nombre,
          esAnfitrion: x.es_anfitrion,
          paraLlevar: x.para_llevar,
          soyYo: x.soy_yo,
          salio: x.salio,
          seleccion: m.soy_anfitrion || x.soy_yo ? seleccionDe(selecciones, x.miembro_id) : null,
          cotizacion: visible ? aResp(cot.porMiembro.get(String(x.miembro_id))) : null,
        };
      }),
      cotizacion: m.soy_anfitrion ? aResp(cot.mesa) : null,
    };
  }

  /**
   * Plan de los pagadores que no son quien consulta, como los da fn_plan_pagador_mesa (solo un entero acotado). Lo que
   * cada uno necesita para ver lo suyo y nada más (E.6):
   * - INVITO_YO: el invitado necesita el plan del anfitrión (paga todo); el anfitrión lee el suyo.
   * - CADA_UNO: el anfitrión necesita el de cada invitado; un invitado solo ve lo suyo, que paga con su propio plan.
   * Sin almuerzos (0) no se sabe por qué (sin plan, sin saldo, vencido, día no válido): el monto es el mismo, a caja.
   * Quien salió de la mesa no obtiene nada (la función devuelve NULL).
   */
  private async planesAjenos(
    q: Queryable,
    m: MesaRow,
    activos: { miembro_id: string; es_anfitrion: boolean; soy_yo: boolean }[],
  ): Promise<Map<string, PlanPersona>> {
    const yo = activos.find((x) => x.soy_yo);
    const host = activos.find((x) => x.es_anfitrion);
    const out = new Map<string, PlanPersona>();
    if (!yo || !host) return out;
    // [miembro por el que se pregunta, pagador al que se le asigna el plan]
    const preguntas: [string, string][] =
      m.modo === 'INVITO_YO'
        ? yo.es_anfitrion
          ? []
          : [[String(yo.miembro_id), String(host.miembro_id)]]
        : yo.es_anfitrion
          ? activos.filter((x) => !x.soy_yo).map((x) => [String(x.miembro_id), String(x.miembro_id)])
          : [];
    if (!preguntas.length) return out;
    const r = await q.query<{ miembro_id: string; n: number | null }>(
      'SELECT x.miembro_id, fn_plan_pagador_mesa($1, x.miembro_id) AS n FROM unnest($2::bigint[]) AS x(miembro_id)',
      [m.mesa_compartida_id, preguntas.map(([miembro]) => miembro)],
    );
    const porMiembro = new Map(r.rows.map((x) => [String(x.miembro_id), x.n]));
    for (const [miembro, pagador] of preguntas) {
      const n = porMiembro.get(miembro);
      if (n === null || n === undefined) continue;
      out.set(pagador, n > 0 ? { estado: 'OK', disponibles: n } : SIN_PLAN);
    }
    return out;
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis/mesas')
export class TablesController {
  constructor(
    private readonly svc: TablesService,
    private readonly selection: TableSelectionService,
  ) {}

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
    409: ['RESTAURANTE_PAUSADO', 'IDEMPOTENCY_KEY_REUTILIZADA'],
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CrearMesaCompartidaDto, @IdempotencyKey() key: string) {
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

  @Put(':id/seleccion')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Elegir mi almuerzo y mis platos en la mesa (reemplaza mi selección completa)',
    description:
      'Cualquier miembro, sobre lo suyo, mientras la mesa esté abierta (antes de que la caja la valide). Se valida contra el menú publicado de hoy y los agotados; los platos sueltos pueden ser de la carta fija. Ofertas flash por comensal: `almuerzo.ofertaId` y `ofertas` (no reservan stock; se toma al validar la mesa en caja). Repetir la misma petición deja el mismo resultado; un cuerpo vacío `{}` borra la selección. El anfitrión ve la de todos en `miembros[].seleccion`; un invitado solo la suya.',
  })
  @ApiOkResponse({ type: MesaResponse })
  @ApiProblems({
    400: ['ALMUERZO_INVALIDO', 'SELECCION_INVALIDA'],
    404: ['MESA_NO_ENCONTRADA', 'OFERTA_NO_ENCONTRADA'],
    409: [
      'MESA_CERRADA',
      'SALISTE_DE_LA_MESA',
      'RESTAURANTE_PAUSADO',
      'RESTAURANTE_NO_DISPONIBLE',
      'MENU_NO_PUBLICADO',
      'PLATO_AGOTADO',
      'OFERTA_AGOTADA',
      'OFERTA_EXPIRADA',
      'OFERTA_CERRADA',
      'OFERTA_NO_INICIADA',
      'STOCK_INSUFICIENTE',
    ],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO', 'OFERTA_NO_APLICA_ALMUERZO', 'OFERTA_SIN_PLATO'],
  })
  async setSelection(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string, @Body() dto: SeleccionDto) {
    await this.selection.set(user, id, dto);
    return this.svc.one(user, id);
  }

  @Post(':id/salir')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Salir de la mesa (un invitado, antes de que la caja la valide)',
    description:
      'Borra mi selección y me marca como salido (`miembros[].salio`): ya no ocupo lugar y la caja no me cobra nada al validar. Sin cuerpo y sin ' +
      '`Idempotency-Key`: repetirlo no cambia nada. El anfitrión no puede salir (puede cancelar la mesa). Puedo volver a unirme con el link.',
  })
  @ApiOkResponse({ type: MesaResponse })
  @ApiProblems({ 404: ['MESA_NO_ENCONTRADA'], 409: ['MESA_CERRADA', 'ANFITRION_NO_PUEDE_SALIR'] })
  leave(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.leave(user, id);
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

@Module({ controllers: [TablesController, InvitationsController], providers: [TablesService, TableSelectionService] })
export class TablesModule {}
