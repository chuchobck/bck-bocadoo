import { Body, Controller, Get, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
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
import { PassEventBus } from '../pass-events/bus';
import { occupancy } from '../catalog/catalog.service';
import {
  type CategoriaPlato,
  type CotizacionRespuesta,
  type PlatoSuelto,
  SIN_PLAN,
  aRespuesta,
  cotizarInformativa,
  entradaPedido,
  entradaPedidoCreado,
  precioAlmuerzoDePedido,
} from '../cobro/adaptador';
import {
  clavePagoEnElPaso,
  cuentaDeOrden,
  cuentaPorClave,
  descontarYRecotizar,
  errorDePago,
  normalizarCobro,
  estadoPlanDe,
  persistirCuenta,
  registrarPago,
  renderCuenta,
  saldoCambio,
} from '../cobro/aplicar';
import { AvisoCotizacionResponse, CotizacionResponse } from '../cobro/cotizacion.dto';
import { CobroDto, CuentaResponse } from '../cobro/cuenta.dto';
import { huella } from '../common/derive-key';
import { horaLlegadaEnVentana } from '../common/hora-llegada';
import { cargarPlanes, claveCliente, planVigenteHoySql } from '../cobro/planes';
import { cotizar } from '../billing/cotizar';
import { type Cotizacion, CotizarError, type MomentoCobro, type PlanPersona } from '../billing/tipos';
import {
  CURSOR_TS,
  HOY_LOCAL,
  PageQuery,
  assertMenuPublicado,
  restaurantePausado,
  UUID_RE,
  decodeCursor,
  encodeCursor,
  restauranteRef,
} from '../diner/common';

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
  @ApiPropertyOptional({
    example: '2026-11-13T17:30:00Z',
    description:
      'Hora a la que el comensal piensa llegar (ISO 8601, de 5 minutos atrás a 12 horas adelante). Solo informativa: no cambia el vencimiento.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  horaLlegada?: string;
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
  @ApiProperty({
    type: CotizacionResponse,
    description:
      'Cotización estimada (informativa) con la regla de cobro objetivo (docs/spec-cobros.md). Para un pedido ya creado el precio del almuerzo sale de `subtotal − extras` y el plan se lee de hoy. ' +
      'Puede diferir de `totalCentavos`: por ahora solo si un extra del menú es un plato `A_LA_CARTA` pedido para llevar (la cotización suma el recargo por unidad; `totalCentavos` aún no). Cambia en el PR 7.',
  })
  cotizacion!: CotizacionResponse;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ description: `creadoEn + ${PREORDER_MINUTES} minutos` }) venceEn!: Date;
  @ApiProperty({ type: Date, nullable: true, description: 'Hora de llegada que mandó el comensal al pedir; null si no la mandó' })
  horaLlegada!: Date | null;
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
  restaurante_id: string;
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
  hora_llegada: Date | null;
  cliente_id: string | null;
  usuario_id: string;
  usuario_nombre: string;
  /** Snapshot de P al pedir (INC-06); null en pedidos anteriores al PR 5a. */
  precio_almuerzo_centavos: string | null;
  /** Hay un consumo del plan de este pedido que no se deshizo. */
  con_consumo: boolean;
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
  categoria: CategoriaPlato;
  plato_seccion: string | null;
}

interface PreciosRow {
  restaurante_id: string;
  precio: string;
  recargo: string;
  momento_cobro: MomentoCobro;
}

export const ORDER_SELECT = `SELECT o.orden_id, o.restaurante_id, o.public_id, o.numero_dia, o.fecha_local::text AS fecha_local, ${ESTADO_EFECTIVO} AS estado, o.tipo,
       o.subtotal_centavos, o.recargo_llevar_centavos, o.total_centavos, o.moneda_codigo, o.creada_en, o.vence_en,
       o.canjeada_en, o.servida_en, o.cancelada_en, o.hora_llegada, o.cliente_id, o.usuario_id, u.nombre AS usuario_nombre, o.precio_almuerzo_centavos,
       EXISTS (SELECT 1 FROM consumo_almuerzo k WHERE k.restaurante_id = o.restaurante_id AND k.orden_id = o.orden_id AND k.cantidad = 1
                  AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)) AS con_consumo,
       r.public_id AS restaurante_public_id, r.nombre AS restaurante_nombre, r.slug AS restaurante_slug,
       ${CURSOR_TS('o.creada_en')} AS cursor_t
  FROM orden_cabecera o
  JOIN restaurante r ON r.restaurante_id = o.restaurante_id
  JOIN usuario u ON u.usuario_id = o.usuario_id`;

/** Extras del pedido (renglones sin sección) como platos sueltos para la cotización. */
function extrasParaCobro(lines: LineRow[]): PlatoSuelto[] {
  return lines
    .filter((l) => l.seccion === null)
    .map((l) => ({
      platoId: l.plato_public_id,
      nombre: l.nombre_plato,
      categoria: l.categoria,
      seccion: l.plato_seccion,
      cantidad: l.cantidad,
      precioUnitario: Number(l.precio_unitario_centavos),
    }));
}

/** Renglones de pedidos (orden_detalle) con su plato. */
async function orderLines(q: Queryable, ordenIds: string[]): Promise<LineRow[]> {
  return (
    await q.query<LineRow>(
      `SELECT d.orden_id, p.public_id AS plato_public_id, d.nombre_plato, d.seccion, d.cantidad, d.precio_unitario_centavos, p.categoria, p.seccion AS plato_seccion
         FROM orden_detalle d JOIN plato p ON p.plato_id = d.plato_id
        WHERE d.orden_id = ANY($1::bigint[]) ORDER BY d.orden_detalle_id`,
      [ordenIds],
    )
  ).rows;
}

/**
 * Arma los pedidos con sus renglones. En orden_detalle, un renglón con `seccion` es parte del almuerzo (precio 0: el
 * precio del almuerzo es subtotal − extras) y uno sin `seccion` es un extra con su precio.
 */
export async function renderOrders(q: Queryable, rows: OrderRow[]): Promise<PedidoResponse[]> {
  if (!rows.length) return [];
  const lines = {
    rows: await orderLines(
      q,
      rows.map((r) => r.orden_id),
    ),
  };
  // Precios y plan de HOY para la cotización informativa (el precio del almuerzo del pedido sale de subtotal − extras).
  const restaurantes = [...new Set(rows.map((r) => String(r.restaurante_id)))];
  const precios = new Map(
    (
      await q.query<PreciosRow>(
        `SELECT restaurante_id, precio_suelto_centavos AS precio, recargo_para_llevar_centavos AS recargo, momento_cobro
           FROM restaurante WHERE restaurante_id = ANY($1::bigint[])`,
        [restaurantes],
      )
    ).rows.map((p) => [String(p.restaurante_id), p]),
  );
  const planes = await cargarPlanes(
    q,
    rows.map((r) => ({ restauranteId: String(r.restaurante_id), clienteId: r.cliente_id === null ? null : String(r.cliente_id) })),
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
    const pr = precios.get(String(o.restaurante_id))!;
    const plan: PlanPersona =
      (o.cliente_id !== null && planes.get(claveCliente(String(o.restaurante_id), String(o.cliente_id)))) || SIN_PLAN;
    const base = {
      recargoLlevar: Number(pr.recargo),
      momentoCobro: pr.momento_cobro,
      paraLlevar: o.tipo === 'LLEVAR',
      conAlmuerzo: lunch.length > 0,
      subtotal: Number(o.subtotal_centavos),
      plan,
      extras: extrasParaCobro(mine),
    };
    const canjeado = o.estado === 'CANJEADA' || o.estado === 'SERVIDA' ? { conConsumo: o.con_consumo } : null;
    // Con snapshot de P (INC-06) se cotiza con él; si así no se puede (P = 0 y sin plan, I-12), como un pedido viejo.
    const snapshot = o.precio_almuerzo_centavos === null ? null : Number(o.precio_almuerzo_centavos);
    const cotizacion =
      (snapshot === null ? null : cotizarInformativa(entradaPedidoCreado({ ...base, precioAlmuerzo: snapshot, canjeado }))) ??
      cotizarInformativa(entradaPedidoCreado(base))!;
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
      cotizacion: aRespuesta(cotizacion, o.moneda_codigo),
      creadoEn: o.creada_en,
      venceEn: o.vence_en,
      horaLlegada: o.hora_llegada,
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
  categoria: CategoriaPlato;
  plato_seccion: string | null;
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

  /** Todo lo que se valida antes de pedir (compartido con `cotizar`): local, menú de hoy, aforo y platos. No escribe nada. */
  private async resolve(q: Queryable, dto: CrearPedidoDto, restaurante: string) {
    if (!dto.almuerzo && !dto.extras?.length) throw badRequest('PEDIDO_VACIO', 'Pide un almuerzo, extras o ambos.');
    const horaLlegada = dto.horaLlegada === undefined ? null : horaLlegadaEnVentana(dto.horaLlegada);
    const rest = (
      await q.query<{
        restaurante_id: string;
        estado: string;
        precio: string;
        recargo: string;
        moneda: string;
        hoy: string;
        momento: MomentoCobro;
      }>(
        `SELECT r.restaurante_id, r.estado, r.precio_suelto_centavos AS precio, r.recargo_para_llevar_centavos AS recargo, r.moneda_codigo AS moneda,
                ${HOY_LOCAL('r')}::text AS hoy, r.momento_cobro AS momento
           FROM restaurante r WHERE r.public_id = $1 AND r.estado IN ('ACTIVO', 'PAUSADO')`,
        [restaurante],
      )
    ).rows[0];
    if (!rest) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
    if (rest.estado === 'PAUSADO') throw restaurantePausado();
    const menu = { menu_diario_id: await assertMenuPublicado(q, rest.restaurante_id) };
    // Con el local LLENO (manual o por aforo, la misma ocupación de la vitrina) solo se admite para llevar.
    if (!dto.paraLlevar) {
      const o = (
        await q.query<{ personas: number; puestos: number; lleno_manual: boolean; concurrido_manual: boolean }>(
          'SELECT personas, puestos, lleno_manual, concurrido_manual FROM fn_ocupacion_local($1)',
          [rest.restaurante_id],
        )
      ).rows[0];
      if (o && occupancy(o.personas, o.puestos, o.lleno_manual, o.concurrido_manual).nivel === 'LLENO')
        throw conflict('LOCAL_LLENO_SOLO_LLEVAR', 'El local está lleno: por ahora solo se aceptan pedidos para llevar.');
    }
    return { rest, menu, horaLlegada };
  }

  /** Un pedido en camino a la vez por local. */
  private async assertSinPedidoActivo(q: Queryable, restauranteId: string) {
    const active = await q.query(
      `SELECT 1 FROM orden_cabecera WHERE usuario_id = app_user_id() AND restaurante_id = $1 AND estado = 'EN_CAMINO' AND vence_en > CURRENT_TIMESTAMP`,
      [restauranteId],
    );
    if (active.rowCount) throw conflict('PEDIDO_ACTIVO', 'Ya tienes un pedido en camino a este restaurante.');
  }

  /** Platos del pedido contra el menú de hoy (agotados, sección única, precio). */
  private async platos(q: Queryable, dto: CrearPedidoDto, menuId: string) {
    const wanted = [...new Set([...(dto.almuerzo?.platos ?? []), ...(dto.extras ?? []).map((e) => e.plato)].map((p) => p.toLowerCase()))];
    const picks = new Map(
      (
        await q.query<MenuPick>(
          `SELECT p.plato_id, p.public_id, p.nombre, p.categoria, p.seccion AS plato_seccion, d.seccion, COALESCE(d.precio_centavos, p.precio_centavos) AS precio, d.agotado
             FROM menu_diario_detalle d JOIN plato p ON p.plato_id = d.plato_id AND p.restaurante_id = d.restaurante_id
            WHERE d.menu_diario_id = $1 AND p.activo AND p.public_id = ANY($2::uuid[])`,
          [menuId, wanted],
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
    return { lunch, extras };
  }

  /**
   * POST /v1/mis/pedidos/cotizar: lo mismo que pedir, sin pedir. No escribe nada (ni el número del día ni el pedido):
   * corre en una transacción de solo lectura. Responde la cotización estimada con el plan de hoy del comensal.
   */
  cotizar(user: AuthUser, dto: CrearPedidoDto): Promise<CotizacionRespuesta> {
    const restaurante = dto.restaurante.toLowerCase();
    return this.db.scope({ userId: user.userId, readOnly: true }, async (q) => {
      const { rest, menu } = await this.resolve(q, dto, restaurante);
      await this.assertSinPedidoActivo(q, rest.restaurante_id);
      const { lunch, extras } = await this.platos(q, dto, menu.menu_diario_id);
      const cliente = (
        await q.query<{ cliente_id: string }>(
          'SELECT cliente_id FROM cliente_restaurante WHERE restaurante_id = $1 AND usuario_id = app_user_id() AND activo',
          [rest.restaurante_id],
        )
      ).rows[0];
      const planes = await cargarPlanes(q, [
        { restauranteId: String(rest.restaurante_id), clienteId: cliente ? String(cliente.cliente_id) : null },
      ]);
      const plan = (cliente && planes.get(claveCliente(String(rest.restaurante_id), String(cliente.cliente_id)))) || SIN_PLAN;
      try {
        return aRespuesta(
          cotizar(
            entradaPedido({
              precioAlmuerzo: Number(rest.precio),
              recargoLlevar: Number(rest.recargo),
              momentoCobro: rest.momento,
              paraLlevar: dto.paraLlevar ?? false,
              conAlmuerzo: lunch.length > 0,
              plan,
              extras: extras.map((e) => ({
                platoId: e.p.public_id,
                nombre: e.p.nombre,
                categoria: e.p.categoria,
                seccion: e.p.plato_seccion,
                cantidad: e.cantidad,
                precioUnitario: e.precio,
              })),
            }),
          ),
          rest.moneda,
        );
      } catch (e) {
        if (e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO')
          throw conflict('ALMUERZO_SIN_PRECIO', 'El almuerzo no tiene precio en este local y ningún plan lo cubre.');
        throw e;
      }
    });
  }

  private async createIn(q: Queryable, dto: CrearPedidoDto, restaurante: string, key: string) {
    if (!dto.almuerzo && !dto.extras?.length) throw badRequest('PEDIDO_VACIO', 'Pide un almuerzo, extras o ambos.');
    // El reintento pudo terminar entre la primera lectura y esta transacción: antes de "un pedido a la vez", la clave.
    const replay = await this.byKeyIn(q, key, restaurante);
    if (replay) return replay;
    const { rest, menu, horaLlegada } = await this.resolve(q, dto, restaurante);
    // Toma el número del día primero: bloquea por local y día, así la comprobación de abajo ve los pedidos ya confirmados
    // de peticiones simultáneas (dos envíos con claves distintas no dejan dos pedidos en camino).
    const numero = (await q.query<{ n: number }>('SELECT fn_siguiente_numero_orden($1, $2::date) AS n', [rest.restaurante_id, rest.hoy]))
      .rows[0]!.n;
    await this.assertSinPedidoActivo(q, rest.restaurante_id);
    const { lunch, extras } = await this.platos(q, dto, menu.menu_diario_id);

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
                                     recargo_llevar_centavos, total_centavos, moneda_codigo, vence_en, clave_idempotencia, precio_almuerzo_centavos,
                                     hora_llegada)
         VALUES ($1, app_user_id(), $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP + make_interval(mins => $10), $11, $12, $13)
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
          // Snapshot de P (INC-06): lo que vale el almuerzo si la caja lo cobra, aunque al pedir lo cubra un plan.
          Number(rest.precio),
          horaLlegada,
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
    400: ['PEDIDO_VACIO', 'HORA_LLEGADA_INVALIDA', 'ALMUERZO_INVALIDO', 'IDEMPOTENCY_KEY_INVALIDA'],
    404: ['RESTAURANTE_NO_ENCONTRADO'],
    409: [
      'RESTAURANTE_PAUSADO',
      'LOCAL_LLENO_SOLO_LLEVAR',
      'MENU_NO_PUBLICADO',
      'PEDIDO_ACTIVO',
      'PLATO_AGOTADO',
      'IDEMPOTENCY_KEY_REUTILIZADA',
    ],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO'],
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CrearPedidoDto, @IdempotencyKey() key: string) {
    return this.svc.create(user, dto, key);
  }

  @Post('cotizar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cotizar un pedido sin hacerlo',
    description:
      'Mismo cuerpo y mismas validaciones que `POST /v1/mis/pedidos`, pero sin `Idempotency-Key` y sin efectos: no crea el pedido, ' +
      'no toma número del día y no toca el plan. Responde la `Cotizacion` estimada (`estimada: true`) con el plan de hoy del comensal. ' +
      'Para mostrar el total antes de pedir. Hoy cotiza el menú del día; carta y ofertas llegan en el PR 7.',
  })
  @ApiOkResponse({ type: CotizacionResponse })
  @ApiProblems({
    400: ['PEDIDO_VACIO', 'HORA_LLEGADA_INVALIDA', 'ALMUERZO_INVALIDO'],
    404: ['RESTAURANTE_NO_ENCONTRADO'],
    409: ['RESTAURANTE_PAUSADO', 'LOCAL_LLENO_SOLO_LLEVAR', 'MENU_NO_PUBLICADO', 'PEDIDO_ACTIVO', 'PLATO_AGOTADO', 'ALMUERZO_SIN_PRECIO'],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO'],
  })
  cotizar(@CurrentUser() user: AuthUser, @Body() dto: CrearPedidoDto) {
    return this.svc.cotizar(user, dto);
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
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Sopa de quinua + Seco de pollo',
    description: 'Platos del almuerzo preordenado, unidos con " + "; null si el pedido no lleva almuerzo',
  })
  platoNombre!: string | null;
  @ApiProperty({ description: 'El pedido ya estaba canjeado: no se descontó nada esta vez' }) yaCanjeado!: boolean;
  @ApiPropertyOptional({
    description: 'null si el pedido no lleva almuerzo. `resultado` es null al repetir un canje ya hecho.',
    example: { resultado: 'OK', mensaje: RESULTADOS.OK, descontado: true, consumoId: 'uuid' },
  })
  almuerzo!: { resultado: Resultado | null; mensaje: string | null; descontado: boolean; consumoId: string | null } | null;
  @ApiProperty({
    description:
      'Lo que la caja cobra aparte: extras, recargo y el almuerzo si ningún plan lo cubrió (al precio guardado en el pedido). ' +
      'Vale `cotizacion.saldoPorCobrarCentavos` (desde el PR 6c también sin cuenta: 0 si el almuerzo quedó omitido por `DUPLICADO` o `LIMITE_SAAS`).',
  })
  porCobrarCentavos!: number;
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización final (`estimada: false`) con lo que de verdad pasó en caja (plan descontado o no) y el precio del almuerzo guardado en el pedido. ' +
      'Con cuenta, es la de la cuenta. null solo si el almuerzo no tiene precio en el local y ningún plan lo cubrió (I-12) y no se mandó `cobro`.',
  })
  cotizacion!: CotizacionResponse | null;
  @ApiProperty({
    type: CuentaResponse,
    nullable: true,
    description:
      'La cuenta de cobro del pedido. Con `cobro`, siempre. Sin `cobro`, se abre `ABIERTA` (sin pago) si el saldo final es > 0 ' +
      '(desde el PR 6c); null si el saldo es 0 (el plan cubrió todo) o si el almuerzo no tiene precio en el local (I-12).',
  })
  cuenta!: CuentaResponse | null;
  @ApiProperty({ type: [AvisoCotizacionResponse], description: 'Avisos de este canje (p. ej. DUPLICADO, LIMITE_SAAS)' })
  avisos!: { codigo: string; lineaRef: string | null }[];
}

export class CanjearPedidoDto {
  @ApiPropertyOptional({
    type: CobroDto,
    description:
      'Opcional. Sin `cobro`, si el saldo final es > 0 se abre la cuenta `ABIERTA` del pedido sin pago (desde el PR 6c) y nunca hay ' +
      '`SALDO_CAMBIO`; con saldo 0, sin cuenta. Con `cobro` (aunque sea `{}`) siempre crea la cuenta del pedido; con ' +
      '`metodoPago`, registra el pago en la misma transacción. Con `cobro`, si el saldo final no es `saldoEsperadoCentavos` (o, sin él, el `totalCentavos` ' +
      'del pedido) → 409 `SALDO_CAMBIO` sin descontar el plan ni cobrar nada.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CobroDto)
  cobro?: CobroDto;
}

interface StaffRow extends OrderRow {
  cliente_nombre: string | null;
  disponibles: number | null;
}

const STAFF_SELECT = `SELECT x.*, c.nombre AS cliente_nombre,
       (SELECT COALESCE(sum(s.almuerzos_restantes), 0)::int FROM suscripcion_plan s
         WHERE s.restaurante_id = x.restaurante_id_ AND s.cliente_id = c.cliente_id AND ${planVigenteHoySql('s', 'x.fecha_local::date')}) AS disponibles
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
    private readonly passEvents: PassEventBus,
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

  /**
   * Canjear el QR del pedido. Repetirlo (misma u otra clave) no descuenta otra vez: el pedido queda bloqueado mientras
   * tanto. Con `cobro` (docs/spec-cobros.md E.3) crea la cuenta del pedido con la cotización final y, con `metodoPago`,
   * la paga; si el saldo final no es el esperado, 409 `SALDO_CAMBIO` y la transacción se deshace (ni plan ni cobro).
   * Sin `cobro`, la cuenta se abre (sin pago ni SALDO_CAMBIO) solo si el saldo final es > 0 (PR 6c).
   */
  async redeem(id: string, key: string, dto: CanjearPedidoDto = {}): Promise<PedidoCanjeResponse> {
    const eventos = this.passEvents.pending();
    let res: PedidoCanjeResponse;
    try {
      res = await this.db.forRequest((q) => this.redeemIn(q, id, key, dto.cobro ?? null, eventos));
    } catch (err) {
      throw errorDePago(err);
    }
    eventos.flush(); // CANJE_REGISTRADO (con los platos) al comensal: solo con el COMMIT hecho
    return res;
  }

  private async redeemIn(
    q: Queryable,
    id: string,
    key: string,
    cobro: CobroDto | null,
    eventos: ReturnType<PassEventBus['pending']>,
  ): Promise<PedidoCanjeResponse> {
    const o = await this.load(q, id, true);
    if (o.estado === 'CANCELADA') throw conflict('PEDIDO_CANCELADO', 'El comensal canceló este pedido.');
    if (o.estado === 'EXPIRADA') throw conflict('PEDIDO_EXPIRADO', 'El pedido venció: atiéndelo como una venta normal.');
    const pedido0 = (await renderOrders(q, [o]))[0]!;
    const hasLunch = pedido0.almuerzo !== null;
    const platoNombre = pedido0.almuerzo?.platos.map((p) => p.nombre).join(' + ') ?? null;
    const extras = pedido0.extras.reduce((s, e) => s + e.subtotalCentavos, 0);
    const rest = (
      await q.query<{ precio: string; recargo: string; momento: MomentoCobro; moneda: string }>(
        `SELECT precio_suelto_centavos AS precio, recargo_para_llevar_centavos AS recargo, momento_cobro AS momento, moneda_codigo AS moneda
           FROM restaurante WHERE restaurante_id = app_tenant_id()`,
      )
    ).rows[0]!;
    // INC-06: el almuerzo se cobra al precio guardado en el pedido, no al de hoy.
    const precio = precioAlmuerzoDePedido({
      snapshot: o.precio_almuerzo_centavos === null ? null : Number(o.precio_almuerzo_centavos),
      subtotal: Number(o.subtotal_centavos),
      extras,
      precioActual: Number(rest.precio),
    });
    const due = (covered: boolean) => extras + Number(o.recargo_llevar_centavos) + (hasLunch && !covered ? precio : 0);
    const lineas = await orderLines(q, [String(o.orden_id)]);
    const entrada = (plan: PlanPersona) =>
      entradaPedido({
        precioAlmuerzo: precio,
        recargoLlevar: Number(rest.recargo),
        momentoCobro: rest.momento,
        paraLlevar: o.tipo === 'LLEVAR',
        conAlmuerzo: hasLunch,
        plan,
        extras: extrasParaCobro(lineas),
      });

    // Misma llave: si ya creó la cuenta de este pedido con el mismo cuerpo es un reintento; con otro pedido u otro cuerpo, 409.
    const firma = huella({ pedido: o.public_id, cobro: normalizarCobro(cobro) });
    const previa = await cuentaPorClave(q, key, '0');
    if (previa && (String(previa.orden_id) !== String(o.orden_id) || previa.huella !== firma))
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó para otro canje o con otro cuerpo.');

    if (o.estado === 'CANJEADA' || o.estado === 'SERVIDA') {
      const c = await q.query<{ public_id: string }>(
        `SELECT k.public_id FROM consumo_almuerzo k WHERE k.restaurante_id = app_tenant_id() AND k.orden_id = $1 AND k.cantidad = 1
            AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = k.consumo_id)`,
        [o.orden_id],
      );
      const consumoId = c.rows[0]?.public_id ?? null;
      const cuentaId = await cuentaDeOrden(q, String(o.orden_id));
      const cuenta = cuentaId ? await renderCuenta(q, cuentaId) : null;
      const reconstruida = cotizarInformativa(entrada(consumoId ? { estado: 'OK', disponibles: 1 } : SIN_PLAN));
      return {
        pedido: (await this.render(q, [o]))[0]!,
        platoNombre,
        yaCanjeado: true,
        almuerzo: hasLunch ? { resultado: null, mensaje: null, descontado: consumoId !== null, consumoId } : null,
        porCobrarCentavos: cuenta ? cuenta.cotizacion.saldoPorCobrarCentavos : due(consumoId !== null),
        cotizacion: cuenta ? cuenta.cotizacion : reconstruida ? aRespuesta({ ...reconstruida, estimada: false }, rest.moneda) : null,
        cuenta,
        avisos: [],
      };
    }

    let almuerzo: PedidoCanjeResponse['almuerzo'] = null;
    let consumoInterno: string | null = null;
    const descontarAlmuerzo = async () => {
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
        eventos,
        platoNombre,
      });
      almuerzo = { resultado: r.resultado, mensaje: r.mensaje, descontado: r.descontado, consumoId: r.consumo?.id ?? null };
      if (r.consumo)
        consumoInterno = String(
          (await q.query<{ consumo_id: string }>('SELECT consumo_id FROM consumo_almuerzo WHERE public_id = $1', [r.consumo.id])).rows[0]!
            .consumo_id,
        );
      return { estado: estadoPlanDe(r.resultado), consumoId: r.descontado ? consumoInterno : null };
    };
    if (hasLunch && !o.cliente_id) almuerzo = { resultado: 'SIN_PLAN', mensaje: RESULTADOS.SIN_PLAN, descontado: false, consumoId: null };

    // Con cliente se intenta descontar la unidad (el plan real lo dice la base); sin cliente, sin plan.
    let cot: Cotizacion | null = null;
    let consumos: string[] = [];
    try {
      ({ cotizacion: cot, consumos } = await descontarYRecotizar(entrada(o.cliente_id ? { estado: 'OK', disponibles: 1 } : SIN_PLAN), () =>
        descontarAlmuerzo(),
      ));
    } catch (e) {
      if (!(e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO')) throw e;
      if (cobro) throw conflict('ALMUERZO_SIN_PRECIO', 'El almuerzo no tiene precio en este local y ningún plan lo cubrió.');
      // Sin `cobro`, como siempre: el almuerzo sin precio no impide el canje (I-12 aplica a quien cobra con cuenta).
      if (hasLunch && o.cliente_id && !almuerzo) await descontarAlmuerzo();
    }

    let cuenta: CuentaResponse | null = null;
    // Con `cobro` siempre hay cuenta (5a). Sin `cobro` (PR 6c, misma regla que el QR del 6b): si la cotización final
    // deja saldo > 0 la cuenta ABIERTA se abre igual, para que el almuerzo suelto, el recargo y los extras nunca queden
    // sin registrar; con saldo 0, sin cuenta. Sin `cobro` no hay SALDO_CAMBIO: no llega un saldo esperado que confirmar
    // (I-6 protege a quien cobra) y abrir la cuenta no cobra nada. P = 0 sin plan → `cot` null, como antes (I-12).
    if (cot && (cobro || cot.saldoPorCobrarCentavos > 0)) {
      const esperado = cobro ? (cobro.saldoEsperadoCentavos ?? Number(o.total_centavos)) : cot.saldoPorCobrarCentavos;
      if (cobro && cot.saldoPorCobrarCentavos !== esperado)
        throw saldoCambio(cot.saldoPorCobrarCentavos, {
          saldoEsperadoCentavos: esperado,
          cotizacion: aRespuesta(cot, rest.moneda),
        });
      const cuentaId = await persistirCuenta(q, {
        key,
        pagadorRef: '0',
        origen: { tipo: 'PEDIDO', ordenId: String(o.orden_id) },
        cotizacion: cot,
        consumos,
        pagador: {
          clienteId: o.cliente_id === null ? null : String(o.cliente_id),
          usuarioId: String(o.usuario_id),
          nombre: o.cliente_nombre ?? o.usuario_nombre,
        },
        momentoCobro: rest.momento,
        paraLlevar: o.tipo === 'LLEVAR',
        huella: firma,
      });
      if (cobro?.metodoPago && cot.saldoPorCobrarCentavos > 0)
        await registrarPago(
          q,
          cuentaId,
          { ...cobro, metodoPago: cobro.metodoPago, saldoEsperadoCentavos: esperado },
          clavePagoEnElPaso(key, '0'),
        );
      cuenta = await renderCuenta(q, cuentaId);
    }
    await q.query(
      `UPDATE orden_cabecera SET estado = 'CANJEADA', canjeada_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND orden_id = $1`,
      [o.orden_id],
    );
    const after = await this.load(q, id, false);
    const descontado = (almuerzo as PedidoCanjeResponse['almuerzo'])?.descontado ?? false;
    return {
      pedido: (await this.render(q, [after]))[0]!,
      platoNombre,
      yaCanjeado: false,
      almuerzo,
      // E.3: con cotización final vale su saldo (también sin cuenta: un almuerzo omitido por DUPLICADO o LIMITE_SAAS no
      // se cobra, I-10). La fórmula de antes solo queda sin cotización (P = 0 sin plan, I-12).
      porCobrarCentavos: cuenta ? cuenta.cotizacion.saldoPorCobrarCentavos : cot ? cot.saldoPorCobrarCentavos : due(descontado),
      cotizacion: cuenta ? cuenta.cotizacion : cot ? aRespuesta(cot, rest.moneda) : null,
      cuenta,
      avisos: cot?.avisos ?? [],
    };
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
      'que `POST /v1/caja/validar`). `porCobrarCentavos` es lo que se cobra aparte. Si queda saldo > 0 (almuerzo sin plan, recargo, extras), ' +
      'el canje abre la cuenta `ABIERTA` del pedido aunque no llegue `cobro` (desde el PR 6c), y se cobra con `POST /v1/caja/cuentas/{id}/cobrar`. ' +
      'Un pedido preordenado se canjea aunque el menú ya no esté publicado (no responde `MENU_NO_PUBLICADO`).',
  })
  @ApiBody({ type: CanjearPedidoDto, required: false })
  @ApiOkResponse({ type: PedidoCanjeResponse })
  @ApiProblems({
    404: ['PEDIDO_NO_ENCONTRADO'],
    409: [
      'PEDIDO_EXPIRADO',
      'PEDIDO_CANCELADO',
      'IDEMPOTENCY_KEY_REUTILIZADA',
      'SALDO_CAMBIO',
      'REFERENCIA_PAGO_REPETIDA',
      'ALMUERZO_SIN_PRECIO',
    ],
    422: ['METODO_PAGO_NO_DISPONIBLE', 'MONTO_EXCEDE_SALDO'],
  })
  redeem(@Param('id', UuidPipe) id: string, @Body() dto: CanjearPedidoDto, @IdempotencyKey() key: string) {
    return this.svc.redeem(id, key, dto);
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
