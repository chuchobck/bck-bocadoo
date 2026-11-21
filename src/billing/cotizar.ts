// Cotización de cobros: función pura (docs/spec-cobros.md, B.3). Sin base de datos, sin Nest, sin reloj ni azar.
// Todo es suma y producto de enteros: no hay divisiones ni redondeos.

import {
  type Cotizacion,
  CotizarError,
  type EntradaCobro,
  type Fuente,
  type ItemCobro,
  type LineaCotizada,
  type MotivoOmision,
  type OpcionesCotizar,
  type PersonaCobro,
  type TotalPagador,
  type UnidadPlan,
  type Aviso,
} from './tipos';

const CANTIDAD_MAX = 100;
const FLUJOS_CON_PLAN = new Set(['PREORDEN', 'QR', 'MESA']);
const ESTADOS_OMITEN = new Set(['DUPLICADO', 'LIMITE_SAAS']);

const esEnteroNoNegativo = (n: number) => Number.isSafeInteger(n) && n >= 0;

function seguro(n: number, que: string, lineaRef: string | null = null): number {
  if (!Number.isSafeInteger(n)) throw new CotizarError('MONTO_NO_SEGURO', `${que} no es un entero seguro`, lineaRef);
  return n;
}

function validar(entrada: EntradaCobro): Map<string, PersonaCobro> {
  const { flujo, personas, items } = entrada;
  if (!esEnteroNoNegativo(entrada.precioAlmuerzo)) throw new CotizarError('PRECIO_INVALIDO', 'precioAlmuerzo debe ser entero ≥ 0');
  if (!esEnteroNoNegativo(entrada.recargoLlevar)) throw new CotizarError('PRECIO_INVALIDO', 'recargoLlevar debe ser entero ≥ 0');

  if (flujo === 'MESA' ? entrada.modoMesa === null : entrada.modoMesa !== null)
    throw new CotizarError('MODO_MESA_INVALIDO', 'modoMesa es obligatorio en MESA y debe ser null en los demás flujos');

  if (flujo === 'MESA') {
    if (personas.length === 0 || personas.filter((p) => p.esAnfitrion).length !== 1)
      throw new CotizarError('PERSONAS_INVALIDAS', 'una mesa necesita exactamente un anfitrión');
  } else if (personas.length !== 1) {
    throw new CotizarError('PERSONAS_INVALIDAS', 'fuera de MESA hay una sola persona');
  }

  const porRef = new Map<string, PersonaCobro>();
  for (const p of personas) {
    if (porRef.has(p.ref)) throw new CotizarError('PERSONAS_INVALIDAS', `persona repetida: ${p.ref}`);
    if (!Number.isSafeInteger(p.orden)) throw new CotizarError('PERSONAS_INVALIDAS', `orden inválido: ${p.ref}`);
    if (!esEnteroNoNegativo(p.plan.disponibles))
      throw new CotizarError('PERSONAS_INVALIDAS', `plan.disponibles debe ser entero ≥ 0: ${p.ref}`);
    porRef.set(p.ref, p);
  }

  const refs = new Set<string>();
  for (const i of items) {
    if (refs.has(i.ref)) throw new CotizarError('LINEA_REPETIDA', `línea repetida: ${i.ref}`, i.ref);
    refs.add(i.ref);
    if (!porRef.has(i.personaRef)) throw new CotizarError('PERSONA_DESCONOCIDA', `persona desconocida: ${i.personaRef}`, i.ref);
    if (!Number.isInteger(i.cantidad) || i.cantidad < 1 || i.cantidad > CANTIDAD_MAX)
      throw new CotizarError('CANTIDAD_INVALIDA', `cantidad debe ser entero 1..${CANTIDAD_MAX}`, i.ref);
    if (!esEnteroNoNegativo(i.precioUnitario)) throw new CotizarError('PRECIO_INVALIDO', 'precioUnitario debe ser entero ≥ 0', i.ref);
    if (i.paraLlevar !== null && flujo !== 'POS')
      throw new CotizarError('PARA_LLEVAR_FUERA_DE_POS', 'paraLlevar por línea solo existe en el POS (D3)', i.ref);
    if (i.tipo === 'LIBRE' && flujo !== 'POS') throw new CotizarError('LIBRE_FUERA_DE_POS', 'LIBRE solo existe en el POS', i.ref);
    if (!i.disponible && flujo !== 'MESA')
      throw new CotizarError('DISPONIBLE_FUERA_DE_MESA', 'disponible = false solo existe en MESA (B.3 paso 4)', i.ref);
    if (i.tipo === 'OFERTA' && !i.ofertaId) throw new CotizarError('OFERTA_SIN_ID', 'una línea OFERTA necesita ofertaId', i.ref);
    if (i.ofertaId && i.tipo !== 'OFERTA' && i.tipo !== 'ALMUERZO')
      throw new CotizarError('OFERTA_ID_INESPERADO', 'ofertaId solo va en OFERTA o ALMUERZO', i.ref);
    if (i.tipo === 'ALMUERZO' && i.ofertaId && i.categoriaBase !== null && i.categoriaBase !== 'ALMUERZO')
      throw new CotizarError('CATEGORIA_BASE_INVALIDA', 'un almuerzo con oferta tiene categoriaBase ALMUERZO', i.ref);
    if (i.tipo === 'ALMUERZO' && !i.ofertaId && i.precioUnitario !== entrada.precioAlmuerzo)
      throw new CotizarError('PRECIO_ALMUERZO_INCONSISTENTE', 'el precio de un ALMUERZO es P (B.3 paso 2)', i.ref);
  }
  return porRef;
}

/** B.3 paso 1: un almuerzo con ofertaId es una OFERTA con categoriaBase ALMUERZO (D4). */
function normalizar(i: ItemCobro): ItemCobro {
  return i.tipo === 'ALMUERZO' && i.ofertaId ? { ...i, tipo: 'OFERTA', categoriaBase: 'ALMUERZO' } : i;
}

/** B.3 paso 3. */
function aplicaRecargo(i: ItemCobro): boolean {
  if (i.tipo === 'ALMUERZO' || i.tipo === 'A_LA_CARTA') return true;
  return i.tipo === 'OFERTA' && (i.categoriaBase === null || i.categoriaBase === 'ALMUERZO' || i.categoriaBase === 'A_LA_CARTA');
}

export function cotizar(entrada: EntradaCobro, opciones: OpcionesCotizar = {}): Cotizacion {
  const personas = validar(entrada);
  const { flujo, precioAlmuerzo: P, recargoLlevar: R } = entrada;
  const anfitrion = entrada.personas.find((p) => p.esAnfitrion) ?? null;
  const invitoYo = flujo === 'MESA' && entrada.modoMesa === 'INVITO_YO';
  const persona = (ref: string) => personas.get(ref) as PersonaCobro;

  // Paso 1: normalizar y ordenar por (persona.orden, posición en el pedido). Se trabaja sobre una copia.
  const items = entrada.items
    .map((item, posicion) => ({ item: normalizar(item), posicion }))
    .sort((a, b) => persona(a.item.personaRef).orden - persona(b.item.personaRef).orden || a.posicion - b.posicion)
    .map(({ item }) => item);

  const saldoPlan = new Map<string, number>();
  const lineas: LineaCotizada[] = [];
  const unidadesPlan: UnidadPlan[] = [];
  const avisos: Aviso[] = [];

  for (const item of items) {
    const duenio = persona(item.personaRef);
    const pagadorPersona = invitoYo ? (anfitrion as PersonaCobro) : duenio;

    // Paso 3: para llevar y recargo por línea.
    const llevar =
      flujo === 'POS' ? (item.paraLlevar ?? entrada.paraLlevarCabecera) : flujo === 'MESA' ? duenio.paraLlevar : entrada.paraLlevarCabecera;
    const recargoUnitario = llevar && aplicaRecargo(item) ? R : 0;
    // Paso 2: el precio del almuerzo es P.
    const precio = item.tipo === 'ALMUERZO' ? P : item.precioUnitario;

    // Paso 6: montos de una línea de salida.
    const linea = (fuente: Fuente, cantidad: number, omitida: MotivoOmision | null = null): LineaCotizada => {
      const subtotal = omitida ? 0 : seguro(cantidad * precio, 'subtotal', item.ref);
      const recargo = omitida ? 0 : seguro(cantidad * recargoUnitario, 'recargo', item.ref);
      const cubierto = fuente === 'PLAN' ? subtotal : 0;
      return {
        ref: item.ref,
        personaRef: duenio.ref,
        pagadorRef: pagadorPersona.ref,
        tipo: item.tipo,
        nombre: item.nombre ?? null,
        platoId: item.platoId ?? null,
        ofertaId: item.ofertaId,
        cantidad,
        paraLlevar: llevar,
        precioUnitarioCentavos: precio,
        subtotalCentavos: subtotal,
        recargoUnitarioCentavos: recargoUnitario,
        recargoCentavos: recargo,
        fuente,
        pagador: pagadorPersona.ref === duenio.ref ? 'PROPIO' : 'ANFITRION',
        cubiertoPorPlanCentavos: cubierto,
        porCobrarCentavos: seguro(subtotal - cubierto + recargo, 'porCobrar', item.ref),
        omitida,
      };
    };

    // Paso 4: agotados (solo MESA). Un almuerzo nunca se omite: solo se avisa.
    if (!item.disponible) {
      avisos.push({ codigo: 'PLATO_AGOTADO', lineaRef: item.ref });
      if (item.tipo !== 'ALMUERZO') {
        lineas.push(linea(item.tipo === 'OFERTA' ? 'OFERTA' : 'CAJA', item.cantidad, 'PLATO_AGOTADO'));
        continue;
      }
    }

    if (item.tipo !== 'ALMUERZO') {
      lineas.push(linea(item.tipo === 'OFERTA' ? 'OFERTA' : 'CAJA', item.cantidad));
      continue;
    }

    // Paso 5: plan (solo ALMUERZO en PREORDEN, QR y MESA; el POS no consulta planes).
    if (!FLUJOS_CON_PLAN.has(flujo)) {
      if (P === 0) throw new CotizarError('ALMUERZO_SIN_PRECIO', 'almuerzo a caja con P = 0 (I-12)', item.ref);
      lineas.push(linea('CAJA', item.cantidad));
      continue;
    }
    const { estado, disponibles } = pagadorPersona.plan;
    const saldo = saldoPlan.get(pagadorPersona.ref) ?? (estado === 'OK' ? disponibles : 0);
    const cubiertas = Math.min(saldo, item.cantidad);
    const resto = item.cantidad - cubiertas;
    saldoPlan.set(pagadorPersona.ref, saldo - cubiertas);
    for (let u = 0; u < cubiertas; u++) unidadesPlan.push({ personaRef: duenio.ref, pagadorRef: pagadorPersona.ref });

    if (cubiertas > 0) lineas.push(linea('PLAN', cubiertas));
    if (resto === 0) continue;
    if (ESTADOS_OMITEN.has(estado)) {
      const motivo = estado as MotivoOmision;
      lineas.push(linea('CAJA', resto, motivo));
      avisos.push({ codigo: motivo, lineaRef: item.ref });
      continue;
    }
    if (P === 0) throw new CotizarError('ALMUERZO_SIN_PRECIO', 'almuerzo a caja con P = 0 (I-12)', item.ref);
    if (estado === 'OK') avisos.push({ codigo: 'PLAN_NO_ALCANZA', lineaRef: item.ref });
    lineas.push(linea('CAJA', resto));
  }

  // Paso 7: totales por pagador (en orden de persona) y de la operación.
  const porPagadorMap = new Map<string, TotalPagador>();
  for (const l of lineas) {
    const t = porPagadorMap.get(l.pagadorRef) ?? { pagadorRef: l.pagadorRef, subtotal: 0, recargo: 0, total: 0, cubierto: 0, saldo: 0 };
    t.subtotal = seguro(t.subtotal + l.subtotalCentavos, 'subtotal del pagador');
    t.recargo = seguro(t.recargo + l.recargoCentavos, 'recargo del pagador');
    t.cubierto = seguro(t.cubierto + l.cubiertoPorPlanCentavos, 'cubierto del pagador');
    t.total = seguro(t.subtotal + t.recargo, 'total del pagador');
    t.saldo = seguro(t.total - t.cubierto, 'saldo del pagador');
    porPagadorMap.set(l.pagadorRef, t);
  }
  const porPagador = [...porPagadorMap.values()].sort((a, b) => persona(a.pagadorRef).orden - persona(b.pagadorRef).orden);

  const suma = (f: (t: TotalPagador) => number, que: string) =>
    seguro(
      porPagador.reduce((s, t) => s + f(t), 0),
      que,
    );
  const subtotalCentavos = suma((t) => t.subtotal, 'subtotalCentavos');
  const recargoCentavos = suma((t) => t.recargo, 'recargoCentavos');
  const cubiertoPorPlanCentavos = suma((t) => t.cubierto, 'cubiertoPorPlanCentavos');
  const totalCentavos = seguro(subtotalCentavos + recargoCentavos, 'totalCentavos');

  return {
    estimada: opciones.estimada ?? true,
    lineas,
    porPagador,
    subtotalCentavos,
    recargoCentavos,
    totalCentavos,
    cubiertoPorPlanCentavos,
    saldoPorCobrarCentavos: seguro(totalCentavos - cubiertoPorPlanCentavos, 'saldoPorCobrarCentavos'),
    unidadesPlan,
    avisos,
  };
}
