import { describe, expect, it } from 'vitest';
import { cotizar } from '../../src/billing/cotizar';
import type { Cotizacion, EntradaCobro, LineaCotizada, PlanPersona } from '../../src/billing/tipos';
import {
  type LineaViva,
  type PlatoSuelto,
  SIN_PLAN,
  diferenciaLineas,
  entradaDeCuenta,
  entradaPedido,
  entradaQr,
  refItem,
} from '../../src/cobro/adaptador';

// PR 5b (docs/spec-cobros.md B.3, E.4, E.11 y G 17–22): la entrada del QR y la recotización de una cuenta existente.
const P = 350;
const R = 25;
const ok = (disponibles = 5): PlanPersona => ({ estado: 'OK', disponibles });
const precios = { precioAlmuerzo: P, recargoLlevar: R, momentoCobro: 'DESPUES_DE_SERVIR' as const };
const plato = (id: string, categoria: PlatoSuelto['categoria'], precioUnitario: number, cantidad = 1): PlatoSuelto => ({
  platoId: id,
  nombre: id,
  categoria,
  cantidad,
  precioUnitario,
});
const COLA = plato('00000000-0000-4000-8000-00000000000b', 'BEBIDA', 100);
const CHURRASCO = plato('00000000-0000-4000-8000-00000000000c', 'A_LA_CARTA', 600);
const AGUACATE = plato('00000000-0000-4000-8000-00000000000e', 'EXTRA', 75);
const final = (e: EntradaCobro) => cotizar(e, { estimada: false });
const totales = (c: Cotizacion) => [
  c.subtotalCentavos,
  c.recargoCentavos,
  c.totalCentavos,
  c.cubiertoPorPlanCentavos,
  c.saldoPorCobrarCentavos,
];

/** Lo que quedaría guardado: cada línea de la cotización como línea viva (ids en orden de inserción). */
const vivasDe = (c: Cotizacion, desde = 1): LineaViva[] =>
  c.lineas.map((l: LineaCotizada, i) => ({
    lineaId: String(desde + i),
    ref: l.ref,
    personaRef: l.personaRef,
    tipo: l.tipo,
    fuente: l.fuente,
    pagador: l.pagador,
    omitida: l.omitida,
    platoId: l.platoId,
    ofertaId: l.ofertaId,
    nombre: l.nombre ?? l.tipo,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitarioCentavos,
    recargoUnitario: l.recargoUnitarioCentavos,
    subtotal: l.subtotalCentavos,
    recargo: l.recargoCentavos,
    cubierto: l.cubiertoPorPlanCentavos,
  }));
const cuenta = (vivas: LineaViva[], o: { agregar?: PlatoSuelto[]; paraLlevar?: boolean; P?: number; R?: number } = {}) =>
  entradaDeCuenta({
    flujo: 'QR',
    momentoCobro: 'DESPUES_DE_SERVIR',
    paraLlevar: o.paraLlevar ?? true,
    precioAlmuerzoActual: o.P ?? P,
    recargoLlevarActual: o.R ?? R,
    vivas,
    agregar: o.agregar ?? [],
  });

describe('entradaQr (G 17–22)', () => {
  it.each([
    ['17 aquí, plan OK', false, ok(), [], [350, 0, 350, 350, 0]],
    ['18 llevar, plan OK', true, ok(), [], [350, 25, 375, 350, 25]],
    ['19 aquí, VENCIDO', false, { estado: 'VENCIDO', disponibles: 0 }, [], [350, 0, 350, 0, 350]],
    ['20 llevar, DIA_NO_VALIDO', true, { estado: 'DIA_NO_VALIDO', disponibles: 0 }, [], [350, 25, 375, 0, 375]],
    ['21 llevar, plan OK, B + C + E', true, ok(), [COLA, CHURRASCO, AGUACATE], [1125, 50, 1175, 350, 825]],
    ['22 aquí, DUPLICADO', false, { estado: 'DUPLICADO', disponibles: 0 }, [], [0, 0, 0, 0, 0]],
  ] as const)('%s', (_n, paraLlevar, plan, items, esperado) => {
    const c = final(entradaQr({ ...precios, paraLlevar, plan, items: [...items] }));
    expect(totales(c)).toEqual(esperado);
    expect(c.totalCentavos).toBe(c.subtotalCentavos + c.recargoCentavos);
  });

  it('refs: almuerzo (almuerzo#1 si lo cubre el plan) e item:<plato> por cada plato', () => {
    const c = final(entradaQr({ ...precios, paraLlevar: true, plan: ok(), items: [COLA] }));
    expect(c.lineas.map((l) => l.ref)).toEqual(['almuerzo#1', refItem(COLA.platoId)]);
    expect(c.avisos).toEqual([]);
    const dup = final(entradaQr({ ...precios, paraLlevar: false, plan: { estado: 'DUPLICADO', disponibles: 0 }, items: [] }));
    expect(dup.lineas).toMatchObject([{ ref: 'almuerzo', omitida: 'DUPLICADO' }]);
    expect(dup.avisos).toEqual([{ codigo: 'DUPLICADO', lineaRef: 'almuerzo' }]);
  });
});

describe('entradaDeCuenta + diferenciaLineas (E.11: recotizar todo, reversos como líneas nuevas)', () => {
  const g21 = final(entradaQr({ ...precios, paraLlevar: true, plan: ok(), items: [COLA, CHURRASCO, AGUACATE] }));

  it('sin cambios, recotizar la cuenta guardada da exactamente las mismas líneas (nada que revertir ni insertar)', () => {
    const vivas = vivasDe(g21);
    const c = final(cuenta(vivas));
    expect(totales(c)).toEqual(totales(g21));
    expect(diferenciaLineas(vivas, c)).toEqual({ revertir: [], insertar: [] });
  });

  it('precios congelados: aunque el local cambie P y R, las líneas guardadas no cambian', () => {
    const vivas = vivasDe(g21);
    expect(diferenciaLineas(vivas, final(cuenta(vivas, { P: 500, R: 40 })))).toEqual({ revertir: [], insertar: [] });
  });

  it('agregar un plato nuevo: solo se inserta su línea (con el recargo de la cuenta si aplica)', () => {
    const vivas = vivasDe(g21);
    const otro = plato('00000000-0000-4000-8000-0000000000aa', 'A_LA_CARTA', 800);
    const c = final(cuenta(vivas, { agregar: [otro], R: 40 }));
    const d = diferenciaLineas(vivas, c);
    expect(d.revertir).toEqual([]);
    // El recargo es el que ya cobra la cuenta (25), no el nuevo del local (40).
    expect(d.insertar).toMatchObject([
      { ref: refItem(otro.platoId), cantidad: 1, subtotalCentavos: 800, recargoCentavos: 25, fuente: 'CAJA' },
    ]);
    expect(c.saldoPorCobrarCentavos).toBe(825 + 825);
  });

  it('agregar un plato que ya está: revierte su línea y la vuelve a insertar con más cantidad, al precio de la línea', () => {
    const vivas = vivasDe(g21);
    const colaCara = { ...COLA, precioUnitario: 999, cantidad: 2 };
    const c = final(cuenta(vivas, { agregar: [colaCara] }));
    const d = diferenciaLineas(vivas, c);
    expect(d.revertir.map((l) => l.ref)).toEqual([refItem(COLA.platoId)]);
    expect(d.insertar).toMatchObject([{ ref: refItem(COLA.platoId), cantidad: 3, precioUnitarioCentavos: 100, subtotalCentavos: 300 }]);
    expect(c.saldoPorCobrarCentavos).toBe(825 + 200);
  });

  it('quitar una línea: solo se revierte esa', () => {
    const vivas = vivasDe(g21);
    const sinChurrasco = vivas.filter((l) => l.ref !== refItem(CHURRASCO.platoId));
    const c = final(cuenta(sinChurrasco));
    const d = diferenciaLineas(vivas, c);
    expect(d.revertir.map((l) => l.ref)).toEqual([refItem(CHURRASCO.platoId)]);
    expect(d.insertar).toEqual([]);
    expect(c.saldoPorCobrarCentavos).toBe(825 - 625);
  });

  it('almuerzo con k unidades del plan y resto en caja: se reconstruye igual (las PLAN se emparejan por orden)', () => {
    // Un almuerzo de cantidad 3 con un plan que cubre 2 (en pedido o QR hay uno solo; la regla es general).
    const base = entradaPedido({ ...precios, paraLlevar: false, conAlmuerzo: true, extras: [], plan: ok(2) });
    const pedido = final({ ...base, items: [{ ...base.items[0]!, cantidad: 3 }] });
    expect(pedido.lineas.map((l) => [l.ref, l.fuente, l.cantidad])).toEqual([
      ['almuerzo#1', 'PLAN', 1],
      ['almuerzo#2', 'PLAN', 1],
      ['almuerzo', 'CAJA', 1],
    ]);
    // Las PLAN guardadas pueden tener otro sufijo (p. ej. la #1 se deshizo y sigue la #2): se emparejan por orden.
    const vivas = vivasDe(pedido).map((l) => (l.ref === 'almuerzo#1' ? { ...l, ref: 'almuerzo#7' } : l));
    const c = final({ ...cuenta(vivas, { paraLlevar: false }), flujo: 'PREORDEN' });
    expect(diferenciaLineas(vivas, c)).toEqual({ revertir: [], insertar: [] });
  });

  it('una recotización que tocara una unidad del plan es un error de programación', () => {
    const vivas = vivasDe(g21);
    const sinPlan = final(entradaQr({ ...precios, paraLlevar: true, plan: SIN_PLAN, items: [COLA, CHURRASCO, AGUACATE] }));
    expect(() => diferenciaLineas(vivas, sinPlan)).toThrow(/unidades del plan/);
  });

  it('OFERTA guardada: la categoría base se deduce de su recargo, así la recotización no la cambia', () => {
    const conOferta = (recargo: number): LineaViva => ({
      lineaId: '9',
      ref: 'oferta:1',
      personaRef: '0',
      tipo: 'OFERTA',
      fuente: 'OFERTA',
      pagador: 'PROPIO',
      omitida: null,
      platoId: null,
      ofertaId: '00000000-0000-4000-8000-0000000000f1',
      nombre: 'Oferta',
      cantidad: 2,
      precioUnitario: 450,
      recargoUnitario: recargo,
      subtotal: 900,
      recargo: 2 * recargo,
      cubierto: 0,
    });
    for (const r of [R, 0]) {
      const vivas = [conOferta(r)];
      expect(diferenciaLineas(vivas, final({ ...cuenta(vivas), flujo: 'PREORDEN' }))).toEqual({ revertir: [], insertar: [] });
    }
  });
});
