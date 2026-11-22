import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { QrSecretService } from '../auth/qr-secret.service';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems, conflict, notFound } from '../common/errors';
import { CodigoPaseResponse } from '../catalog/dto';
import { deriveKey, huella } from '../common/derive-key';
import { PERSONAL_ACTUAL } from '../common/sql';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { assertMenuPublicado } from '../diner/common';
import { PassEventBus, type PendingPassEvents } from '../pass-events/bus';
import { STEP_SECONDS, issuePassCode, parsePassCode, stepOf, verifyPassCode } from './pass-code';
import { loadSelections, seleccionDe } from '../tables/selection';
import { cotizar } from '../billing/cotizar';
import { type Aviso, CotizarError, type Cotizacion, type MomentoCobro, type PlanPersona } from '../billing/tipos';
import { type CotizacionesMesa, SIN_PLAN, aRespuesta, cotizacionDePersona, entradaMesa, entradaQr } from '../cobro/adaptador';
import {
  claveCuenta,
  clavePagoEnElPaso,
  cuentaPorClave,
  descontarYRecotizar,
  errorDePago,
  estadoPlanDe,
  normalizarCobro,
  persistirCuenta,
  registrarPago,
  renderCuenta,
  renderCuentas,
  revertirConsumoEnCuenta,
  saldoCambio,
} from '../cobro/aplicar';
import { AvisoCotizacionResponse, CotizacionResponse } from '../cobro/cotizacion.dto';
import { CobroDto, CuentaResponse, ItemCajaDto, ItemsCaja } from '../cobro/cuenta.dto';
import { resolverPlatosSueltos } from '../cobro/platos';
import { type OpcionesCotizarMesa, cargarMesaParaCobro, cotizarMesa } from '../cobro/mesa';
import { planVigenteHoySql } from '../cobro/planes';
import { ConsumoRevertidoResponse, MesaValidadaResponse, MesaVistaResponse } from './responses';

const ID = /^[1-9][0-9]{0,17}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana para deshacer una validación en caja. Después solo queda el reclamo. */
export const UNDO_SECONDS = 10;

export const RESULTADOS = {
  OK: 'Almuerzo descontado.',
  OK_ADVERTENCIA: 'Almuerzo descontado. Es el último o el plan vence pronto: ofrece renovar.',
  DUPLICADO: 'Este comensal ya fue validado hace menos de un minuto. No se descontó otra vez.',
  SIN_PLAN: 'No tiene un plan en este restaurante.',
  SIN_SALDO: 'Su plan ya no tiene almuerzos.',
  VENCIDO: 'Su plan está vencido.',
  DIA_NO_VALIDO: 'Su plan no vale hoy.',
  OTRO_LOCAL: 'Ese código es de otro restaurante.',
  QR_EXPIRADO: 'El código venció. Pídele que actualice su pase.',
  QR_INVALIDO: 'Código no válido.',
  LIMITE_SAAS: 'El restaurante alcanzó el límite de validaciones de su plan Bocadoo.',
} as const;
export type Resultado = keyof typeof RESULTADOS;

export { PERSONAL_ACTUAL };

export class ValidarDto {
  @ApiPropertyOptional({ description: 'Contenido del QR del comensal (canal QR)' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  codigoQr?: string;
  @ApiPropertyOptional({ description: 'Id del cliente elegido en la búsqueda manual (canal MANUAL)' })
  @IsOptional()
  @IsString()
  @Matches(ID, { message: 'clienteId inválido' })
  clienteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() paraLlevar?: boolean;
  @ApiPropertyOptional({ description: 'Mesa del local donde se sirve' })
  @IsOptional()
  @IsString()
  @Matches(ID, { message: 'mesaLocalId inválido' })
  mesaLocalId?: string;
  @ApiPropertyOptional({
    type: [ItemCajaDto],
    description:
      'Carta, extras y bebidas en la misma cuenta (hasta 10 platos distintos). Heredan `paraLlevar`. Con `items` o `cobro` se abre la cuenta ' +
      'del QR si hay platos o algo por cobrar.',
  })
  @IsOptional()
  @ItemsCaja()
  items?: ItemCajaDto[];
  @ApiPropertyOptional({
    type: CobroDto,
    description:
      'Opcional (como en canjear un pedido). Sin `items` ni `cobro` la validación es la de siempre (no crea cuenta). Con `metodoPago`, paga ' +
      'la cuenta en la misma transacción. Si `saldoEsperadoCentavos` no es el saldo real → 409 `SALDO_CAMBIO` sin descontar ni cobrar.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CobroDto)
  cobro?: CobroDto;
}

export class ValidarMesaDto {
  @ApiPropertyOptional({
    default: true,
    description:
      'true (por defecto desde el PR 6): se cobra la selección de cada miembro (sin selección = 1 almuerzo); solo se descuenta el almuerzo ' +
      'a quien lo pidió y se abre una cuenta ABIERTA por pagador con algo por cobrar (una sola en INVITO_YO). false: lo de antes, 1 almuerzo ' +
      'por miembro y sin cuentas (cotización solo informativa).',
  })
  @IsOptional()
  @IsBoolean()
  aplicarSeleccion?: boolean;
}

interface MesaFila {
  mesa_compartida_id: string;
  modo: string;
  estado: string;
  validada_en: Date | null;
  hora_llegada: Date;
  mesa_local_id: string | null;
  restaurante_id: string;
}

interface Miembro {
  miembro_id: string;
  nombre: string;
  es_anfitrion: boolean;
  para_llevar: boolean;
  usuario_id: string | null;
  salio: boolean;
  cliente_id: string | null;
  disponibles: number;
}

/** Resultado por miembro al validar una mesa: el del escáner o `SIN_ALMUERZO` (su selección no lleva almuerzo). */
type ResultadoMesa = Resultado | 'SIN_ALMUERZO';
interface ResultadoMiembro {
  miembro: string;
  resultado: ResultadoMesa;
  descontado: boolean;
  consumoId: string | null;
  /** Cuenta donde quedó lo de este miembro (la del anfitrión en INVITO_YO); null sin nada por cobrar. */
  cuentaId: string | null;
}
type Deducir = (miembro: Miembro, pagador: Miembro) => Promise<ResultadoDescuento>;
interface ResultadoValidarMesa {
  cotizada: CotizacionesMesa & { monedaCodigo: string };
  resultados: ResultadoMiembro[];
  descontados: number;
  porCobrar: number;
  cuentas: CuentaResponse[];
  avisos: Aviso[];
}

/** Orden de la mesa para la cotización (B.2): anfitrión primero, luego por llegada (miembro_id sigue el orden de unión). */
const ordenMesa = (ms: Miembro[]) =>
  [...ms].sort((a, b) => Number(b.es_anfitrion) - Number(a.es_anfitrion) || Number(a.miembro_id) - Number(b.miembro_id));
const miembroBase = (m: Miembro) => ({
  miembroId: String(m.miembro_id),
  esAnfitrion: m.es_anfitrion,
  paraLlevar: m.para_llevar,
  clienteId: m.cliente_id === null ? null : String(m.cliente_id),
  planLegible: true,
});

/** consumo_id interno a partir del public_id que devuelve `deduct`. */
async function consumoInterno(q: Queryable, publicId: string): Promise<string> {
  return String(
    (
      await q.query<{ consumo_id: string }>(
        'SELECT consumo_id FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND public_id = $1',
        [publicId],
      )
    ).rows[0]!.consumo_id,
  );
}

export class ValidacionResponse {
  @ApiProperty({ enum: Object.keys(RESULTADOS), example: 'OK' }) resultado!: Resultado;
  @ApiProperty({ example: RESULTADOS.OK }) mensaje!: string;
  @ApiProperty({ description: 'true solo si se descontó un almuerzo (OK u OK_ADVERTENCIA)' }) descontado!: boolean;
  @ApiPropertyOptional({ example: { id: '12', nombre: 'Ana Pérez' } }) cliente!: { id: string; nombre: string } | null;
  @ApiPropertyOptional({ example: { id: 'uuid', creadoEn: '2026-11-13T17:00:00Z', deshacerHasta: '2026-11-13T17:00:10Z' } })
  consumo!: { id: string; creadoEn: Date; deshacerHasta: Date } | null;
  @ApiPropertyOptional({ example: { nombre: 'Plan semanal', venceEl: '2026-11-20' } }) plan!: { nombre: string; venceEl: string } | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: 4 }) almuerzosRestantes!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: 6 }) diasParaVencer!: number | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Seco de pollo',
    description: 'Plato del almuerzo preordenado. Siempre null aquí: un canje directo no tiene preorden (el menú tiene varios platos)',
  })
  platoNombre!: string | null;
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización final (`estimada: false`) del almuerzo (y de `items`) con lo que de verdad pasó con el plan. Con cuenta, la de la cuenta. ' +
      'null si el código no identificó a nadie (QR inválido, vencido u otro local), si el comensal no es cliente y no se mandó `items` ni ' +
      '`cobro`, o si el almuerzo no tiene precio y ningún plan lo cubrió.',
  })
  cotizacion!: CotizacionResponse | null;
  @ApiProperty({
    type: CuentaResponse,
    nullable: true,
    description:
      'La cuenta del QR. null sin `items` ni `cobro`, si el plan cubrió todo sin platos (nada por cobrar) o con DUPLICADO / LIMITE_SAAS.',
  })
  cuenta!: CuentaResponse | null;
  @ApiProperty({ type: [AvisoCotizacionResponse], description: 'Avisos de esta validación (p. ej. DUPLICADO, LIMITE_SAAS)' })
  avisos!: { codigo: string; lineaRef: string | null }[];
}

/** Lo que responde `deduct`: el resultado del descuento, sin cliente ni cobro. */
type ResultadoDescuento = Omit<ValidacionResponse, 'cliente' | 'cotizacion' | 'cuenta' | 'avisos'>;

interface QrCheck {
  resultado: 'VALIDO' | 'QR_EXPIRADO' | 'QR_INVALIDO';
  usuarioId?: string;
  restaurantPublicId?: string | null;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly secrets: QrSecretService,
    private readonly passEvents: PassEventBus,
  ) {}

  // --- Pase del comensal -----------------------------------------------------------------------------------------

  async issueCode(user: AuthUser, restaurantPublicId?: string) {
    if (restaurantPublicId) {
      // Un pase nuevo solo se emite si el local publicó el menú de hoy (fecha local del local). Sin `restaurante` el
      // código no es de un local concreto: la regla se aplica donde se canjea (`validar`).
      await this.db.scope({ readOnly: true }, async (q) => {
        const r = await q.query<{ restaurante_id: string }>(
          `SELECT restaurante_id FROM restaurante WHERE public_id = $1 AND estado <> 'BAJA'`,
          [restaurantPublicId],
        );
        if (!r.rows[0]) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
        await assertMenuPublicado(q, r.rows[0].restaurante_id);
      });
    }
    const secret = await this.secrets.getOrCreate(user.userId);
    const now = Date.now();
    return {
      codigo: issuePassCode(secret, user.publicId, restaurantPublicId ?? null, now),
      validoSegundos: STEP_SECONDS,
      expiraEn: new Date((stepOf(now) + 1) * STEP_SECONDS * 1000),
    };
  }

  async rotateSecret(user: AuthUser) {
    await this.secrets.rotate(user.userId);
  }

  private async checkQr(code: string): Promise<QrCheck> {
    const pass = parsePassCode(code);
    if (!pass) return { resultado: 'QR_INVALIDO' };
    const u = await this.db.scope({ readOnly: true }, (q) =>
      q.query<{ usuario_id: string; activo: boolean }>('SELECT usuario_id, activo FROM usuario WHERE public_id = $1', [pass.userPublicId]),
    );
    const user = u.rows[0];
    if (!user?.activo) return { resultado: 'QR_INVALIDO' };
    const usuarioId = String(user.usuario_id);
    const secret = await this.secrets.get(usuarioId);
    if (!secret) return { resultado: 'QR_INVALIDO' };
    const v = verifyPassCode(secret, pass, Date.now());
    if (v === 'INVALIDO') return { resultado: 'QR_INVALIDO' };
    return { resultado: v === 'VALIDO' ? 'VALIDO' : 'QR_EXPIRADO', usuarioId, restaurantPublicId: pass.restaurantPublicId };
  }

  // --- Validar un almuerzo ---------------------------------------------------------------------------------------

  async validate(dto: ValidarDto, key: string): Promise<ValidacionResponse> {
    if (Boolean(dto.codigoQr) === Boolean(dto.clienteId)) throw new BadRequestException('Envía codigoQr o clienteId (uno de los dos).');
    const qr = dto.codigoQr ? await this.checkQr(dto.codigoQr) : null;
    const intento = async () => {
      const eventos = this.passEvents.pending();
      const res = await this.db.forRequest((q) => this.validateIn(q, dto, key, qr, eventos));
      return { res, eventos };
    };
    let hecho: Awaited<ReturnType<typeof intento>>;
    try {
      try {
        hecho = await intento();
      } catch (err) {
        // Dos validaciones simultáneas con la misma llave y cuenta: la segunda choca con la cuenta de la primera
        // (índices únicos) y, al repetirse, la encuentra y responde lo mismo (patrón de src/checkout/pos.ts).
        const e = err as { code?: string; constraint?: string };
        if (e?.code !== '23505' || !['uq_cuenta_clave', 'uq_cuenta_por_consumo'].includes(e.constraint ?? '')) throw err;
        hecho = await intento();
      }
    } catch (err) {
      throw errorDePago(err);
    }
    hecho.eventos.flush(); // CANJE_REGISTRADO al comensal: solo con el COMMIT hecho
    return hecho.res;
  }

  /**
   * Validar en caja (E.4). Sin `items` ni `cobro`, lo de siempre (más `cotizacion` informativa, `cuenta: null`).
   * Con alguno de los dos, además de descontar el plan, cotiza con la regla única (B.3) y abre la cuenta del QR si hay
   * platos o algo por cobrar: de origen el consumo (con plan) o el intento de escaneo (sin plan); con
   * `cobro.metodoPago`, la paga en la misma transacción. DUPLICADO y LIMITE_SAAS no cobran nada (I-10).
   */
  private async validateIn(
    q: Queryable,
    dto: ValidarDto,
    key: string,
    qr: QrCheck | null,
    eventos: PendingPassEvents,
  ): Promise<ValidacionResponse> {
    const canal = qr ? 'QR' : 'MANUAL';
    const conCuenta = dto.items !== undefined || dto.cobro !== undefined;
    // Canje directo por QR o manual (sin preorden): exige el menú de hoy publicado. Los pedidos preordenados se
    // canjean por `POST /v1/caja/pedidos/{id}/canjear`, que no depende de que el menú siga publicado.
    await assertMenuPublicado(q);
    const ctx = (
      await q.query<{ public_id: string; personal_id: string; precio: string; recargo: string; momento: MomentoCobro; moneda: string }>(
        `SELECT r.public_id, ${PERSONAL_ACTUAL} AS personal_id, r.precio_suelto_centavos AS precio, r.recargo_para_llevar_centavos AS recargo,
                r.momento_cobro AS momento, r.moneda_codigo AS moneda
           FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
      )
    ).rows[0]!;
    const sinCobro = { cotizacion: null, cuenta: null, avisos: [] };
    const registrarIntento = async (resultado: Resultado, usuarioId?: string) =>
      String(
        (
          await q.query<{ intento_id: string }>(
            `INSERT INTO intento_escaneo (restaurante_id, personal_id, usuario_id, canal, resultado) VALUES (app_tenant_id(), $1, $2, $3, $4)
             RETURNING intento_id`,
            [ctx.personal_id, usuarioId ?? null, canal, resultado],
          )
        ).rows[0]!.intento_id,
      );
    const rechazo = (resultado: Resultado): ResultadoDescuento & Pick<ValidacionResponse, 'cliente'> => ({
      resultado,
      mensaje: RESULTADOS[resultado],
      descontado: false,
      cliente: null,
      consumo: null,
      plan: null,
      almuerzosRestantes: null,
      diasParaVencer: null,
      platoNombre: null,
    });
    const fail = async (resultado: Resultado, usuarioId?: string): Promise<ValidacionResponse> => {
      await registrarIntento(resultado, usuarioId);
      return { ...rechazo(resultado), ...sinCobro };
    };

    // Quién es: cliente del local (con plan o no) o, por QR, un comensal que no es cliente (sin plan).
    let clienteId = dto.clienteId;
    let usuarioSinCliente: string | null = null;
    if (qr) {
      if (qr.resultado !== 'VALIDO') return fail(qr.resultado, qr.usuarioId);
      if (qr.restaurantPublicId && qr.restaurantPublicId !== ctx.public_id) return fail('OTRO_LOCAL', qr.usuarioId);
      const c = await q.query<{ cliente_id: string }>(
        'SELECT cliente_id FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = $1 AND activo',
        [qr.usuarioId],
      );
      if (c.rows[0]) clienteId = String(c.rows[0].cliente_id);
      else if (!conCuenta) return fail('SIN_PLAN', qr.usuarioId);
      else usuarioSinCliente = qr.usuarioId!;
    }
    const cliente = clienteId
      ? (
          await q.query<{ nombre: string; usuario_id: string | null }>(
            'SELECT nombre, usuario_id FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND activo',
            [clienteId],
          )
        ).rows[0]
      : undefined;
    if (clienteId && !cliente) throw new NotFoundException('Cliente no encontrado o inactivo.');
    if (dto.mesaLocalId) {
      const m = await q.query('SELECT 1 FROM mesa_local WHERE restaurante_id = app_tenant_id() AND mesa_local_id = $1 AND activo', [
        dto.mesaLocalId,
      ]);
      if (!m.rowCount) throw new BadRequestException('mesaLocalId no existe o está inactiva.');
    }

    // Idempotencia (F.3): la cuenta guarda la huella del cuerpo. Misma llave con otro cuerpo → 409; con el mismo, la misma respuesta.
    const items = (dto.items ?? []).map((i) => ({ plato: i.plato.toLowerCase(), cantidad: i.cantidad }));
    const firma = huella({
      validar: clienteId ? { cliente: clienteId } : { usuario: usuarioSinCliente },
      paraLlevar: dto.paraLlevar ?? false,
      mesaLocalId: dto.mesaLocalId ?? null,
      items: conCuenta ? [...items].sort((a, b) => a.plato.localeCompare(b.plato)) : null,
      cobro: normalizarCobro(dto.cobro ?? null),
    });
    const previa = await cuentaPorClave(q, key, '0');
    if (previa && (previa.huella !== firma || (previa.consumo_id === null && previa.intento_id === null)))
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó con otro cuerpo o en otra operación.');
    // La misma clave no puede servir para otro cliente (la función de base solo mira restaurante + clave).
    const prev = await q.query<{ cliente_id: string }>(
      'SELECT cliente_id FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1',
      [key],
    );
    if (prev.rows[0] && String(prev.rows[0].cliente_id) !== clienteId)
      throw new ConflictException('Esa Idempotency-Key ya se usó para otro cliente.');
    if (previa?.intento_id) {
      // Reintento de una cuenta sin consumo: la respuesta sale del intento guardado (no se vuelve a escanear).
      const i = (
        await q.query<{ resultado: Resultado }>(
          'SELECT resultado FROM intento_escaneo WHERE restaurante_id = app_tenant_id() AND intento_id = $1',
          [previa.intento_id],
        )
      ).rows[0]!;
      const cuenta = await renderCuenta(q, String(previa.cuenta_id));
      return {
        ...rechazo(i.resultado),
        cliente: clienteId ? { id: clienteId, nombre: cliente!.nombre } : null,
        cotizacion: cuenta.cotizacion,
        cuenta,
        avisos: [],
      };
    }

    const precios = { precioAlmuerzo: Number(ctx.precio), recargoLlevar: Number(ctx.recargo), momentoCobro: ctx.momento };
    const resueltos = conCuenta && !previa ? await resolverPlatosSueltos(q, items) : [];
    const entrada = (plan: PlanPersona, conItems = true) =>
      entradaQr({ ...precios, paraLlevar: dto.paraLlevar ?? false, plan, items: conItems ? resueltos : [] });
    const sinPrecio = () => conflict('ALMUERZO_SIN_PRECIO', 'El almuerzo no tiene precio en este local y ningún plan lo cubrió.');

    let base: ResultadoDescuento & Pick<ValidacionResponse, 'cliente'>;
    let cot: Cotizacion | null = null;
    let consumos: string[] = [];
    let intentoId: string | null = null;
    if (clienteId) {
      let r: ResultadoDescuento | null = null;
      const descontar = async () => {
        r = await this.deduct(q, {
          clienteId: clienteId!,
          personalId: ctx.personal_id,
          key,
          canal,
          paraLlevar: dto.paraLlevar ?? false,
          mesaLocalId: dto.mesaLocalId,
          eventos,
        });
        const consumoId = r.descontado && r.consumo ? await consumoInterno(q, r.consumo.id) : null;
        return { estado: estadoPlanDe(r.resultado), consumoId };
      };
      try {
        ({ cotizacion: cot, consumos } = await descontarYRecotizar(entrada({ estado: 'OK', disponibles: 1 }), () => descontar()));
      } catch (e) {
        if (!(e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO')) throw e;
        if (conCuenta) throw sinPrecio();
        // Sin cuenta, como siempre: el almuerzo sin precio (I-12) no impide validar; solo no hay cotización.
      }
      if (!r) await descontar();
      base = { ...r!, cliente: { id: clienteId, nombre: cliente!.nombre } };
      if (previa?.consumo_id) {
        // Reintento con cuenta: el consumo es el mismo (la función de base lo reconoce por la llave) y la cuenta también.
        const cuenta = await renderCuenta(q, String(previa.cuenta_id));
        return { ...base, cotizacion: cuenta.cotizacion, cuenta, avisos: [] };
      }
      if (!consumos.length && conCuenta)
        intentoId =
          (
            await q.query<{ intento_id: string }>(
              `SELECT intento_id FROM intento_escaneo WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND creado_en = CURRENT_TIMESTAMP
              ORDER BY intento_id DESC LIMIT 1`,
              [clienteId],
            )
          ).rows[0]?.intento_id ?? null;
    } else {
      // QR de un comensal que no es cliente del local (solo con items o cobro): el almuerzo va a caja.
      intentoId = await registrarIntento('SIN_PLAN', usuarioSinCliente!);
      base = rechazo('SIN_PLAN');
      try {
        cot = cotizar(entrada(SIN_PLAN), { estimada: false });
      } catch (e) {
        if (e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO') throw sinPrecio();
        throw e;
      }
    }

    // DUPLICADO y LIMITE_SAAS no cobran nada (I-10): ni el almuerzo (omitido) ni los platos; sin cuenta.
    if (base.resultado === 'DUPLICADO' || base.resultado === 'LIMITE_SAAS') {
      const omitida = cotizar(entrada({ estado: base.resultado, disponibles: 0 }, false), { estimada: false });
      return { ...base, cotizacion: aRespuesta(omitida, ctx.moneda), cuenta: null, avisos: omitida.avisos };
    }
    if (!conCuenta || !cot)
      return { ...base, cotizacion: cot ? aRespuesta(cot, ctx.moneda) : null, cuenta: null, avisos: cot?.avisos ?? [] };

    const saldo = cot.saldoPorCobrarCentavos;
    if (dto.cobro?.saldoEsperadoCentavos !== undefined && dto.cobro.saldoEsperadoCentavos !== saldo)
      throw saldoCambio(saldo, { saldoEsperadoCentavos: dto.cobro.saldoEsperadoCentavos, cotizacion: aRespuesta(cot, ctx.moneda) });
    // Sin platos y sin nada por cobrar no hay cuenta (G-17): el plan cubrió todo.
    if (!resueltos.length && saldo === 0) return { ...base, cotizacion: aRespuesta(cot, ctx.moneda), cuenta: null, avisos: cot.avisos };
    // La llave ya descontó este almuerzo en una validación sin cuenta: crear la cuenta ahora sería otro cuerpo.
    if (prev.rows[0])
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó para validar sin cuenta: usa una llave nueva.');

    const nombreSinCliente = usuarioSinCliente
      ? (await q.query<{ nombre: string }>('SELECT nombre FROM usuario WHERE usuario_id = $1', [usuarioSinCliente])).rows[0]!.nombre
      : null;
    const cuentaId = await persistirCuenta(q, {
      key,
      pagadorRef: '0',
      origen: consumos[0] ? { tipo: 'CONSUMO', consumoId: consumos[0] } : { tipo: 'INTENTO', intentoId: intentoId! },
      cotizacion: cot,
      consumos,
      pagador: clienteId
        ? { clienteId, usuarioId: cliente!.usuario_id === null ? null : String(cliente!.usuario_id), nombre: cliente!.nombre }
        : { clienteId: null, usuarioId: usuarioSinCliente, nombre: nombreSinCliente! },
      momentoCobro: ctx.momento,
      paraLlevar: dto.paraLlevar ?? false,
      huella: firma,
    });
    if (dto.cobro?.metodoPago && saldo > 0)
      await registrarPago(
        q,
        cuentaId,
        { ...dto.cobro, metodoPago: dto.cobro.metodoPago, saldoEsperadoCentavos: saldo },
        clavePagoEnElPaso(key, '0'),
      );
    const cuenta = await renderCuenta(q, cuentaId);
    return { ...base, cotizacion: cuenta.cotizacion, cuenta, avisos: cot.avisos };
  }

  /** Llama a la función atómica de la base (FIFO, duplicado, idempotencia, límite SaaS) y arma la respuesta. */
  async deduct(
    q: Queryable,
    a: {
      clienteId: string;
      personalId: string;
      key: string;
      canal: string;
      paraLlevar: boolean;
      ordenId?: string;
      mesaLocalId?: string;
      mesaCompartidaId?: string;
      omitirDuplicado?: boolean;
      /** Dónde juntar el CANJE_REGISTRADO para el comensal; quien llama hace `flush()` tras el COMMIT. */
      eventos?: PendingPassEvents;
      /** Platos de la preorden, para el evento. */
      platoNombre?: string | null;
    },
  ): Promise<ResultadoDescuento> {
    const f = (
      await q.query<{
        resultado: Resultado;
        consumo_id: string | null;
        almuerzos_restantes_total: number;
        dias_para_vencer: number | null;
      }>('SELECT * FROM fn_descontar_almuerzo(app_tenant_id(), $1, $2, $3, $4::canal_consumo_enum, $5, $9, $6, $7, $8)', [
        a.clienteId,
        a.personalId,
        a.key,
        a.canal,
        a.paraLlevar,
        a.mesaCompartidaId ?? null,
        a.mesaLocalId ?? null,
        a.omitirDuplicado ?? false,
        a.ordenId ?? null,
      ])
    ).rows[0]!;
    const descontado = f.resultado === 'OK' || f.resultado === 'OK_ADVERTENCIA';
    let consumo: ValidacionResponse['consumo'] = null;
    let plan: ValidacionResponse['plan'] = null;
    if (descontado && f.consumo_id) {
      // `nuevo`: el consumo se insertó en esta transacción (creado_en por defecto = CURRENT_TIMESTAMP, el inicio de la
      // transacción). Un reintento con la misma Idempotency-Key devuelve un consumo viejo y no vuelve a avisar.
      const c = (
        await q.query<{
          public_id: string;
          creado_en: Date;
          nombre_plan: string;
          vence_el: string;
          nuevo: boolean;
          usuario_id: string | null;
          restaurante_nombre: string;
        }>(
          `SELECT c.public_id, c.creado_en, s.nombre_plan, s.vence_el::text AS vence_el, c.creado_en = CURRENT_TIMESTAMP AS nuevo,
                  cr.usuario_id, r.nombre AS restaurante_nombre
             FROM consumo_almuerzo c
             JOIN suscripcion_plan s ON s.suscripcion_id = c.suscripcion_id
             JOIN cliente_restaurante cr ON cr.restaurante_id = c.restaurante_id AND cr.cliente_id = c.cliente_id
             JOIN restaurante r ON r.restaurante_id = c.restaurante_id
            WHERE c.restaurante_id = app_tenant_id() AND c.consumo_id = $1`,
          [f.consumo_id],
        )
      ).rows[0]!;
      consumo = { id: c.public_id, creadoEn: c.creado_en, deshacerHasta: new Date(c.creado_en.getTime() + UNDO_SECONDS * 1000) };
      plan = { nombre: c.nombre_plan, venceEl: c.vence_el };
      if (c.nuevo)
        a.eventos?.add(c.usuario_id === null ? null : String(c.usuario_id), {
          tipo: 'CANJE_REGISTRADO',
          consumoId: c.public_id,
          restauranteNombre: c.restaurante_nombre,
          saldoRestante: f.almuerzos_restantes_total,
          platoNombre: a.platoNombre ?? null,
          hora: c.creado_en.toISOString(),
        });
    }
    return {
      resultado: f.resultado,
      mensaje: RESULTADOS[f.resultado],
      descontado,
      consumo,
      plan,
      almuerzosRestantes: f.almuerzos_restantes_total,
      diasParaVencer: f.dias_para_vencer,
      platoNombre: null,
    };
  }

  // --- Deshacer (10 segundos) ------------------------------------------------------------------------------------

  async undo(consumoPublicId: string) {
    const eventos = this.passEvents.pending();
    try {
      const res = await this.db.forRequest(async (q) => {
        const c = (
          await q.query<{ consumo_id: string; cantidad: number; viejo: boolean; revertido: boolean }>(
            `SELECT c.consumo_id, c.cantidad, c.creado_en < CURRENT_TIMESTAMP - make_interval(secs => $2) AS viejo,
                  EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id) AS revertido
             FROM consumo_almuerzo c WHERE c.restaurante_id = app_tenant_id() AND c.public_id = $1`,
            [consumoPublicId, UNDO_SECONDS],
          )
        ).rows[0];
        if (!c || c.cantidad !== 1) throw new NotFoundException('Validación no encontrada.');
        if (c.revertido) return { id: consumoPublicId, revertido: true };
        if (c.viejo)
          throw new ConflictException(
            `Solo se puede deshacer en los ${UNDO_SECONDS} segundos siguientes. Si hubo un error, regístralo como reclamo.`,
          );
        // Si el almuerzo es parte de una cuenta: cobrada → 409 CUENTA_COBRADA; abierta → línea inversa (y anulada si queda en 0).
        await revertirConsumoEnCuenta(q, String(c.consumo_id));
        await q.query(`SELECT fn_revertir_consumo(app_tenant_id(), $1, ${PERSONAL_ACTUAL}, 'Deshacer en caja')`, [c.consumo_id]);
        const ev = (
          await q.query<{ usuario_id: string | null; restaurante_nombre: string; saldo: number; hora: Date }>(
            `SELECT cr.usuario_id, r.nombre AS restaurante_nombre, CURRENT_TIMESTAMP AS hora,
                    (SELECT COALESCE(sum(s.almuerzos_restantes), 0)::int FROM suscripcion_plan s
                      WHERE s.restaurante_id = c.restaurante_id AND s.cliente_id = c.cliente_id AND s.estado = 'ACTIVA'
                        AND s.vence_el >= (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date) AS saldo
               FROM consumo_almuerzo c
               JOIN cliente_restaurante cr ON cr.restaurante_id = c.restaurante_id AND cr.cliente_id = c.cliente_id
               JOIN restaurante r ON r.restaurante_id = c.restaurante_id
              WHERE c.restaurante_id = app_tenant_id() AND c.consumo_id = $1`,
            [c.consumo_id],
          )
        ).rows[0]!;
        eventos.add(ev.usuario_id === null ? null : String(ev.usuario_id), {
          tipo: 'CANJE_REVERTIDO',
          consumoId: consumoPublicId,
          restauranteNombre: ev.restaurante_nombre,
          saldoRestante: ev.saldo,
          hora: ev.hora.toISOString(),
        });
        return { id: consumoPublicId, revertido: true };
      });
      eventos.flush(); // CANJE_REVERTIDO al comensal: solo con el COMMIT hecho
      return res;
    } catch (err) {
      // Dos "deshacer" a la vez: el índice único deja pasar solo uno; el otro ya está deshecho.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_consumo_un_solo_reverso') return { id: consumoPublicId, revertido: true };
      throw err;
    }
  }

  // --- Mesa compartida -------------------------------------------------------------------------------------------

  previewTable(mesaPublicId: string) {
    return this.db.forRequest(async (q) => this.tableView(q, await this.loadTable(q, mesaPublicId, false)), { readOnly: true });
  }

  /**
   * Valida toda la mesa de una vez (E.5). Bloquea la mesa (dos validaciones a la vez, o validar y `salir`, se
   * serializan) y a cada miembro que sigue en ella (mismo candado que su selección). Los que salieron se ignoran (D).
   * - `aplicarSeleccion` (por defecto): cotiza la selección de cada miembro con la regla única (B.3; sin selección = 1
   *   almuerzo, I-4), descuenta solo los almuerzos que la cotización marcó PLAN (CADA_UNO: el plan de cada miembro;
   *   INVITO_YO: el del anfitrión, en orden) y abre una cuenta ABIERTA por pagador con algo por cobrar (origen mesa +
   *   miembro pagador). Un pagador sin nada por cobrar no tiene cuenta. Las cuentas se cobran con
   *   `POST /v1/caja/cuentas/{id}/cobrar` (B.5).
   * - `aplicarSeleccion: false`: lo de antes (1 almuerzo por miembro, sin cuentas) con la cotización informativa.
   * Repetir sobre una mesa validada no descuenta otra vez: `yaValidada` con las cuentas que ya tiene. La misma llave con
   * otro cuerpo → 409 `IDEMPOTENCY_KEY_REUTILIZADA`.
   */
  async validateTable(mesaPublicId: string, key: string, dto: ValidarMesaDto = {}) {
    const aplicarSeleccion = dto.aplicarSeleccion ?? true;
    const firma = huella({ mesa: mesaPublicId.toLowerCase(), aplicarSeleccion });
    const eventos = this.passEvents.pending();
    const res = await this.db.forRequest(async (q) => {
      const mesa = await this.loadTable(q, mesaPublicId, true);
      if (mesa.validada_en) return this.tableAlreadyValidated(q, mesa, key, firma, aplicarSeleccion);
      if (!['ABIERTA', 'EN_CAMINO'].includes(mesa.estado)) throw new ConflictException(`La mesa está ${mesa.estado.toLowerCase()}.`);
      const personalId = (await q.query<{ p: string }>(`SELECT ${PERSONAL_ACTUAL} AS p`)).rows[0]!.p;
      const activos = ordenMesa((await this.members(q, mesa.mesa_compartida_id)).filter((m) => !m.salio));
      // Mismo candado que PUT …/seleccion y fn_salir_mesa: la selección que se cobra es la que queda, sin cambios a medias.
      for (const m of [...activos].sort((a, b) => Number(a.miembro_id) - Number(b.miembro_id)))
        await q.query('SELECT pg_advisory_xact_lock($1::bigint)', [m.miembro_id]);
      const deducir = (m: Miembro, pagador: Miembro) =>
        this.deduct(q, {
          clienteId: String(pagador.cliente_id),
          personalId,
          key: deriveKey(key, String(m.miembro_id)),
          canal: 'MESA',
          paraLlevar: m.para_llevar,
          mesaCompartidaId: String(mesa.mesa_compartida_id),
          mesaLocalId: mesa.mesa_local_id ? String(mesa.mesa_local_id) : undefined,
          omitirDuplicado: mesa.modo === 'INVITO_YO',
          eventos,
        });
      const out = aplicarSeleccion
        ? await this.chargeSelection(q, mesa, activos, key, firma, deducir)
        : await this.legacyValidate(q, mesa, activos, deducir);
      await q.query(
        `UPDATE mesa_compartida SET validada_en = CURRENT_TIMESTAMP, validada_por_personal_id = $2, estado = 'EN_MESA' WHERE mesa_compartida_id = $1`,
        [mesa.mesa_compartida_id, personalId],
      );
      const view = await this.tableView(q, { ...mesa, estado: 'EN_MESA', validada_en: new Date() }, out.cotizada);
      return {
        ...view,
        yaValidada: false,
        resultados: out.resultados,
        descontados: out.descontados,
        porCobrar: out.porCobrar,
        cuentas: out.cuentas,
        avisos: out.avisos,
      };
    });
    eventos.flush(); // un CANJE_REGISTRADO por almuerzo descontado, a quien pagó; solo con el COMMIT hecho
    return res;
  }

  /** Reintento sobre una mesa ya validada (E.5): nada se descuenta; las cuentas que tiene y la cotización reconstruida. */
  private async tableAlreadyValidated(q: Queryable, mesa: MesaFila, key: string, firma: string, aplicarSeleccion: boolean) {
    const cuentas = (
      await q.query<{ cuenta_id: string; miembro_id: string; clave_idempotencia: string; huella: string }>(
        `SELECT cuenta_id, miembro_id, clave_idempotencia, huella FROM cuenta_cobro
          WHERE restaurante_id = app_tenant_id() AND mesa_compartida_id = $1 ORDER BY cuenta_id`,
        [mesa.mesa_compartida_id],
      )
    ).rows;
    if (cuentas.some((c) => c.clave_idempotencia === claveCuenta(key, String(c.miembro_id)) && c.huella !== firma))
      throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya validó esta mesa con otro cuerpo.');
    // Sin las cuentas de saldo 0 (no existen) no se puede rehacer todo desde las líneas: se recotiza con el plan de antes
    // de validar (el de hoy más lo descontado en esta mesa) y la misma base que pide esta petición.
    const informativa = await this.quote(q, mesa, aplicarSeleccion ? 'seleccion' : 'un-almuerzo', true);
    return {
      ...(await this.tableView(q, mesa, informativa)),
      yaValidada: true,
      resultados: [],
      cuentas: await renderCuentas(
        q,
        cuentas.map((c) => String(c.cuenta_id)),
      ),
      avisos: [],
    };
  }

  /** `aplicarSeleccion: false`: 1 almuerzo por miembro que sigue en la mesa, como antes del PR 6. Sin cuentas. */
  private async legacyValidate(q: Queryable, mesa: MesaFila, activos: Miembro[], deducir: Deducir): Promise<ResultadoValidarMesa> {
    // Cotización informativa (E.5): cada miembro con 1 almuerzo y su paraLlevar, con el plan de antes de descontar.
    const cotizada = await this.quote(q, mesa, 'un-almuerzo', false);
    const host = activos.find((m) => m.es_anfitrion);
    const resultados: ResultadoMiembro[] = [];
    for (const m of activos) {
      const pagador = mesa.modo === 'INVITO_YO' ? host : m;
      if (!pagador?.cliente_id) {
        resultados.push({ miembro: m.nombre, resultado: 'SIN_PLAN', descontado: false, consumoId: null, cuentaId: null });
        continue;
      }
      const r = await deducir(m, pagador);
      resultados.push({
        miembro: m.nombre,
        resultado: r.resultado,
        descontado: r.descontado,
        consumoId: r.consumo?.id ?? null,
        cuentaId: null,
      });
    }
    return {
      cotizada,
      resultados,
      descontados: resultados.filter((r) => r.descontado).length,
      porCobrar: resultados.filter((r) => !r.descontado).length,
      cuentas: [],
      avisos: cotizada.mesa?.avisos ?? [],
    };
  }

  /**
   * La selección pasa a cobro (E.5 con `aplicarSeleccion`, B.3, F.1, F.3): una cotización para toda la mesa, el
   * descuento de cada unidad PLAN en orden (clave derivada por miembro) y una cuenta por pagador con saldo.
   */
  private async chargeSelection(
    q: Queryable,
    mesa: MesaFila,
    activos: Miembro[],
    key: string,
    firma: string,
    deducir: Deducir,
  ): Promise<ResultadoValidarMesa> {
    const { mesa: paraCobro, monedaCodigo } = await cargarMesaParaCobro(q, {
      mesaId: mesa.mesa_compartida_id,
      restauranteId: String(mesa.restaurante_id),
      modo: mesa.modo === 'INVITO_YO' ? 'INVITO_YO' : 'CADA_UNO',
      base: 'seleccion',
      miembros: activos.map(miembroBase),
    });
    const porRef = new Map(activos.map((m) => [String(m.miembro_id), m]));
    const descontados = new Map<string, ResultadoDescuento>(); // personaRef → lo que respondió la base
    const fallas = new Map<string, Resultado>(); // pagadorRef → primer resultado que no descontó
    const consumos = new Map<string, string[]>(); // pagadorRef → consumos internos, en el orden de sus líneas PLAN
    let cot: Cotizacion;
    try {
      ({ cotizacion: cot } = await descontarYRecotizar(entradaMesa(paraCobro), async (u) => {
        const pagador = porRef.get(u.pagadorRef)!;
        if (!pagador.cliente_id) return { estado: 'SIN_PLAN', consumoId: null };
        const r = await deducir(porRef.get(u.personaRef)!, pagador);
        descontados.set(u.personaRef, r);
        if (!r.descontado || !r.consumo) {
          fallas.set(u.pagadorRef, r.resultado);
          return { estado: estadoPlanDe(r.resultado), consumoId: null };
        }
        const consumoId = await consumoInterno(q, r.consumo.id);
        consumos.set(u.pagadorRef, [...(consumos.get(u.pagadorRef) ?? []), consumoId]);
        return { estado: 'OK', consumoId };
      }));
    } catch (e) {
      if (e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO')
        throw conflict('ALMUERZO_SIN_PRECIO', 'El almuerzo no tiene precio en este local y algún plan no lo cubre.');
      throw e;
    }

    // Una cuenta por pagador con algo por cobrar (los de saldo 0 no la tienen: el plan cubrió todo o todo se omitió).
    const cuentaDe = new Map<string, string>(); // pagadorRef → cuenta interna
    for (const t of cot.porPagador) {
      if (t.saldo <= 0) continue;
      const p = porRef.get(t.pagadorRef)!;
      cuentaDe.set(
        t.pagadorRef,
        await persistirCuenta(q, {
          key,
          pagadorRef: t.pagadorRef,
          origen: { tipo: 'MESA', mesaCompartidaId: String(mesa.mesa_compartida_id), miembroId: t.pagadorRef },
          cotizacion: cot,
          consumos: consumos.get(t.pagadorRef) ?? [],
          pagador: {
            clienteId: p.cliente_id === null ? null : String(p.cliente_id),
            usuarioId: p.usuario_id === null ? null : String(p.usuario_id),
            nombre: p.nombre,
            esAnfitrion: p.es_anfitrion,
          },
          momentoCobro: paraCobro.momentoCobro,
          paraLlevar: p.para_llevar,
          huella: firma,
        }),
      );
    }
    const ids = [...cuentaDe.values()];
    const cuentas = await renderCuentas(q, ids);
    const publicaDe = new Map(ids.map((id, i) => [id, cuentas[i]!.id]));

    const host = activos.find((m) => m.es_anfitrion)!;
    const planInicial = new Map(paraCobro.miembros.map((m) => [m.ref, m.plan]));
    const resultados: ResultadoMiembro[] = activos.map((m) => {
      const ref = String(m.miembro_id);
      const pagadorRef = mesa.modo === 'INVITO_YO' ? String(host.miembro_id) : ref;
      const cuenta = cuentaDe.get(pagadorRef);
      const cuentaId = cuenta ? publicaDe.get(cuenta)! : null;
      const r = descontados.get(ref);
      if (r) return { miembro: m.nombre, resultado: r.resultado, descontado: r.descontado, consumoId: r.consumo?.id ?? null, cuentaId };
      const conAlmuerzo = cot.lineas.some((l) => l.personaRef === ref && l.tipo === 'ALMUERZO');
      // Sin descuento intentado: no pidió almuerzo, o el plan de su pagador no lo cubría (o se acabó antes).
      const estado = planInicial.get(pagadorRef)?.estado;
      const resultado: ResultadoMesa = !conAlmuerzo
        ? 'SIN_ALMUERZO'
        : (fallas.get(pagadorRef) ?? (estado && estado !== 'OK' ? estado : 'SIN_SALDO'));
      return { miembro: m.nombre, resultado, descontado: false, consumoId: null, cuentaId };
    });
    const almuerzos = cot.lineas.filter((l) => l.tipo === 'ALMUERZO');
    const porMiembro = new Map(activos.map((m) => [String(m.miembro_id), cotizacionDePersona(cot, String(m.miembro_id))]));
    return {
      cotizada: { porMiembro, mesa: cot, monedaCodigo },
      resultados,
      descontados: almuerzos.filter((l) => l.fuente === 'PLAN').length,
      // Almuerzos que se cobran aparte (en una cuenta); los omitidos (DUPLICADO, LIMITE_SAAS) no se cobran (I-10).
      porCobrar: almuerzos.filter((l) => l.fuente === 'CAJA' && l.omitida === null).reduce((s, l) => s + l.cantidad, 0),
      cuentas,
      avisos: cot.avisos,
    };
  }

  private async loadTable(q: Queryable, publicId: string, lock: boolean): Promise<MesaFila> {
    const r = await q.query<MesaFila>(
      `SELECT mesa_compartida_id, modo, estado, validada_en, hora_llegada, mesa_local_id, restaurante_id FROM mesa_compartida
        WHERE restaurante_id = app_tenant_id() AND public_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [publicId],
    );
    if (!r.rows[0]) throw new NotFoundException('Mesa no encontrada.');
    return r.rows[0];
  }

  private async members(q: Queryable, mesaId: string): Promise<Miembro[]> {
    const r = await q.query<Miembro>(
      // `disponibles` cuenta solo los planes que valen hoy (ACTIVA, vigente y hoy en dias_validos: INC-12).
      `SELECT m.miembro_id, m.nombre, m.es_anfitrion, m.para_llevar, m.usuario_id, m.salio_en IS NOT NULL AS salio, c.cliente_id,
              COALESCE((SELECT sum(s.almuerzos_restantes) FROM suscripcion_plan s
                         WHERE s.restaurante_id = m.restaurante_id AND s.cliente_id = c.cliente_id
                           AND ${planVigenteHoySql('s', '(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())')}), 0)::int AS disponibles
         FROM mesa_compartida_miembro m
         LEFT JOIN cliente_restaurante c ON c.restaurante_id = m.restaurante_id AND c.usuario_id = m.usuario_id AND c.activo
        WHERE m.mesa_compartida_id = $1 AND m.restaurante_id = app_tenant_id() ORDER BY m.miembro_id`,
      [mesaId],
    );
    return r.rows;
  }

  /** Cotización informativa de la mesa para el personal: ve el plan y la selección de todos. Sin los que salieron. */
  private quote(
    q: Queryable,
    mesa: { mesa_compartida_id: string; modo: string; restaurante_id: string },
    base: OpcionesCotizarMesa['base'],
    reponerConsumos: boolean,
  ) {
    return this.members(q, mesa.mesa_compartida_id).then((members) =>
      cotizarMesa(q, {
        mesaId: mesa.mesa_compartida_id,
        restauranteId: String(mesa.restaurante_id),
        modo: mesa.modo === 'INVITO_YO' ? 'INVITO_YO' : 'CADA_UNO',
        base,
        reponerConsumos,
        miembros: ordenMesa(members.filter((m) => !m.salio)).map(miembroBase),
      }),
    );
  }

  private async tableView(
    q: Queryable,
    mesa: {
      mesa_compartida_id: string;
      modo: string;
      estado: string;
      validada_en: Date | null;
      hora_llegada: Date;
      restaurante_id: string;
    },
    cotizada?: Awaited<ReturnType<CheckoutService['quote']>>,
  ) {
    const members = await this.members(q, mesa.mesa_compartida_id);
    const cot = cotizada ?? (await this.quote(q, mesa, 'seleccion', mesa.validada_en !== null));
    const aResp = (c: Parameters<typeof aRespuesta>[0] | null | undefined) => (c ? aRespuesta(c, cot.monedaCodigo) : null);
    const host = members.find((m) => m.es_anfitrion);
    const activos = members.filter((m) => !m.salio);
    const selecciones = await loadSelections(q, mesa.mesa_compartida_id);
    return {
      modo: mesa.modo,
      estado: mesa.estado,
      horaLlegada: mesa.hora_llegada,
      validadaEn: mesa.validada_en,
      // Solo los que siguen en la mesa: quien salió no ocupa lugar ni se cobra (D, E.7).
      personas: activos.length,
      // Cuántos almuerzos cubren los planes (según el modo) y cuántos habría que cobrar aparte.
      cubiertos:
        mesa.modo === 'INVITO_YO' ? Math.min(activos.length, host?.disponibles ?? 0) : activos.filter((m) => m.disponibles > 0).length,
      miembros: members.map((m) => ({
        nombre: m.nombre,
        esAnfitrion: m.es_anfitrion,
        paraLlevar: m.para_llevar,
        salio: m.salio,
        tieneCuenta: m.cliente_id !== null,
        almuerzosDisponibles: m.disponibles,
        seleccion: seleccionDe(selecciones, m.miembro_id),
        cotizacion: m.salio ? null : aResp(cot.porMiembro.get(String(m.miembro_id))),
      })),
      cotizacion: aResp(cot.mesa),
    };
  }
}

class CodigoQuery {
  @ApiPropertyOptional({ description: 'public_id del restaurante: el código solo vale en ese local' })
  @IsOptional()
  @Matches(UUID, { message: 'restaurante debe ser un UUID' })
  restaurante?: string;
}

@ApiTags('pase')
@ApiBearerAuth()
@Controller('v1/pase')
export class PassController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('codigo')
  @ApiOperation({
    summary: 'Código QR del comensal (cambia cada 30 segundos)',
    description:
      'La app lo pide de nuevo cuando vence. Con `restaurante` el código solo vale en ese local y el local debe haber publicado el menú de hoy (409 `MENU_NO_PUBLICADO`).',
  })
  @ApiOkResponse({ type: CodigoPaseResponse })
  @ApiProblems({ 404: ['RESTAURANTE_NO_ENCONTRADO'], 409: ['MENU_NO_PUBLICADO'] })
  code(@CurrentUser() user: AuthUser, @Query() q: CodigoQuery) {
    return this.checkout.issueCode(user, q.restaurante?.toLowerCase());
  }

  @Post('rotar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Invalidar todos mis códigos anteriores',
    description: 'Para un teléfono perdido o una captura de pantalla compartida.',
  })
  async rotate(@CurrentUser() user: AuthUser) {
    await this.checkout.rotateSecret(user);
  }
}

@ApiTags('caja')
@Controller('v1/caja')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Roles('DUENO', 'CAJERO')
  @Post('validar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Validar un almuerzo por QR o por búsqueda manual',
    description:
      'Siempre responde 200 con un `resultado`, salvo 409 `MENU_NO_PUBLICADO` si el local no publicó el menú de hoy (fecha local del local). Descuenta del plan que vence primero (FIFO). Resultados: ' +
      Object.entries(RESULTADOS)
        .map(([k, v]) => `**${k}**: ${v}`)
        .join(' · ') +
      '. Con `items` (platos de caja) o `cobro` (aunque sea `{}`) crea además la cuenta de cobro: con plan, la del consumo; sin él, la del ' +
      'intento de escaneo (el almuerzo va a caja a P). Sin nada por cobrar ni platos, no hay cuenta. `DUPLICADO` y `LIMITE_SAAS` no cobran nada. ' +
      'Con `cobro.metodoPago` registra el pago en el mismo paso. Sin `items` ni `cobro`, la validación de siempre más la cotización informativa.',
  })
  @ApiOkResponse({ type: ValidacionResponse })
  @ApiProblems({
    409: [
      'MENU_NO_PUBLICADO',
      'SALDO_CAMBIO',
      'ALMUERZO_SIN_PRECIO',
      'PLATO_AGOTADO',
      'REFERENCIA_PAGO_REPETIDA',
      'IDEMPOTENCY_KEY_REUTILIZADA',
    ],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO', 'METODO_PAGO_NO_DISPONIBLE', 'MONTO_EXCEDE_SALDO'],
  })
  validate(@Body() dto: ValidarDto, @IdempotencyKey() key: string) {
    return this.checkout.validate(dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('consumos/:id/deshacer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deshacer una validación',
    description:
      `Solo en los ${UNDO_SECONDS} segundos siguientes; después → 409. Devuelve el almuerzo al plan. ` +
      'Si el almuerzo es parte de una cuenta de cobro: con la cuenta ABIERTA y sin pagos se agrega la línea inversa (con su recargo) y, si la ' +
      'cuenta queda sin nada por cobrar, pasa a ANULADA; con la cuenta COBRADA o con algún pago → 409 `CUENTA_COBRADA` (primero se anula la cuenta).',
  })
  @ApiOkResponse({ type: ConsumoRevertidoResponse })
  @ApiProblems({ 409: ['CUENTA_COBRADA'] })
  undo(@Param('id', UuidPipe) id: string) {
    return this.checkout.undo(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Get('mesas/:id')
  @ApiOperation({
    summary: 'Vista previa de una mesa compartida',
    description: 'Quiénes vienen, quién paga y cuántos almuerzos cubren los planes.',
  })
  @ApiOkResponse({ type: MesaVistaResponse })
  previewTable(@Param('id', UuidPipe) id: string) {
    return this.checkout.previewTable(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('mesas/:id/validar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Validar toda la mesa de una vez (la selección de cada miembro se cobra)',
    description:
      'Por defecto (`aplicarSeleccion: true`) se cobra lo que eligió cada miembro con la regla única de cobro: sin selección cuenta 1 almuerzo; ' +
      'el plan solo cubre almuerzos (CADA_UNO: el de cada miembro; INVITO_YO: el del anfitrión, en orden de llegada, y lo que no alcanza va a ' +
      'precio suelto con aviso PLAN_NO_ALCANZA). Se abre una cuenta ABIERTA por pagador con algo por cobrar (`cuentas`; una sola en INVITO_YO), ' +
      'que se cobra con `POST /v1/caja/cuentas/{id}/cobrar`. Los miembros que salieron no se cobran. `aplicarSeleccion: false`: 1 almuerzo por ' +
      'miembro como antes, sin cuentas. Repetir sobre una mesa validada no descuenta: `yaValidada: true` con sus `cuentas`.',
  })
  @ApiBody({ type: ValidarMesaDto, required: false })
  @ApiOkResponse({ type: MesaValidadaResponse })
  @ApiProblems({ 409: ['IDEMPOTENCY_KEY_REUTILIZADA', 'ALMUERZO_SIN_PRECIO'] })
  validateTable(@Param('id', UuidPipe) id: string, @Body() dto: ValidarMesaDto, @IdempotencyKey() key: string) {
    return this.checkout.validateTable(id, key, dto ?? {});
  }
}
