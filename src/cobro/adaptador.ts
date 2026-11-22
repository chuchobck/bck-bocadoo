// Adaptador entre los datos de los endpoints (pedido, mesa, plan del comensal) y la cotización pura de src/billing
// (docs/spec-cobros.md, B.2). Es puro (sin base de datos ni Nest); la lectura de planes está en ./planes.ts.
// src/billing no puede importar infraestructura, por eso el adaptador vive aquí.

import { cotizar } from '../billing/cotizar';
import {
  CotizarError,
  type Cotizacion,
  type EntradaCobro,
  type ItemCobro,
  type LineaCotizada,
  type MomentoCobro,
  type PersonaCobro,
  type PlanPersona,
  type TipoItem,
  type TotalPagador,
} from '../billing/tipos';

export type CategoriaPlato = 'ALMUERZO' | 'A_LA_CARTA' | 'EXTRA' | 'BEBIDA';

/** Lo que se sabe de los planes de un cliente en un local, para el día de hoy del local. */
export interface PlanFilas {
  /** Σ almuerzos_restantes de los planes que valen hoy (misma condición que fn_descontar_almuerzo). */
  disponibles: number;
  /** Hay un plan ACTIVA con vence_el >= hoy (aunque hoy no sea uno de sus días). */
  hayActivaVigente: boolean;
  /** Hay un plan ACTIVA/VENCIDA con saldo y vence_el < hoy. */
  hayVencidaConSaldo: boolean;
  /** El cliente tiene algún plan en el local. */
  hayPlan: boolean;
}

export const SIN_PLAN: PlanPersona = { estado: 'SIN_PLAN', disponibles: 0 };

/** Mismo orden de decisión que fn_descontar_almuerzo (db/migrations/20261116000000_descontar_almuerzo_mesa.sql:82-100). */
export function planDesdeFilas(f: PlanFilas | null | undefined): PlanPersona {
  if (!f) return SIN_PLAN;
  if (f.disponibles > 0) return { estado: 'OK', disponibles: f.disponibles };
  if (f.hayActivaVigente) return { estado: 'DIA_NO_VALIDO', disponibles: 0 };
  if (f.hayVencidaConSaldo) return { estado: 'VENCIDO', disponibles: 0 };
  return { estado: f.hayPlan ? 'SIN_SALDO' : 'SIN_PLAN', disponibles: 0 };
}

/**
 * B.3 paso 1: tipo de un plato pedido suelto. Un plato de categoría ALMUERZO se mapea por su sección (así lo que hoy no
 * paga recargo sigue sin pagarlo, I-1): JUGO → BEBIDA, POSTRE → EXTRA, SOPA y FUERTE → A_LA_CARTA. Sin sección
 * ADICIONAL → EXTRA. Sin sección no se sabe qué es y se trata como A_LA_CARTA.
 */
export const tipoDePlato = (c: CategoriaPlato, seccion?: string | null): TipoItem => {
  if (c !== 'ALMUERZO') return c;
  return seccion === 'JUGO' ? 'BEBIDA' : seccion === 'POSTRE' || seccion === 'ADICIONAL' ? 'EXTRA' : 'A_LA_CARTA';
};

export interface PlatoSuelto {
  /** public_id del plato. */
  platoId: string;
  nombre: string;
  categoria: CategoriaPlato;
  /** Sección habitual del plato (plato.seccion); solo importa si la categoría es ALMUERZO. */
  seccion?: string | null;
  cantidad: number;
  /** Precio unitario ya resuelto (precio del menú de hoy o, si no, el del plato). */
  precioUnitario: number;
  /** false = agotado hoy (solo cuenta en MESA: la línea queda omitida). */
  disponible?: boolean;
}

export interface Precios {
  /** P: lo que vale el almuerzo cuando lo paga la caja. */
  precioAlmuerzo: number;
  /** R: recargo para llevar por unidad. */
  recargoLlevar: number;
  momentoCobro: MomentoCobro;
}

const lineaPlato = (personaRef: string, ref: string, e: PlatoSuelto, flujoMesa: boolean): ItemCobro => ({
  ref,
  personaRef,
  tipo: tipoDePlato(e.categoria, e.seccion),
  cantidad: e.cantidad,
  precioUnitario: e.precioUnitario,
  paraLlevar: null,
  ofertaId: null,
  categoriaBase: null,
  disponible: flujoMesa ? (e.disponible ?? true) : true,
  nombre: e.nombre,
  platoId: e.platoId,
});

const lineaAlmuerzo = (personaRef: string, ref: string, precio: number, disponible = true): ItemCobro => ({
  ref,
  personaRef,
  tipo: 'ALMUERZO',
  cantidad: 1,
  precioUnitario: precio,
  paraLlevar: null,
  ofertaId: null,
  categoriaBase: null,
  disponible,
  nombre: 'Almuerzo',
  platoId: null,
});

/**
 * Cotización de una respuesta informativa: nunca hace fallar la lectura. Un almuerzo de caja con P = 0 (I-12) no se
 * puede cotizar y da null; cualquier otro CotizarError es un error de programación y sí se propaga.
 */
export function cotizarInformativa(entrada: EntradaCobro): Cotizacion | null {
  try {
    return cotizar(entrada);
  } catch (e) {
    if (e instanceof CotizarError && e.code === 'ALMUERZO_SIN_PRECIO') return null;
    throw e;
  }
}

// --- Pedido (preorden) -------------------------------------------------------------------------------------------

export interface PedidoParaCobro extends Precios {
  paraLlevar: boolean;
  /** El pedido lleva un almuerzo. */
  conAlmuerzo: boolean;
  extras: PlatoSuelto[];
  plan: PlanPersona;
}

/** Flujo PREORDEN: una sola persona (ref "0"), el almuerzo (si hay) y los extras del menú de hoy. */
export function entradaPedido(p: PedidoParaCobro): EntradaCobro {
  const persona: PersonaCobro = { ref: '0', orden: 0, esAnfitrion: true, paraLlevar: false, plan: p.plan };
  const items: ItemCobro[] = [];
  if (p.conAlmuerzo) items.push(lineaAlmuerzo('0', 'almuerzo', p.precioAlmuerzo));
  // Por posición: un pedido puede repetir un mismo plato en dos renglones.
  p.extras.forEach((e, i) => items.push(lineaPlato('0', `extra:${i}`, e, false)));
  return {
    flujo: 'PREORDEN',
    modoMesa: null,
    momentoCobro: p.momentoCobro,
    precioAlmuerzo: p.precioAlmuerzo,
    recargoLlevar: p.recargoLlevar,
    paraLlevarCabecera: p.paraLlevar,
    personas: [persona],
    items,
  };
}

/**
 * Pedido ya creado.
 * - Con snapshot del precio del almuerzo (`precioAlmuerzo`, `orden_cabecera.precio_almuerzo_centavos`, INC-06): P es
 *   el del pedido. Si el pedido ya se canjeó, el plan es lo que pasó en caja (un consumo vivo del pedido = cubierto; si
 *   no, sin plan); si no, el plan de hoy.
 * - Pedidos viejos, sin snapshot: P sale de `subtotal − extras` (como `renderOrders`). Un almuerzo guardado en 0 se fijó
 *   cubierto por el plan al pedir y se respeta (si no, la cotización lo vería como un almuerzo de caja con P = 0,
 *   I-12, aunque el plan ya se haya gastado al canjear).
 */
export function entradaPedidoCreado(
  p: Omit<PedidoParaCobro, 'precioAlmuerzo' | 'plan'> & {
    subtotal: number;
    plan: PlanPersona;
    precioAlmuerzo?: number | null;
    /** Ya canjeado en caja: `conConsumo` dice si se descontó del plan (y no se deshizo). */
    canjeado?: { conConsumo: boolean } | null;
  },
): EntradaCobro {
  if (p.precioAlmuerzo !== undefined && p.precioAlmuerzo !== null) {
    const plan: PlanPersona = p.canjeado ? (p.canjeado.conConsumo ? { estado: 'OK', disponibles: 1 } : SIN_PLAN) : p.plan;
    return entradaPedido({ ...p, precioAlmuerzo: p.precioAlmuerzo, plan });
  }
  const extras = p.extras.reduce((s, e) => s + e.cantidad * e.precioUnitario, 0);
  const precioAlmuerzo = Math.max(0, p.subtotal - extras);
  const plan: PlanPersona = p.conAlmuerzo && precioAlmuerzo === 0 ? { estado: 'OK', disponibles: Math.max(1, p.plan.disponibles) } : p.plan;
  return entradaPedido({ ...p, precioAlmuerzo, plan });
}

/**
 * P de un pedido para cobrarlo: el snapshot si existe; si no (pedidos viejos), lo que se guardó al pedir si el almuerzo
 * se cobraba (`subtotal − extras` > 0) o, si se guardó cubierto (0), el precio actual del local.
 */
export function precioAlmuerzoDePedido(p: { snapshot: number | null; subtotal: number; extras: number; precioActual: number }): number {
  if (p.snapshot !== null) return p.snapshot;
  const guardado = p.subtotal - p.extras;
  return guardado > 0 ? guardado : p.precioActual;
}

// --- Mesa --------------------------------------------------------------------------------------------------------

export interface MiembroParaCobro {
  /** miembro_id (estable). */
  ref: string;
  esAnfitrion: boolean;
  paraLlevar: boolean;
  /** Plan del miembro; null = quien consulta no puede leerlo (RLS). */
  plan: PlanPersona | null;
  /** Lo que eligió; null o vacía = no eligió nada. */
  seleccion: { almuerzo: boolean; almuerzoAgotado?: boolean; extras: PlatoSuelto[] } | null;
}

export interface MesaParaCobro extends Precios {
  modo: 'CADA_UNO' | 'INVITO_YO';
  /** En el orden de la mesa: anfitrión primero, luego (unido_en, miembro_id). */
  miembros: MiembroParaCobro[];
  /**
   * 'seleccion' (E.6): cada miembro con lo que eligió; sin selección = 1 almuerzo (I-4).
   * 'un-almuerzo' (E.5, validar sin `aplicarSeleccion`): cada miembro con 1 almuerzo, sin extras.
   */
  base: 'seleccion' | 'un-almuerzo';
}

/** Quién paga a cada miembro (D6): el anfitrión en INVITO_YO, cada uno en CADA_UNO. */
export const pagadorDe = (modo: MesaParaCobro['modo'], m: MiembroParaCobro, anfitrion: MiembroParaCobro) =>
  modo === 'INVITO_YO' ? anfitrion : m;

export function entradaMesa(mesa: MesaParaCobro): EntradaCobro {
  const personas: PersonaCobro[] = mesa.miembros.map((m, orden) => ({
    ref: m.ref,
    orden,
    esAnfitrion: m.esAnfitrion,
    paraLlevar: m.paraLlevar,
    // Si el plan no se puede leer, esta persona no se usa para ninguna cotización visible (ver cotizacionesDeMesa).
    plan: m.plan ?? SIN_PLAN,
  }));
  const items: ItemCobro[] = [];
  for (const m of mesa.miembros) {
    const sel = mesa.base === 'seleccion' ? m.seleccion : null;
    const vacia = !sel || (!sel.almuerzo && sel.extras.length === 0);
    if (vacia || sel!.almuerzo)
      items.push(lineaAlmuerzo(m.ref, `${m.ref}:almuerzo`, mesa.precioAlmuerzo, vacia ? true : !sel!.almuerzoAgotado));
    for (const e of sel?.extras ?? []) items.push(lineaPlato(m.ref, `${m.ref}:${e.platoId}`, e, true));
  }
  return {
    flujo: 'MESA',
    modoMesa: mesa.modo,
    momentoCobro: mesa.momentoCobro,
    precioAlmuerzo: mesa.precioAlmuerzo,
    recargoLlevar: mesa.recargoLlevar,
    paraLlevarCabecera: false,
    personas,
    items,
  };
}

/** La parte de una cotización que corresponde a una persona (sus líneas y los totales de esas líneas). */
export function cotizacionDePersona(c: Cotizacion, personaRef: string): Cotizacion {
  const lineas = c.lineas.filter((l) => l.personaRef === personaRef);
  const refsEntrada = new Set(lineas.map((l) => l.ref.split('#')[0]));
  const porPagador = new Map<string, TotalPagador>();
  for (const l of lineas) {
    const t = porPagador.get(l.pagadorRef) ?? { pagadorRef: l.pagadorRef, subtotal: 0, recargo: 0, total: 0, cubierto: 0, saldo: 0 };
    t.subtotal += l.subtotalCentavos;
    t.recargo += l.recargoCentavos;
    t.cubierto += l.cubiertoPorPlanCentavos;
    t.total = t.subtotal + t.recargo;
    t.saldo = t.total - t.cubierto;
    porPagador.set(l.pagadorRef, t);
  }
  const suma = (f: (l: LineaCotizada) => number) => lineas.reduce((s, l) => s + f(l), 0);
  const subtotalCentavos = suma((l) => l.subtotalCentavos);
  const recargoCentavos = suma((l) => l.recargoCentavos);
  const cubiertoPorPlanCentavos = suma((l) => l.cubiertoPorPlanCentavos);
  return {
    estimada: c.estimada,
    lineas,
    porPagador: [...porPagador.values()],
    subtotalCentavos,
    recargoCentavos,
    totalCentavos: subtotalCentavos + recargoCentavos,
    cubiertoPorPlanCentavos,
    saldoPorCobrarCentavos: subtotalCentavos + recargoCentavos - cubiertoPorPlanCentavos,
    unidadesPlan: c.unidadesPlan.filter((u) => u.personaRef === personaRef),
    avisos: c.avisos.filter((a) => a.lineaRef !== null && refsEntrada.has(a.lineaRef)),
  };
}

export interface CotizacionesMesa {
  /** Por miembro; null si no se puede cotizar con lo que quien consulta puede leer (el plan de su pagador). */
  porMiembro: Map<string, Cotizacion | null>;
  /** De toda la mesa; null si algún pagador tiene un plan ilegible. */
  mesa: Cotizacion | null;
}

/**
 * Cotiza la mesa entera una vez (el plan del anfitrión en INVITO_YO se reparte en orden) y reparte el resultado por
 * miembro. Un miembro cuyo pagador tiene `plan = null` (ilegible para quien consulta) queda en null: no se inventa.
 */
export function cotizacionesDeMesa(mesa: MesaParaCobro): CotizacionesMesa {
  const anfitrion = mesa.miembros.find((m) => m.esAnfitrion);
  const porMiembro = new Map<string, Cotizacion | null>();
  if (!anfitrion || mesa.miembros.length === 0) return { porMiembro, mesa: null };
  const todo = cotizarInformativa(entradaMesa(mesa));
  if (!todo) return { porMiembro: new Map(mesa.miembros.map((m) => [m.ref, null])), mesa: null };
  let completa = true;
  for (const m of mesa.miembros) {
    const ok = pagadorDe(mesa.modo, m, anfitrion).plan !== null;
    completa &&= ok;
    porMiembro.set(m.ref, ok ? cotizacionDePersona(todo, m.ref) : null);
  }
  return { porMiembro, mesa: completa ? todo : null };
}

// --- QR en caja (POST /v1/caja/validar, E.4) ---------------------------------------------------------------------

/** Ref del almuerzo de un pedido o de un QR; sus unidades del plan salen como `almuerzo#1`, … (B.3 paso 6). */
export const REF_ALMUERZO = 'almuerzo';
/** Ref de un plato agregado en caja (`items` de validar o de una cuenta): uno por plato, así repetirlo suma cantidad. */
export const refItem = (platoPublicId: string) => `item:${platoPublicId.toLowerCase()}`;

export interface QrParaCobro extends Precios {
  paraLlevar: boolean;
  plan: PlanPersona;
  /** Carta, extras y bebidas en la misma cuenta (sin `paraLlevar` por ítem, D3: heredan el de la cabecera). */
  items: PlatoSuelto[];
}

/** Flujo QR: una persona ("0"), un almuerzo y los platos de `items`. */
export function entradaQr(p: QrParaCobro): EntradaCobro {
  const persona: PersonaCobro = { ref: '0', orden: 0, esAnfitrion: true, paraLlevar: false, plan: p.plan };
  return {
    flujo: 'QR',
    modoMesa: null,
    momentoCobro: p.momentoCobro,
    precioAlmuerzo: p.precioAlmuerzo,
    recargoLlevar: p.recargoLlevar,
    paraLlevarCabecera: p.paraLlevar,
    personas: [persona],
    items: [lineaAlmuerzo('0', REF_ALMUERZO, p.precioAlmuerzo), ...p.items.map((e) => lineaPlato('0', refItem(e.platoId), e, false))],
  };
}

// --- Cuenta existente (POST /v1/caja/cuentas/{id}/items y …/lineas/{ref}/quitar, E.11) ----------------------------

/** Una línea guardada que sigue viva (cantidad > 0 y sin reverso). Montos en centavos. */
export interface LineaViva {
  /** linea_id interno (solo para enlazar el reverso). */
  lineaId: string;
  ref: string;
  personaRef: string;
  tipo: TipoItem;
  fuente: LineaCotizada['fuente'];
  pagador: LineaCotizada['pagador'];
  omitida: LineaCotizada['omitida'];
  platoId: string | null;
  ofertaId: string | null;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  recargoUnitario: number;
  subtotal: number;
  recargo: number;
  cubierto: number;
}

export interface CuentaParaCobro {
  /** PREORDEN (cuenta de un pedido) o QR (de un consumo o un intento de escaneo). Las de mesa llegan con el PR 6. */
  flujo: 'PREORDEN' | 'QR';
  momentoCobro: MomentoCobro;
  /** `cuenta_cobro.para_llevar` (copia de la cabecera al crearla). */
  paraLlevar: boolean;
  /** Precios de hoy del local: solo se usan si ninguna línea viva trae el suyo. */
  precioAlmuerzoActual: number;
  recargoLlevarActual: number;
  vivas: LineaViva[];
  /** Platos que se agregan (ya resueltos con su precio de hoy). */
  agregar: PlatoSuelto[];
}

/**
 * Reconstruye la entrada de la cotización desde las líneas vivas de la cuenta, más lo que se agrega, para recotizar
 * todo con la misma regla (B.3). Los precios quedan congelados (B.5): cada línea viva conserva su precio unitario, el
 * almuerzo su P y el recargo su R (el de las líneas que ya lo cobran; el del local solo si ninguna lo cobra). Un plato
 * que ya está en la cuenta con `refItem` suma cantidad a su línea, al precio de esa línea.
 * - Las unidades del plan (líneas PLAN) se reconstruyen como plan OK con exactamente esas unidades; el resto del
 *   almuerzo (CAJA u omitida) conserva su motivo. Así la recotización no descuenta ni devuelve almuerzos.
 * - Una OFERTA guardada no dice su categoría base: se deduce de su recargo (con recargo → base que lo paga).
 */
export function entradaDeCuenta(c: CuentaParaCobro): EntradaCobro {
  const conRecargo = c.vivas.find((l) => l.recargoUnitario > 0);
  const recargo = conRecargo ? conRecargo.recargoUnitario : c.recargoLlevarActual;
  const almuerzoViva = c.vivas.find((l) => l.tipo === 'ALMUERZO');
  const precioAlmuerzo = almuerzoViva ? almuerzoViva.precioUnitario : c.precioAlmuerzoActual;

  const items: ItemCobro[] = [];
  const almuerzos = new Map<string, ItemCobro>();
  let unidadesPlan = 0;
  let omision: LineaCotizada['omitida'] = null;
  for (const l of c.vivas) {
    if (l.tipo === 'ALMUERZO') {
      const base = l.ref.split('#')[0]!;
      if (l.fuente === 'PLAN') unidadesPlan += l.cantidad;
      if (l.omitida) omision = l.omitida;
      const previo = almuerzos.get(base);
      if (previo) previo.cantidad += l.cantidad;
      else {
        const nuevo = { ...lineaAlmuerzo(l.personaRef, base, precioAlmuerzo), cantidad: l.cantidad };
        almuerzos.set(base, nuevo);
        items.push(nuevo);
      }
      continue;
    }
    if (l.omitida) throw new Error(`entradaDeCuenta: línea omitida ${l.omitida} fuera del almuerzo (solo existe en mesa)`);
    items.push({
      ref: l.ref,
      personaRef: l.personaRef,
      tipo: l.tipo,
      cantidad: l.cantidad,
      precioUnitario: l.precioUnitario,
      paraLlevar: null,
      ofertaId: l.ofertaId,
      categoriaBase: l.tipo === 'OFERTA' ? (l.recargoUnitario > 0 || !c.paraLlevar ? null : 'BEBIDA') : null,
      disponible: true,
      nombre: l.nombre,
      platoId: l.platoId,
    });
  }
  for (const e of c.agregar) {
    const ref = refItem(e.platoId);
    const previo = items.find((i) => i.ref === ref);
    if (previo) previo.cantidad += e.cantidad;
    else items.push(lineaPlato('0', ref, e, false));
  }
  const plan: PlanPersona =
    unidadesPlan > 0
      ? { estado: 'OK', disponibles: unidadesPlan }
      : omision === 'DUPLICADO' || omision === 'LIMITE_SAAS'
        ? { estado: omision, disponibles: 0 }
        : SIN_PLAN;
  return {
    flujo: c.flujo,
    modoMesa: null,
    momentoCobro: c.momentoCobro,
    precioAlmuerzo,
    recargoLlevar: recargo,
    paraLlevarCabecera: c.paraLlevar,
    personas: [{ ref: '0', orden: 0, esAnfitrion: true, paraLlevar: false, plan }],
    items,
  };
}

const mismaLinea = (v: LineaViva, o: LineaCotizada) =>
  v.tipo === o.tipo &&
  v.fuente === o.fuente &&
  v.pagador === o.pagador &&
  v.omitida === o.omitida &&
  v.platoId === o.platoId &&
  v.ofertaId === o.ofertaId &&
  v.cantidad === o.cantidad &&
  v.precioUnitario === o.precioUnitarioCentavos &&
  v.recargoUnitario === o.recargoUnitarioCentavos &&
  v.subtotal === o.subtotalCentavos &&
  v.recargo === o.recargoCentavos &&
  v.cubierto === o.cubiertoPorPlanCentavos;

/**
 * Qué cambia entre las líneas vivas y la cotización nueva (F.4: nunca UPDATE de un monto). Una línea igual se queda;
 * una que cambia (p. ej. más cantidad) se revierte y entra de nuevo con el mismo ref; una que ya no está se revierte;
 * una nueva se inserta. Las líneas PLAN nunca cambian (cada una tiene su consumo): si la recotización las tocara, es un
 * error de programación y se lanza.
 */
export function diferenciaLineas(vivas: LineaViva[], cot: Cotizacion): { revertir: LineaViva[]; insertar: LineaCotizada[] } {
  // Las unidades del plan se emparejan por orden (sus refs `#k` vienen de cuántas se descontaron antes).
  const planVivas = vivas.filter((l) => l.fuente === 'PLAN').sort((a, b) => Number(a.lineaId) - Number(b.lineaId));
  const planNuevas = cot.lineas.filter((l) => l.fuente === 'PLAN');
  if (planVivas.length !== planNuevas.length)
    throw new Error(`diferenciaLineas: ${planVivas.length} unidades del plan vivas y ${planNuevas.length} en la cotización`);
  let k = 0;
  const salida = cot.lineas.map((l) => (l.fuente === 'PLAN' ? { ...l, ref: planVivas[k++]!.ref } : l));
  const porRef = new Map(vivas.map((v) => [v.ref, v]));
  const refsSalida = new Set(salida.map((l) => l.ref));
  const revertir: LineaViva[] = [];
  const insertar: LineaCotizada[] = [];
  for (const o of salida) {
    const v = porRef.get(o.ref);
    if (v && mismaLinea(v, o)) continue;
    if (v) revertir.push(v);
    insertar.push(o);
  }
  for (const v of vivas) if (!refsSalida.has(v.ref)) revertir.push(v);
  if (revertir.some((l) => l.fuente === 'PLAN') || insertar.some((l) => l.fuente === 'PLAN'))
    throw new Error('diferenciaLineas: la recotización no puede cambiar una unidad del plan');
  return { revertir, insertar };
}

// --- Respuesta ---------------------------------------------------------------------------------------------------

/** Lo que va a la API: la cotización sin `unidadesPlan` (lo que `aplicar` descuenta es interno) y con la moneda. */
export type CotizacionRespuesta = Omit<Cotizacion, 'unidadesPlan'> & { monedaCodigo: string };

export function aRespuesta(c: Cotizacion, monedaCodigo: string): CotizacionRespuesta {
  const { unidadesPlan: _unidadesPlan, ...resto } = c;
  return { ...resto, monedaCodigo };
}
