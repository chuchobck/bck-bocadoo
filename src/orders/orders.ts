import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { CheckoutModule } from '../checkout/checkout.module';
import { CheckoutService, PERSONAL_ACTUAL, RESULTADOS, type Resultado } from '../checkout/checkout';
import { ApiProblems, badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { CURSOR_TS, HOY_LOCAL, PageQuery, UUID_RE, decodeCursor, encodeCursor, restauranteRef } from '../diner/common';

/** Minutos que vive una preorden: después la caja ya no la canjea. */
export const PREORDER_MINUTES = 30;
/** Secciones que forman el almuerzo; el resto del menú se pide como extra con su precio. */
const LUNCH_SECTIONS = ['JUGO', 'SOPA', 'FUERTE', 'POSTRE'];
/** Estado visto desde afuera: un pedido EN_CAMINO cuyo plazo pasó ya está EXPIRADA aunque nadie lo haya tocado. */
export const ESTADO_EFECTIVO = `CASE WHEN o.estado = 'EN_CAMINO' AND o.vence_en <= CURRENT_TIMESTAMP THEN 'EXPIRADA' ELSE o.estado::text END`;

class AlmuerzoDto {
  @ApiProperty({
    description: 'public_id de los platos elegidos del menú de hoy, uno por sección (JUGO, SOPA, FUERTE, POSTRE)',
    example: ['uuid-sopa', 'uuid-fuerte'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @Matches(UUID_RE, { each: true, message: 'cada plato debe ser un UUID' })
  platos!: string[];
}

class ExtraDto {
  @ApiProperty({ description: 'public_id del plato (con precio) del menú de hoy' })
  @Matches(UUID_RE, { message: 'plato debe ser un UUID' })
  plato!: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) cantidad!: number;
}

export class CrearPedidoDto {
  @ApiProperty({ description: 'public_id del restaurante' })
  @Matches(UUID_RE, { message: 'restaurante debe ser un UUID' })
  restaurante!: string;
  @ApiPropertyOptional({ description: 'Suma el recargo para llevar del local al almuerzo' })
  @IsOptional()
  @IsBoolean()
  paraLlevar?: boolean;
  @ApiPropertyOptional({ type: AlmuerzoDto }) @IsOptional() @ValidateNested() @Type(() => AlmuerzoDto) almuerzo?: AlmuerzoDto;
  @ApiPropertyOptional({ type: [ExtraDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ExtraDto)
  extras?: ExtraDto[];
}

class PlatoPedido {
  @ApiProperty() id!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty({ type: String, nullable: true, enum: LUNCH_SECTIONS }) seccion!: string | null;
}
class ExtraPedido {
  @ApiProperty() id!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty() cantidad!: number;
  @ApiProperty() precioUnitarioCentavos!: number;
  @ApiProperty() subtotalCentavos!: number;
}
export class PedidoResponse {
  @ApiProperty({ description: 'public_id del pedido' }) id!: string;
  @ApiProperty({ description: 'Contenido del QR que la caja escanea: es el public_id del pedido' }) qr!: string;
  @ApiProperty({ example: 7, description: '"Pedido #7" del día' }) numero!: number;
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ example: { id: 'uuid', nombre: 'Doña Rosa', slug: 'dona-rosa' } }) restaurante!: {
    id: string;
    nombre: string;
    slug: string;
  };
  @ApiProperty({ enum: ['EN_CAMINO', 'CANJEADA', 'SERVIDA', 'EXPIRADA', 'CANCELADA'] }) estado!: string;
  @ApiProperty() paraLlevar!: boolean;
  @ApiPropertyOptional({
    description: 'null si solo pidió extras',
    example: { platos: [{ id: 'uuid', nombre: 'Seco de pollo', seccion: 'FUERTE' }], precioCentavos: 0, cubiertoPorPlan: true },
  })
  almuerzo!: { platos: PlatoPedido[]; precioCentavos: number; cubiertoPorPlan: boolean } | null;
  @ApiProperty({ type: [ExtraPedido] }) extras!: ExtraPedido[];
  @ApiProperty() recargoLlevarCentavos!: number;
  @ApiProperty({ description: 'Lo que se pagaría en caja según lo conocido al pedir' }) totalCentavos!: number;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ description: `creadoEn + ${PREORDER_MINUTES} minutos` }) venceEn!: Date;
  @ApiPropertyOptional({ type: Date, nullable: true }) canjeadoEn!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) servidoEn!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) canceladoEn!: Date | null;
}
class PedidosResponse {
  @ApiProperty({ type: [PedidoResponse] }) items!: PedidoResponse[];
  @ApiPropertyOptional({ type: String, nullable: true }) nextCursor!: string | null;
}

export interface OrderRow {
  orden_id: string;
  public_id: string;
  numero_dia: number;
  fecha_local: string;
  estado: string;
  tipo: string;
  subtotal_centavos: string;
  recargo_llevar_centavos: string;
  total_centavos: string;
  moneda_codigo: string;
  creada_en: Date;
  vence_en: Date;
  canjeada_en: Date | null;
  servida_en: Date | null;
  cancelada_en: Date | null;
  cliente_id: string | null;
  usuario_nombre: string;
  restaurante_public_id: string;
  restaurante_nombre: string;
  restaurante_slug: string;
  cursor_t: string;
}

interface LineRow {
  orden_id: string;
  plato_public_id: string;
  nombre_plato: string;
  seccion: string | null;
  cantidad: number;
  precio_unitario_centavos: string;
}

export const ORDER_SELECT = `SELECT o.orden_id, o.public_id, o.numero_dia, o.fecha_local::text AS fecha_local, ${ESTADO_EFECTIVO} AS estado, o.tipo,
       o.subtotal_centavos, o.recargo_llevar_centavos, o.total_centavos, o.moneda_codigo, o.creada_en, o.vence_en,
       o.canjeada_en, o.servida_en, o.cancelada_en, o.cliente_id, u.nombre AS usuario_nombre,
       r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug,
       ${CURSOR_TS('o.creada_en')} AS cursor_t
  FROM orden_cabecera o
  JOIN restaurante r ON r.restaurante_id = o.restaurante_id
  JOIN usuario u ON u.usuario_id = o.usuario_id`;

/**
 * Arma los pedidos con sus renglones. En orden_detalle, un renglón con `seccion` es parte del almuerzo (precio 0: el
 * precio del almuerzo es subtotal − extras) y uno sin `seccion` es un extra con su precio.
 */
export async function renderOrders(q: Queryable, rows: OrderRow[]): Promise<PedidoResponse[]> {
  if (!rows.length) return [];
  const lines = await q.query<LineRow>(
    `SELECT d.orden_id, p.public_id AS plato_public_id, d.nombre_plato, d.seccion, d.cantidad, d.precio_unitario_centavos
       FROM orden_detalle d JOIN plato p ON p.plato_id = d.plato_id
      WHERE d.orden_id = ANY($1::bigint[]) ORDER BY d.orden_detalle_id`,
    [rows.map((r) => r.orden_id)],
  );
  return rows.map((o) => {
    const mine = lines.rows.filter((l) => String(l.orden_id) === String(o.orden_id));
    const lunch = mine.filter((l) => l.seccion !== null);
    const extras = mine
      .filter((l) => l.seccion === null)
      .map((l) => ({
        id: l.plato_public_id,
        nombre: l.nombre_plato,
        cantidad: l.cantidad,
        precioUnitarioCentavos: Number(l.precio_unitario_centavos),
        subtotalCentavos: l.cantidad * Number(l.precio_unitario_centavos),
      }));
    const lunchPrice = Number(o.subtotal_centavos) - extras.reduce((s, e) => s + e.subtotalCentavos, 0);
    return {
      id: o.public_id,
      qr: o.public_id,
      numero: o.numero_dia,
      fecha: o.fecha_local,
      restaurante: restauranteRef(o),
      estado: o.estado,
      paraLlevar: o.tipo === 'LLEVAR',
      almuerzo: lunch.length
        ? {
            platos: lunch.map((l) => ({ id: l.plato_public_id, nombre: l.nombre_plato, seccion: l.seccion })),
            precioCentavos: lunchPrice,
            cubiertoPorPlan: lunchPrice === 0,
          }
        : null,
      extras,
      recargoLlevarCentavos: Number(o.recargo_llevar_centavos),
      totalCentavos: Number(o.total_centavos),
      monedaCodigo: o.moneda_codigo,
      creadoEn: o.creada_en,
      venceEn: o.vence_en,
      canjeadoEn: o.canjeada_en,
      servidoEn: o.servida_en,
      canceladoEn: o.cancelada_en,
    };
  });
}

interface MenuPick {
  plato_id: string;
  public_id: string;
  nombre: string;
  seccion: string;
  precio: string | null;
  agotado: boolean;
}

/**
 * Preórdenes del comensal. Todo corre como el comensal (userId, sin tenant): lee el menú público, su propia ficha de
 * cliente y sus propios pedidos; RLS (comensal_crea) exige que el pedido y su ficha de cliente sean suyos.
 */
@Injectable()
export class DinerOrdersService {
  constructor(private readonly db: DbService) {}

  async create(user: AuthUser, dto: CrearPedidoDto, key: string): Promise<PedidoResponse> {
    const restaurante = dto.restaurante.toLowerCase();
    const replay = await this.byKey(user, key, restaurante);
    if (replay) return replay;
    try {
      return await this.db.scope({ userId: user.userId }, (q) => this.createIn(q, dto, restaurante, key));
    } catch (err) {
      // Dos envíos simultáneos con la misma clave: el índice único deja pasar uno; el otro devuelve ese pedido.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_orden_usuario_clave') {
        const again = await this.byKey(user, key, restaurante);
        if (again) return again;
      }
      throw err;
    }
  }

  private byKey(user: AuthUser, key: string, restaurante: string) {
    return this.db.scope({ userId: user.userId, readOnly: true }, (q) => this.byKeyIn(q, key, restaurante));
  }

  private async byKeyIn(q: Queryable, key: string, restaurante: string) {
    const r = await q.query<OrderRow>(`${ORDER_SELECT} WHERE o.usuario_id = app_user_id() AND o.clave_idempotencia = $1`, [key]);
    if (!r.rows[0]) return null;
    if (r.rows[0].restaurante_public_id !== restaurante)
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó para otro pedido.');
    return (await renderOrders(q, r.rows))[0]!;
  }

  private async createIn(q: Queryable, dto: CrearPedidoDto, restaurante: string, key: string) {
    if (!dto.almuerzo && !dto.extras?.length) throw badRequest('PEDIDO_VACIO', 'Pide un almuerzo, extras o ambos.');
    // El reintento pudo terminar entre la primera lectura y esta transacción: antes de "un pedido a la vez", la clave.
    const replay = await this.byKeyIn(q, key, restaurante);
    if (replay) return replay;
    const rest = (
      await q.query<{ restaurante_id: string; precio: string; recargo: string; moneda: string; hoy: string }>(
        `SELECT r.restaurante_id, r.precio_suelto_centavos AS precio, r.recargo_para_llevar_centavos AS recargo, r.moneda_codigo AS moneda,
                ${HOY_LOCAL('r')}::text AS hoy
           FROM restaurante r WHERE r.public_id = $1 AND r.estado = 'ACTIVO'`,
        [restaurante],
      )
    ).rows[0];
    if (!rest) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
    const menu = (
      await q.query<{ menu_diario_id: string }>(
        'SELECT menu_diario_id FROM menu_diario_cabecera WHERE restaurante_id = $1 AND fecha_local = $2 AND publicado_en IS NOT NULL',
        [rest.restaurante_id, rest.hoy],
      )
    ).rows[0];
    if (!menu) throw conflict('MENU_NO_PUBLICADO', 'El restaurante aún no publicó el menú de hoy.');
    // Toma el número del día primero: bloquea por local y día, así la comprobación de abajo ve los pedidos ya confirmados
    // de peticiones simultáneas (dos envíos con claves distintas no dejan dos pedidos en camino).
    const numero = (await q.query<{ n: number }>('SELECT fn_siguiente_numero_orden($1, $2::date) AS n', [rest.restaurante_id, rest.hoy]))
      .rows[0]!.n;
    const active = await q.query(
      `SELECT 1 FROM orden_cabecera WHERE usuario_id = app_user_id() AND restaurante_id = $1 AND estado = 'EN_CAMINO' AND vence_en > CURRENT_TIMESTAMP`,
      [rest.restaurante_id],
    );
    if (active.rowCount) throw conflict('PEDIDO_ACTIVO', 'Ya tienes un pedido en camino a este restaurante.');

    const wanted = [...new Set([...(dto.almuerzo?.platos ?? []), ...(dto.extras ?? []).map((e) => e.plato)].map((p) => p.toLowerCase()))];
    const picks = new Map(
      (
        await q.query<MenuPick>(
          `SELECT p.plato_id, p.public_id, p.nombre, d.seccion, COALESCE(d.precio_centavos, p.precio_centavos) AS precio, d.agotado
             FROM menu_diario_detalle d JOIN plato p ON p.plato_id = d.plato_id AND p.restaurante_id = d.restaurante_id
            WHERE d.menu_diario_id = $1 AND p.activo AND p.public_id = ANY($2::uuid[])`,
          [menu.menu_diario_id, wanted],
        )
      ).rows.map((p) => [p.public_id, p]),
    );
    const pick = (id: string) => {
      const p = picks.get(id.toLowerCase());
      if (!p) throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no está en el menú de hoy.');
      if (p.agotado) throw conflict('PLATO_AGOTADO', `"${p.nombre}" se agotó.`);
      return p;
    };
    const lunch = (dto.almuerzo?.platos ?? []).map(pick);
    const sections = lunch.map((p) => p.seccion);
    if (sections.some((s) => !LUNCH_SECTIONS.includes(s)) || new Set(sections).size !== sections.length)
      throw badRequest('ALMUERZO_INVALIDO', `El almuerzo lleva a lo sumo un plato por sección (${LUNCH_SECTIONS.join(', ')}).`);
    const extras = (dto.extras ?? []).map((e) => {
      const p = pick(e.plato);
      if (p.precio === null) throw unprocessable('PLATO_SIN_PRECIO', `"${p.nombre}" solo se sirve dentro del almuerzo.`);
      return { p, cantidad: e.cantidad, precio: Number(p.precio) };
    });

    // ¿Lo cubre un plan? Solo es una estimación para el total: el descuento real ocurre al canjear en caja.
    const cliente = (
      await q.query<{ cliente_id: string; cubierto: boolean }>(
        `SELECT c.cliente_id, EXISTS (SELECT 1 FROM suscripcion_plan s WHERE s.restaurante_id = c.restaurante_id AND s.cliente_id = c.cliente_id
                  AND s.estado = 'ACTIVA' AND s.vence_el >= $2::date AND EXTRACT(ISODOW FROM $2::date)::smallint = ANY (s.dias_validos)) AS cubierto
           FROM cliente_restaurante c WHERE c.restaurante_id = $1 AND c.usuario_id = app_user_id() AND c.activo`,
        [rest.restaurante_id, rest.hoy],
      )
    ).rows[0];
    const lunchPrice = lunch.length && !cliente?.cubierto ? Number(rest.precio) : 0;
    const recargo = lunch.length && dto.paraLlevar ? Number(rest.recargo) : 0;
    const subtotal = lunchPrice + extras.reduce((s, e) => s + e.precio * e.cantidad, 0);

    const o = (
      await q.query<{ orden_id: string }>(
        `INSERT INTO orden_cabecera (restaurante_id, usuario_id, cliente_id, numero_dia, fecha_local, tipo, subtotal_centavos,
                                     recargo_llevar_centavos, total_centavos, moneda_codigo, vence_en, clave_idempotencia)
         VALUES ($1, app_user_id(), $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP + make_interval(mins => $10), $11)
         RETURNING orden_id`,
        [
          rest.restaurante_id,
          cliente?.cliente_id ?? null,
          numero,
          rest.hoy,
          dto.paraLlevar ? 'LLEVAR' : 'AQUI',
          subtotal,
          recargo,
          subtotal + recargo,
          rest.moneda,
          PREORDER_MINUTES,
          key,
        ],
      )
    ).rows[0]!;
    for (const p of lunch) {
      await q.query(
        `INSERT INTO orden_detalle (orden_id, restaurante_id, plato_id, seccion, nombre_plato, cantidad, precio_unitario_centavos)
         VALUES ($1, $2, $3, $4, $5, 1, 0)`,
        [o.orden_id, rest.restaurante_id, p.plato_id, p.seccion, p.nombre],
      );
    }
    for (const e of extras) {
      await q.query(
        `INSERT INTO orden_detalle (orden_id, restaurante_id, plato_id, seccion, nombre_plato, cantidad, precio_unitario_centavos)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [o.orden_id, rest.restaurante_id, e.p.plato_id, e.p.nombre, e.cantidad, e.precio],
      );
    }
    const r = await q.query<OrderRow>(`${ORDER_SELECT} WHERE o.orden_id = $1`, [o.orden_id]);
    return (await renderOrders(q, r.rows))[0]!;
  }

  list(user: AuthUser, f: PageQuery) {
    const limit = f.limit ?? 20;
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const r = await q.query<OrderRow>(
        `${ORDER_SELECT}
          WHERE o.usuario_id = app_user_id()
            AND ($1::timestamptz IS NULL OR (o.creada_en, o.public_id) < ($1::timestamptz, $2::uuid))
          ORDER BY o.creada_en DESC, o.public_id DESC LIMIT $3`,
        [cur?.t ?? null, cur?.p ?? null, limit + 1],
      );
      const page = r.rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: await renderOrders(q, page),
        nextCursor: r.rows.length > limit && last ? encodeCursor(last.cursor_t, last.public_id) : null,
      };
    });
  }

  one(user: AuthUser, id: string) {
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => (await renderOrders(q, [await this.own(q, id)]))[0]!);
  }

  /** Cancelar mientras está en camino. Repetirlo no falla. RLS (comensal_cancela) solo permite EN_CAMINO → CANCELADA. */
  cancel(user: AuthUser, id: string) {
    return this.db.scope({ userId: user.userId }, async (q) => {
      const o = await this.own(q, id);
      if (o.estado === 'EN_CAMINO') {
        await q.query(
          `UPDATE orden_cabecera SET estado = 'CANCELADA', cancelada_en = CURRENT_TIMESTAMP
            WHERE orden_id = $1 AND usuario_id = app_user_id() AND estado = 'EN_CAMINO'`,
          [o.orden_id],
        );
      } else if (o.estado === 'EXPIRADA') throw conflict('PEDIDO_EXPIRADO', 'El pedido ya venció.');
      else if (o.estado !== 'CANCELADA') throw conflict('PEDIDO_NO_CANCELABLE', 'El pedido ya fue canjeado en caja.');
      const r = await q.query<OrderRow>(`${ORDER_SELECT} WHERE o.orden_id = $1`, [o.orden_id]);
      return (await renderOrders(q, r.rows))[0]!;
    });
  }

  private async own(q: Queryable, id: string) {
    const r = await q.query<OrderRow>(`${ORDER_SELECT} WHERE o.usuario_id = app_user_id() AND o.public_id = $1`, [id]);
    if (!r.rows[0]) throw notFound('PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado.');
    return r.rows[0];
  }
}

@ApiTags('comensal')
@ApiBearerAuth()
@Controller('v1/mis/pedidos')
export class DinerOrdersController {
  constructor(private readonly svc: DinerOrdersService) {}

  @Post()
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Hacer una preorden del menú de hoy',
    description:
      `El pedido vence a los ${PREORDER_MINUTES} minutos. Su QR es el public_id (\`qr\`): la caja lo escanea y descuenta el almuerzo ` +
      'del plan. Precios del servidor: el almuerzo vale 0 si un plan vigente lo cubre, si no el precio suelto del local. ' +
      'Un pedido en camino a la vez por local.',
  })
  @ApiCreatedResponse({ type: PedidoResponse })
  @ApiProblems({
    400: ['PEDIDO_VACIO', 'ALMUERZO_INVALIDO', 'IDEMPOTENCY_KEY_INVALIDA'],
    404: ['RESTAURANTE_NO_ENCONTRADO'],
    409: ['MENU_NO_PUBLICADO', 'PEDIDO_ACTIVO', 'PLATO_AGOTADO', 'IDEMPOTENCY_KEY_REUTILIZADA'],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO'],
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CrearPedidoDto, @IdempotencyKey() key: string) {
    return this.svc.create(user, dto, key);
  }

  @Get()
  @ApiOperation({ summary: 'Mis pedidos, del más reciente al más antiguo' })
  @ApiOkResponse({ type: PedidosResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'] })
  list(@CurrentUser() user: AuthUser, @Query() q: PageQuery) {
    return this.svc.list(user, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Un pedido mío' })
  @ApiOkResponse({ type: PedidoResponse })
  @ApiProblems({ 404: ['PEDIDO_NO_ENCONTRADO'] })
  one(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.one(user, id);
  }

  @Post(':id/cancelar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar mi pedido mientras está en camino' })
  @ApiOkResponse({ type: PedidoResponse })
  @ApiProblems({ 404: ['PEDIDO_NO_ENCONTRADO'], 409: ['PEDIDO_EXPIRADO', 'PEDIDO_NO_CANCELABLE'] })
  cancel(@CurrentUser() user: AuthUser, @Param('id', UuidPipe) id: string) {
    return this.svc.cancel(user, id);
  }
}

// --- Personal del restaurante ---------------------------------------------------------------------------------

const FILTROS = ['ACTIVOS', 'EN_CAMINO', 'CANJEADA', 'SERVIDA', 'EXPIRADA', 'CANCELADA', 'TODOS'] as const;

class PedidosCajaQuery {
  @ApiPropertyOptional({ enum: FILTROS, default: 'ACTIVOS', description: 'ACTIVOS = en camino (sin vencer) + canjeados sin servir' })
  @IsOptional()
  @IsIn(FILTROS)
  estado?: (typeof FILTROS)[number];
}

class PedidoCaja extends PedidoResponse {
  @ApiProperty({ example: { nombre: 'Ana Pérez' }, description: 'Quién pidió (nombre de su cuenta)' }) comensal!: { nombre: string };
  @ApiPropertyOptional({
    example: { nombre: 'Ana Pérez', almuerzosDisponibles: 4 },
    description: 'Su ficha de cliente en este local; null si no es cliente',
  })
  cliente!: { nombre: string; almuerzosDisponibles: number } | null;
}

class PedidoCanjeResponse {
  @ApiProperty({ type: PedidoCaja }) pedido!: PedidoCaja;
  @ApiProperty({ description: 'El pedido ya estaba canjeado: no se descontó nada esta vez' }) yaCanjeado!: boolean;
  @ApiPropertyOptional({
    description: 'null si el pedido no lleva almuerzo. `resultado` es null al repetir un canje ya hecho.',
    example: { resultado: 'OK', mensaje: RESULTADOS.OK, descontado: true, consumoId: 'uuid' },
  })
  almuerzo!: { resultado: Resultado | null; mensaje: string | null; descontado: boolean; consumoId: string | null } | null;
  @ApiProperty({ description: 'Lo que la caja cobra aparte: extras, recargo y el almuerzo si ningún plan lo cubrió' })
  porCobrarCentavos!: number;
}

interface StaffRow extends OrderRow {
  cliente_nombre: string | null;
  disponibles: number | null;
}

const STAFF_SELECT = `SELECT x.*, c.nombre AS cliente_nombre,
       (SELECT COALESCE(sum(s.almuerzos_restantes), 0)::int FROM suscripcion_plan s
         WHERE s.restaurante_id = x.restaurante_id_ AND s.cliente_id = c.cliente_id AND s.estado = 'ACTIVA'
           AND s.vence_el >= x.fecha_local::date) AS disponibles
  FROM (${ORDER_SELECT.replace('SELECT o.orden_id,', 'SELECT o.restaurante_id AS restaurante_id_, o.orden_id,')} WHERE o.restaurante_id = app_tenant_id()) x
  LEFT JOIN cliente_restaurante c ON c.restaurante_id = x.restaurante_id_ AND c.cliente_id = x.cliente_id`;

/**
 * El pedido del comensal visto desde la caja (dueño y cajero, con tenant: RLS tenant_total). La caja escanea el QR
 * (public_id), lo canjea —descuenta el almuerzo del plan con canal PREORDEN— y lo marca servido.
 */
@Injectable()
export class StaffOrdersService {
  constructor(
    private readonly db: DbService,
    private readonly checkout: CheckoutService,
  ) {}

  list(estado: (typeof FILTROS)[number] = 'ACTIVOS') {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<StaffRow>(
          `${STAFF_SELECT}
            WHERE x.fecha_local::date = (SELECT ${HOY_LOCAL('r')} FROM restaurante r WHERE r.restaurante_id = app_tenant_id())
              AND ($1 = 'TODOS' OR ($1 = 'ACTIVOS' AND x.estado IN ('EN_CAMINO', 'CANJEADA')) OR x.estado = $1)
            ORDER BY x.numero_dia LIMIT 200`,
          [estado],
        );
        return this.render(q, r.rows);
      },
      { readOnly: true },
    );
  }

  one(id: string) {
    return this.db.forRequest(async (q) => (await this.render(q, [await this.load(q, id, false)]))[0]!, { readOnly: true });
  }

  /** Canjear el QR del pedido. Repetirlo (misma u otra clave) no descuenta otra vez: el pedido queda bloqueado mientras tanto. */
  redeem(id: string, key: string): Promise<PedidoCanjeResponse> {
    return this.db.forRequest(async (q) => {
      const o = await this.load(q, id, true);
      if (o.estado === 'CANCELADA') throw conflict('PEDIDO_CANCELADO', 'El comensal canceló este pedido.');
      if (o.estado === 'EXPIRADA') throw conflict('PEDIDO_EXPIRADO', 'El pedido venció: atiéndelo como una venta normal.');
      const pedidoLines = await renderOrders(q, [o]);
      const hasLunch = pedidoLines[0]!.almuerzo !== null;
      const extras = pedidoLines[0]!.extras.reduce((s, e) => s + e.subtotalCentavos, 0);
      const precio = Number(
        (await q.query<{ p: string }>('SELECT precio_suelto_centavos AS p FROM restaurante WHERE restaurante_id = app_tenant_id()'))
          .rows[0]!.p,
      );
      const due = (covered: boolean) => extras + Number(o.recargo_llevar_centavos) + (hasLunch && !covered ? precio : 0);

      if (o.estado === 'CANJEADA' || o.estado === 'SERVIDA') {
        const c = await q.query<{ public_id: string }>(
          `SELECT k.public_id FROM consumo_almuerzo k WHERE k.restaurante_id = app_tenant_id() AND k.orden_id = $1 AND k.cantidad = 1
              AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)`,
          [o.orden_id],
        );
        const consumoId = c.rows[0]?.public_id ?? null;
        return {
          pedido: (await this.render(q, [o]))[0]!,
          yaCanjeado: true,
          almuerzo: hasLunch ? { resultado: null, mensaje: null, descontado: consumoId !== null, consumoId } : null,
          porCobrarCentavos: due(consumoId !== null),
        };
      }

      let almuerzo: PedidoCanjeResponse['almuerzo'] = null;
      if (hasLunch) {
        if (o.cliente_id) {
          // La función de base solo mira restaurante + clave: una clave ya usada en otro consumo devolvería ese consumo.
          const prev = await q.query<{ orden_id: string | null }>(
            'SELECT orden_id FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1',
            [key],
          );
          if (prev.rows[0] && String(prev.rows[0].orden_id) !== String(o.orden_id))
            throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó en otra validación.');
          const personalId = (await q.query<{ p: string }>(`SELECT ${PERSONAL_ACTUAL} AS p`)).rows[0]!.p;
          const r = await this.checkout.deduct(q, {
            clienteId: String(o.cliente_id),
            personalId,
            key,
            canal: 'PREORDEN',
            paraLlevar: o.tipo === 'LLEVAR',
            ordenId: String(o.orden_id),
          });
          almuerzo = { resultado: r.resultado, mensaje: r.mensaje, descontado: r.descontado, consumoId: r.consumo?.id ?? null };
        } else {
          almuerzo = { resultado: 'SIN_PLAN', mensaje: RESULTADOS.SIN_PLAN, descontado: false, consumoId: null };
        }
      }
      await q.query(
        `UPDATE orden_cabecera SET estado = 'CANJEADA', canjeada_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND orden_id = $1`,
        [o.orden_id],
      );
      const after = await this.load(q, id, false);
      return {
        pedido: (await this.render(q, [after]))[0]!,
        yaCanjeado: false,
        almuerzo,
        porCobrarCentavos: due(almuerzo?.descontado ?? false),
      };
    });
  }

  serve(id: string) {
    return this.db.forRequest(async (q) => {
      const o = await this.load(q, id, true);
      if (o.estado === 'CANJEADA')
        await q.query(
          `UPDATE orden_cabecera SET estado = 'SERVIDA', servida_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND orden_id = $1`,
          [o.orden_id],
        );
      else if (o.estado !== 'SERVIDA') throw conflict('PEDIDO_NO_CANJEADO', 'Primero canjea el pedido en caja.');
      return (await this.render(q, [await this.load(q, id, false)]))[0]!;
    });
  }

  private async load(q: Queryable, id: string, lock: boolean): Promise<StaffRow> {
    if (lock) await q.query('SELECT 1 FROM orden_cabecera WHERE restaurante_id = app_tenant_id() AND public_id = $1 FOR UPDATE', [id]);
    const r = await q.query<StaffRow>(`${STAFF_SELECT} WHERE x.public_id = $1`, [id]);
    if (!r.rows[0]) throw notFound('PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado.');
    return r.rows[0];
  }

  private async render(q: Queryable, rows: StaffRow[]): Promise<PedidoCaja[]> {
    const base = await renderOrders(q, rows);
    return base.map((p, i) => ({
      ...p,
      comensal: { nombre: rows[i]!.usuario_nombre },
      cliente:
        rows[i]!.cliente_nombre === null ? null : { nombre: rows[i]!.cliente_nombre!, almuerzosDisponibles: rows[i]!.disponibles ?? 0 },
    }));
  }
}

@ApiTags('caja')
@Controller('v1/caja/pedidos')
export class StaffOrdersController {
  constructor(private readonly svc: StaffOrdersService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Preórdenes de hoy', description: 'Por defecto las activas, en orden de número ("Pedido #N").' })
  @ApiOkResponse({ type: [PedidoCaja] })
  list(@Query() q: PedidosCajaQuery) {
    return this.svc.list(q.estado);
  }

  @Roles('DUENO', 'CAJERO')
  @Get(':id')
  @ApiOperation({ summary: 'Ver un pedido por su QR (public_id)' })
  @ApiOkResponse({ type: PedidoCaja })
  @ApiProblems({ 404: ['PEDIDO_NO_ENCONTRADO'] })
  one(@Param('id', UuidPipe) id: string) {
    return this.svc.one(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/canjear')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Canjear el QR del pedido',
    description:
      'Si el pedido lleva almuerzo y el comensal es cliente, descuenta del plan que vence primero (canal PREORDEN, mismos resultados ' +
      'que `POST /v1/caja/validar`). `porCobrarCentavos` es lo que se cobra aparte como venta suelta.',
  })
  @ApiOkResponse({ type: PedidoCanjeResponse })
  @ApiProblems({ 404: ['PEDIDO_NO_ENCONTRADO'], 409: ['PEDIDO_EXPIRADO', 'PEDIDO_CANCELADO', 'IDEMPOTENCY_KEY_REUTILIZADA'] })
  redeem(@Param('id', UuidPipe) id: string, @IdempotencyKey() key: string) {
    return this.svc.redeem(id, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/servir')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar el pedido como servido' })
  @ApiOkResponse({ type: PedidoCaja })
  @ApiProblems({ 404: ['PEDIDO_NO_ENCONTRADO'], 409: ['PEDIDO_NO_CANJEADO'] })
  serve(@Param('id', UuidPipe) id: string) {
    return this.svc.serve(id);
  }
}

@Module({
  imports: [CheckoutModule],
  controllers: [DinerOrdersController, StaffOrdersController],
  providers: [DinerOrdersService, StaffOrdersService],
})
export class OrdersModule {}
