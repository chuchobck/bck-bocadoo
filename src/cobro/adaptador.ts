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

/** B.3 paso 1: un plato de categoría ALMUERZO pedido suelto se trata como A_LA_CARTA. */
export const tipoDePlato = (c: CategoriaPlato): TipoItem => (c === 'ALMUERZO' ? 'A_LA_CARTA' : c);

export interface PlatoSuelto {
  /** public_id del plato. */
  platoId: string;
  nombre: string;
  categoria: CategoriaPlato;
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
  tipo: tipoDePlato(e.categoria),
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
 * Pedido ya creado: todavía no existe el snapshot del precio del almuerzo (F.2), así que sale de `subtotal − extras`
 * (como `renderOrders`). Un almuerzo guardado en 0 se fijó cubierto por el plan al pedir: se respeta (si no, la
 * cotización lo vería como un almuerzo de caja con P = 0, I-12, aunque el plan ya se haya gastado al canjear).
 */
export function entradaPedidoCreado(
  p: Omit<PedidoParaCobro, 'precioAlmuerzo' | 'plan'> & { subtotal: number; plan: PlanPersona },
): EntradaCobro {
  const extras = p.extras.reduce((s, e) => s + e.cantidad * e.precioUnitario, 0);
  const precioAlmuerzo = Math.max(0, p.subtotal - extras);
  const plan: PlanPersona = p.conAlmuerzo && precioAlmuerzo === 0 ? { estado: 'OK', disponibles: Math.max(1, p.plan.disponibles) } : p.plan;
  return entradaPedido({ ...p, precioAlmuerzo, plan });
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

// --- Respuesta ---------------------------------------------------------------------------------------------------

/** Lo que va a la API: la cotización sin `unidadesPlan` (lo que `aplicar` descuenta es interno) y con la moneda. */
export type CotizacionRespuesta = Omit<Cotizacion, 'unidadesPlan'> & { monedaCodigo: string };

export function aRespuesta(c: Cotizacion, monedaCodigo: string): CotizacionRespuesta {
  const { unidadesPlan: _unidadesPlan, ...resto } = c;
  return { ...resto, monedaCodigo };
}
