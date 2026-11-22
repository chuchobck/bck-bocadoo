import { describe, expect, it } from 'vitest';
import { cotizar } from '../../src/billing/cotizar';
import {
  type CategoriaBase,
  type Cotizacion,
  CotizarError,
  type EntradaCobro,
  type EstadoPlan,
  type Flujo,
  type ItemCobro,
  type ModoMesa,
  type PersonaCobro,
} from '../../src/billing/tipos';

// Constantes de la sección G de docs/spec-cobros.md.
const P = 350;
const R = 25;
const C = 600;
const E = 75;
const B = 100;
const O1 = 450; // oferta sobre el Churrasco (A_LA_CARTA)
const O2 = 250; // oferta sobre un plato ALMUERZO
const O3 = 80; // oferta sobre la Cola (BEBIDA)

// ---------- constructores de entrada ----------

type Plan = PersonaCobro['plan'];
const ok = (disponibles = 5): Plan => ({ estado: 'OK', disponibles });
const sin = (estado: Exclude<EstadoPlan, 'OK'>): Plan => ({ estado, disponibles: 0 });

type ItemParcial = Omit<ItemCobro, 'ref' | 'personaRef'>;
const item = (tipo: ItemCobro['tipo'], precioUnitario: number, cantidad = 1, extra: Partial<ItemParcial> = {}): ItemParcial => ({
  tipo,
  cantidad,
  precioUnitario,
  paraLlevar: null,
  ofertaId: null,
  categoriaBase: null,
  disponible: true,
  ...extra,
});
const alm = (q = 1, extra: Partial<ItemParcial> = {}) => item('ALMUERZO', P, q, extra);
const carta = (q = 1, extra: Partial<ItemParcial> = {}) => item('A_LA_CARTA', C, q, extra);
const extraE = (q = 1, extra: Partial<ItemParcial> = {}) => item('EXTRA', E, q, extra);
const bebida = (q = 1, extra: Partial<ItemParcial> = {}) => item('BEBIDA', B, q, extra);
const oferta = (precio: number, base: CategoriaBase | null, q = 1, id = `oferta-${precio}`) =>
  item('OFERTA', precio, q, { ofertaId: id, categoriaBase: base });
/** `almuerzo.ofertaId`: llega como ALMUERZO con ofertaId y `cotizar` lo normaliza a OFERTA (B.3 paso 1). */
const almOferta = (precio: number) => item('ALMUERZO', precio, 1, { ofertaId: `oferta-${precio}` });
const libre = (precio: number, q = 1) => item('LIBRE', precio, q);
const pos = (paraLlevar: boolean, i: ItemParcial): ItemParcial => ({ ...i, paraLlevar });

interface PersonaParcial {
  ref: string;
  plan: Plan;
  llevar?: boolean;
  items: ItemParcial[];
}

function conRefs(personas: PersonaParcial[]): { personas: PersonaCobro[]; items: ItemCobro[] } {
  return {
    personas: personas.map((p, orden) => ({
      ref: p.ref,
      orden,
      esAnfitrion: orden === 0,
      paraLlevar: p.llevar ?? false,
      plan: p.plan,
    })),
    items: personas.flatMap((p) => p.items.map((i, k) => ({ ...i, ref: `${p.ref}:${k}`, personaRef: p.ref }))),
  };
}

function simple(flujo: Exclude<Flujo, 'MESA'>, paraLlevarCabecera: boolean, plan: Plan, items: ItemParcial[]): EntradaCobro {
  return {
    flujo,
    modoMesa: null,
    momentoCobro: 'ANTES_DE_SERVIR',
    precioAlmuerzo: P,
    recargoLlevar: R,
    paraLlevarCabecera,
    ...conRefs([{ ref: '0', plan, items }]),
  };
}

function mesa(modoMesa: ModoMesa, personas: PersonaParcial[]): EntradaCobro {
  return {
    flujo: 'MESA',
    modoMesa,
    momentoCobro: 'DESPUES_DE_SERVIR',
    precioAlmuerzo: P,
    recargoLlevar: R,
    paraLlevarCabecera: false,
    ...conRefs(personas),
  };
}

// ---------- invariantes (B.3 paso 7) ----------

function verificarInvariantes(c: Cotizacion, precioAlmuerzo = P): void {
  const totales = [c.subtotalCentavos, c.recargoCentavos, c.totalCentavos, c.cubiertoPorPlanCentavos, c.saldoPorCobrarCentavos];
  for (const t of totales) expect(Number.isSafeInteger(t)).toBe(true);

  expect(c.totalCentavos).toBe(c.subtotalCentavos + c.recargoCentavos);
  expect(c.saldoPorCobrarCentavos).toBe(c.totalCentavos - c.cubiertoPorPlanCentavos);
  expect(c.saldoPorCobrarCentavos).toBeGreaterThanOrEqual(0);
  expect(c.cubiertoPorPlanCentavos).toBe(precioAlmuerzo * c.unidadesPlan.length);
  // Una línea PLAN por unidad, de cantidad 1, y refs de salida únicos.
  const lineasPlan = c.lineas.filter((l) => l.fuente === 'PLAN');
  expect(lineasPlan).toHaveLength(c.unidadesPlan.length);
  for (const l of lineasPlan) {
    expect(l.cantidad).toBe(1);
    expect(l.ref).toMatch(/#\d+$/);
  }
  expect(new Set(c.lineas.map((l) => l.ref)).size).toBe(c.lineas.length);

  // La suma por pagador es el total de la operación, campo por campo.
  const suma = (k: 'subtotal' | 'recargo' | 'total' | 'cubierto' | 'saldo') => c.porPagador.reduce((s, t) => s + t[k], 0);
  expect(suma('subtotal')).toBe(c.subtotalCentavos);
  expect(suma('recargo')).toBe(c.recargoCentavos);
  expect(suma('total')).toBe(c.totalCentavos);
  expect(suma('cubierto')).toBe(c.cubiertoPorPlanCentavos);
  expect(suma('saldo')).toBe(c.saldoPorCobrarCentavos);
  for (const t of c.porPagador) {
    for (const v of [t.subtotal, t.recargo, t.total, t.cubierto, t.saldo]) expect(Number.isSafeInteger(v)).toBe(true);
    expect(t.total).toBe(t.subtotal + t.recargo);
    expect(t.saldo).toBe(t.total - t.cubierto);
    expect(t.saldo).toBeGreaterThanOrEqual(0);
  }

  // Montos por línea (B.3 paso 6).
  for (const l of c.lineas) {
    if (l.omitida) {
      expect([l.subtotalCentavos, l.recargoCentavos, l.cubiertoPorPlanCentavos, l.porCobrarCentavos]).toEqual([0, 0, 0, 0]);
      continue;
    }
    expect(l.subtotalCentavos).toBe(l.cantidad * l.precioUnitarioCentavos);
    expect(l.recargoCentavos).toBe(l.cantidad * l.recargoUnitarioCentavos);
    expect(l.cubiertoPorPlanCentavos).toBe(l.fuente === 'PLAN' ? l.subtotalCentavos : 0);
    expect(l.porCobrarCentavos).toBe(l.subtotalCentavos - l.cubiertoPorPlanCentavos + l.recargoCentavos);
  }
  expect(c.lineas.reduce((s, l) => s + l.porCobrarCentavos, 0)).toBe(c.saldoPorCobrarCentavos);
}

/** Resumen de una línea: `TIPO·FUENTE×cantidad`, con `·OMITIDA` si corresponde. */
const resumen = (c: Cotizacion) =>
  c.lineas.map((l) => `${l.personaRef}:${l.tipo}·${l.fuente}×${l.cantidad}${l.omitida ? `·${l.omitida}` : ''}`);
const avisos = (c: Cotizacion) => c.avisos.map((a) => a.codigo);

// ---------- casos de la sección G ----------

interface Caso {
  caso: string;
  entrada: EntradaCobro;
  lineas: string[];
  sub: number;
  rec: number;
  tot: number;
  cub: number;
  saldo: number;
  verificar?: (c: Cotizacion) => void;
}

const CASOS: Caso[] = [
  // PREORDEN
  {
    caso: '1',
    entrada: simple('PREORDEN', false, ok(), [alm()]),
    lineas: ['0:ALMUERZO·PLAN×1'],
    sub: 350,
    rec: 0,
    tot: 350,
    cub: 350,
    saldo: 0,
  },
  {
    caso: '2',
    entrada: simple('PREORDEN', true, ok(), [alm()]),
    lineas: ['0:ALMUERZO·PLAN×1'],
    sub: 350,
    rec: 25,
    tot: 375,
    cub: 350,
    saldo: 25,
  },
  {
    caso: '3',
    entrada: simple('PREORDEN', false, sin('SIN_PLAN'), [alm()]),
    lineas: ['0:ALMUERZO·CAJA×1'],
    sub: 350,
    rec: 0,
    tot: 350,
    cub: 0,
    saldo: 350,
  },
  {
    caso: '4',
    entrada: simple('PREORDEN', true, sin('SIN_SALDO'), [alm()]),
    lineas: ['0:ALMUERZO·CAJA×1'],
    sub: 350,
    rec: 25,
    tot: 375,
    cub: 0,
    saldo: 375,
  },
  {
    caso: '5',
    entrada: simple('PREORDEN', true, ok(), [alm(), bebida(2), extraE(1)]),
    lineas: ['0:ALMUERZO·PLAN×1', '0:BEBIDA·CAJA×2', '0:EXTRA·CAJA×1'],
    sub: 625,
    rec: 25,
    tot: 650,
    cub: 350,
    saldo: 300,
  },
  {
    caso: '6',
    entrada: simple('PREORDEN', true, ok(), [carta(2)]),
    lineas: ['0:A_LA_CARTA·CAJA×2'],
    sub: 1200,
    rec: 50,
    tot: 1250,
    cub: 0,
    saldo: 1250,
    verificar: (c) => expect(c.unidadesPlan).toEqual([]),
  },
  {
    caso: '7',
    entrada: simple('PREORDEN', false, sin('SIN_PLAN'), [alm(), carta(1)]),
    lineas: ['0:ALMUERZO·CAJA×1', '0:A_LA_CARTA·CAJA×1'],
    sub: 950,
    rec: 0,
    tot: 950,
    cub: 0,
    saldo: 950,
  },
  {
    caso: '8',
    entrada: simple('PREORDEN', false, ok(), [almOferta(O2)]),
    lineas: ['0:OFERTA·OFERTA×1'],
    sub: 250,
    rec: 0,
    tot: 250,
    cub: 0,
    saldo: 250,
    verificar: (c) => expect(c.unidadesPlan).toEqual([]), // plan intacto
  },
  {
    caso: '9',
    entrada: simple('PREORDEN', true, ok(), [almOferta(O2)]),
    lineas: ['0:OFERTA·OFERTA×1'],
    sub: 250,
    rec: 25,
    tot: 275,
    cub: 0,
    saldo: 275,
    verificar: (c) => expect(c.unidadesPlan).toEqual([]),
  },
  {
    caso: '10',
    entrada: simple('PREORDEN', true, sin('VENCIDO'), [oferta(O3, 'BEBIDA', 2)]),
    lineas: ['0:OFERTA·OFERTA×2'],
    sub: 160,
    rec: 0,
    tot: 160,
    cub: 0,
    saldo: 160,
  },
  // POS
  {
    caso: '11',
    entrada: simple('POS', true, sin('SIN_PLAN'), [alm(3)]),
    lineas: ['0:ALMUERZO·CAJA×3'],
    sub: 1050,
    rec: 75,
    tot: 1125,
    cub: 0,
    saldo: 1125,
  },
  {
    caso: '12',
    entrada: simple('POS', false, sin('SIN_PLAN'), [
      pos(true, alm(2)),
      alm(1),
      pos(true, carta(1)),
      pos(true, bebida(2)),
      pos(true, extraE(1)),
    ]),
    lineas: ['0:ALMUERZO·CAJA×2', '0:ALMUERZO·CAJA×1', '0:A_LA_CARTA·CAJA×1', '0:BEBIDA·CAJA×2', '0:EXTRA·CAJA×1'],
    sub: 1925,
    rec: 75,
    tot: 2000,
    cub: 0,
    saldo: 2000,
    // recargo: 2 + 0 + 1 unidades
    verificar: (c) => expect(c.lineas.map((l) => l.recargoCentavos)).toEqual([50, 0, 25, 0, 0]),
  },
  {
    caso: '13',
    entrada: simple('POS', true, sin('SIN_PLAN'), [carta(1)]),
    lineas: ['0:A_LA_CARTA·CAJA×1'],
    sub: 600,
    rec: 25,
    tot: 625,
    cub: 0,
    saldo: 625,
  },
  {
    caso: '14',
    entrada: simple('POS', true, sin('SIN_PLAN'), [pos(false, alm(1)), alm(1)]),
    lineas: ['0:ALMUERZO·CAJA×1', '0:ALMUERZO·CAJA×1'],
    sub: 700,
    rec: 25,
    tot: 725,
    cub: 0,
    saldo: 725,
    verificar: (c) => expect(c.lineas.map((l) => l.paraLlevar)).toEqual([false, true]),
  },
  {
    caso: '15',
    entrada: simple('POS', true, sin('SIN_PLAN'), [libre(50)]),
    lineas: ['0:LIBRE·CAJA×1'],
    sub: 50,
    rec: 0,
    tot: 50,
    cub: 0,
    saldo: 50,
  },
  // QR
  {
    caso: '17',
    entrada: simple('QR', false, ok(), [alm()]),
    lineas: ['0:ALMUERZO·PLAN×1'],
    sub: 350,
    rec: 0,
    tot: 350,
    cub: 350,
    saldo: 0,
  },
  {
    caso: '18a (ANTES_DE_SERVIR)',
    entrada: { ...simple('QR', true, ok(), [alm()]), momentoCobro: 'ANTES_DE_SERVIR' },
    lineas: ['0:ALMUERZO·PLAN×1'],
    sub: 350,
    rec: 25,
    tot: 375,
    cub: 350,
    saldo: 25,
  },
  {
    caso: '18b (DESPUES_DE_SERVIR)',
    entrada: { ...simple('QR', true, ok(), [alm()]), momentoCobro: 'DESPUES_DE_SERVIR' },
    lineas: ['0:ALMUERZO·PLAN×1'],
    sub: 350,
    rec: 25,
    tot: 375,
    cub: 350,
    saldo: 25,
  },
  {
    caso: '19',
    entrada: simple('QR', false, sin('VENCIDO'), [alm()]),
    lineas: ['0:ALMUERZO·CAJA×1'],
    sub: 350,
    rec: 0,
    tot: 350,
    cub: 0,
    saldo: 350,
  },
  {
    caso: '20',
    entrada: simple('QR', true, sin('DIA_NO_VALIDO'), [alm()]),
    lineas: ['0:ALMUERZO·CAJA×1'],
    sub: 350,
    rec: 25,
    tot: 375,
    cub: 0,
    saldo: 375,
  },
  {
    caso: '21',
    entrada: simple('QR', true, ok(), [alm(), bebida(1), carta(1), extraE(1)]),
    lineas: ['0:ALMUERZO·PLAN×1', '0:BEBIDA·CAJA×1', '0:A_LA_CARTA·CAJA×1', '0:EXTRA·CAJA×1'],
    sub: 1125,
    rec: 50,
    tot: 1175,
    cub: 350,
    saldo: 825,
  },
  {
    caso: '22',
    entrada: simple('QR', false, sin('DUPLICADO'), [alm()]),
    lineas: ['0:ALMUERZO·CAJA×1·DUPLICADO'],
    sub: 0,
    rec: 0,
    tot: 0,
    cub: 0,
    saldo: 0,
    verificar: (c) => expect(avisos(c)).toEqual(['DUPLICADO']),
  },
  // OFERTA
  {
    caso: '24',
    entrada: simple('OFERTA', false, sin('SIN_PLAN'), [oferta(O1, 'A_LA_CARTA', 2)]),
    lineas: ['0:OFERTA·OFERTA×2'],
    sub: 900,
    rec: 0,
    tot: 900,
    cub: 0,
    saldo: 900,
  },
  {
    caso: '25',
    entrada: simple('OFERTA', true, sin('SIN_PLAN'), [oferta(O1, 'A_LA_CARTA', 2)]),
    lineas: ['0:OFERTA·OFERTA×2'],
    sub: 900,
    rec: 50,
    tot: 950,
    cub: 0,
    saldo: 950,
  },
  {
    caso: '26',
    entrada: simple('OFERTA', true, sin('SIN_PLAN'), [oferta(O3, 'BEBIDA', 1)]),
    lineas: ['0:OFERTA·OFERTA×1'],
    sub: 80,
    rec: 0,
    tot: 80,
    cub: 0,
    saldo: 80,
  },
  // MESA CADA_UNO
  {
    caso: '28',
    entrada: mesa('CADA_UNO', [
      { ref: 'A', plan: ok(), items: [alm(), bebida(1)] },
      { ref: 'B', plan: sin('SIN_PLAN'), items: [alm(), extraE(1)] },
      { ref: 'C', plan: sin('SIN_SALDO'), llevar: true, items: [alm()] },
      { ref: 'D', plan: ok(), items: [carta(1)] },
    ]),
    lineas: ['A:ALMUERZO·PLAN×1', 'A:BEBIDA·CAJA×1', 'B:ALMUERZO·CAJA×1', 'B:EXTRA·CAJA×1', 'C:ALMUERZO·CAJA×1', 'D:A_LA_CARTA·CAJA×1'],
    sub: 1825,
    rec: 25,
    tot: 1850,
    cub: 350,
    saldo: 1500,
    verificar: (c) => {
      expect(c.porPagador).toEqual([
        { pagadorRef: 'A', subtotal: 450, recargo: 0, total: 450, cubierto: 350, saldo: 100 },
        { pagadorRef: 'B', subtotal: 425, recargo: 0, total: 425, cubierto: 0, saldo: 425 },
        { pagadorRef: 'C', subtotal: 350, recargo: 25, total: 375, cubierto: 0, saldo: 375 },
        { pagadorRef: 'D', subtotal: 600, recargo: 0, total: 600, cubierto: 0, saldo: 600 },
      ]);
      expect(c.unidadesPlan).toEqual([{ personaRef: 'A', pagadorRef: 'A' }]); // 1 consumo; plan de D intacto
      expect(c.lineas.every((l) => l.pagador === 'PROPIO')).toBe(true);
    },
  },
  {
    caso: '29',
    entrada: mesa('CADA_UNO', [{ ref: 'A', plan: ok(), llevar: true, items: [oferta(O1, 'A_LA_CARTA', 1)] }]),
    lineas: ['A:OFERTA·OFERTA×1'],
    sub: 450,
    rec: 25,
    tot: 475,
    cub: 0,
    saldo: 475,
    verificar: (c) => expect(c.unidadesPlan).toEqual([]),
  },
  {
    caso: '30',
    entrada: mesa('CADA_UNO', [{ ref: 'A', plan: sin('DUPLICADO'), items: [alm(), bebida(1)] }]),
    lineas: ['A:ALMUERZO·CAJA×1·DUPLICADO', 'A:BEBIDA·CAJA×1'],
    sub: 100,
    rec: 0,
    tot: 100,
    cub: 0,
    saldo: 100,
    verificar: (c) => expect(avisos(c)).toEqual(['DUPLICADO']),
  },
  // MESA INVITO_YO
  {
    caso: '31',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: ok(2), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), items: [alm()] },
      { ref: 'G2', plan: ok(), llevar: true, items: [alm()] },
      { ref: 'G3', plan: ok(), items: [alm()] },
    ]),
    lineas: ['H:ALMUERZO·PLAN×1', 'G1:ALMUERZO·PLAN×1', 'G2:ALMUERZO·CAJA×1', 'G3:ALMUERZO·CAJA×1'],
    sub: 1400,
    rec: 25,
    tot: 1425,
    cub: 700,
    saldo: 725,
    verificar: (c) => {
      expect(c.porPagador.map((t) => t.pagadorRef)).toEqual(['H']); // 1 cuenta (anfitrión)
      expect(c.unidadesPlan).toEqual([
        { personaRef: 'H', pagadorRef: 'H' },
        { personaRef: 'G1', pagadorRef: 'H' },
      ]);
      expect(c.lineas.filter((l) => l.personaRef !== 'H').every((l) => l.pagador === 'ANFITRION' && l.pagadorRef === 'H')).toBe(true);
      expect(avisos(c)).toContain('PLAN_NO_ALCANZA');
    },
  },
  {
    caso: '32',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: sin('SIN_PLAN'), items: [alm(), bebida(1)] },
      { ref: 'G1', plan: ok(), items: [alm()] },
      { ref: 'G2', plan: ok(), items: [alm()] },
    ]),
    lineas: ['H:ALMUERZO·CAJA×1', 'H:BEBIDA·CAJA×1', 'G1:ALMUERZO·CAJA×1', 'G2:ALMUERZO·CAJA×1'],
    sub: 1150,
    rec: 0,
    tot: 1150,
    cub: 0,
    saldo: 1150,
  },
  {
    caso: '33',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: ok(), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), items: [almOferta(O2)] },
    ]),
    lineas: ['H:ALMUERZO·PLAN×1', 'G1:OFERTA·OFERTA×1'],
    sub: 600,
    rec: 0,
    tot: 600,
    cub: 350,
    saldo: 250,
    verificar: (c) => expect(c.unidadesPlan).toHaveLength(1),
  },
  {
    caso: '34',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: ok(), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), llevar: true, items: [carta(1), extraE(1)] },
    ]),
    lineas: ['H:ALMUERZO·PLAN×1', 'G1:A_LA_CARTA·CAJA×1', 'G1:EXTRA·CAJA×1'],
    sub: 1025,
    rec: 25,
    tot: 1050,
    cub: 350,
    saldo: 700,
    verificar: (c) => expect(c.unidadesPlan).toHaveLength(1),
  },
  {
    // Validar mesa sin aplicarSeleccion: el endpoint arma 1 almuerzo por miembro con su paraLlevar.
    caso: '35',
    entrada: mesa('CADA_UNO', [
      { ref: 'A', plan: ok(), items: [alm()] },
      { ref: 'B', plan: sin('SIN_PLAN'), llevar: true, items: [alm()] },
    ]),
    lineas: ['A:ALMUERZO·PLAN×1', 'B:ALMUERZO·CAJA×1'],
    sub: 700,
    rec: 25,
    tot: 725,
    cub: 350,
    saldo: 375,
  },
  {
    // Entrada real al validar: al anfitrión le queda 1 almuerzo.
    caso: '36 (real)',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: ok(1), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), items: [alm()] },
      { ref: 'G2', plan: sin('SIN_PLAN'), items: [alm()] },
    ]),
    lineas: ['H:ALMUERZO·PLAN×1', 'G1:ALMUERZO·CAJA×1', 'G2:ALMUERZO·CAJA×1'],
    sub: 1050,
    rec: 0,
    tot: 1050,
    cub: 350,
    saldo: 700,
    verificar: (c) => expect(avisos(c)).toContain('PLAN_NO_ALCANZA'),
  },
  {
    // Vista previa: el anfitrión todavía tenía 2.
    caso: '36 (estimada)',
    entrada: mesa('INVITO_YO', [
      { ref: 'H', plan: ok(2), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), items: [alm()] },
      { ref: 'G2', plan: sin('SIN_PLAN'), items: [alm()] },
    ]),
    lineas: ['H:ALMUERZO·PLAN×1', 'G1:ALMUERZO·PLAN×1', 'G2:ALMUERZO·CAJA×1'],
    sub: 1050,
    rec: 0,
    tot: 1050,
    cub: 700,
    saldo: 350,
  },
  // PREORDEN con plato a la carta como extra
  {
    caso: '49',
    entrada: simple('PREORDEN', true, ok(), [alm(), carta(1)]),
    lineas: ['0:ALMUERZO·PLAN×1', '0:A_LA_CARTA·CAJA×1'],
    sub: 950,
    rec: 50,
    tot: 1000,
    cub: 350,
    saldo: 650,
  },
];

describe('cotizar: casos de la sección G de la spec de cobros', () => {
  it.each(CASOS)('caso $caso', ({ entrada, lineas, sub, rec, tot, cub, saldo, verificar }) => {
    const c = cotizar(entrada);
    expect(resumen(c)).toEqual(lineas);
    expect({
      sub: c.subtotalCentavos,
      rec: c.recargoCentavos,
      tot: c.totalCentavos,
      cub: c.cubiertoPorPlanCentavos,
      saldo: c.saldoPorCobrarCentavos,
    }).toEqual({ sub, rec, tot, cub, saldo });
    verificarInvariantes(c);
    verificar?.(c);
  });

  it('caso 36: la estimada y la real difieren en un almuerzo del plan (Cub 700/Saldo 350 → Cub 350/Saldo 700)', () => {
    const real = cotizar(CASOS.find((k) => k.caso === '36 (real)')!.entrada, { estimada: false });
    const estimada = cotizar(CASOS.find((k) => k.caso === '36 (estimada)')!.entrada);
    expect(estimada.estimada).toBe(true);
    expect(real.estimada).toBe(false);
    expect(real.totalCentavos).toBe(estimada.totalCentavos);
    expect(estimada.cubiertoPorPlanCentavos - real.cubiertoPorPlanCentavos).toBe(P);
    expect(real.saldoPorCobrarCentavos - estimada.saldoPorCobrarCentavos).toBe(P);
  });
});

// ---------- comportamiento adicional de la función ----------

describe('cotizar: orden estable', () => {
  it('ordena líneas por (persona.orden, posición) aunque personas e ítems lleguen desordenados', () => {
    const base = mesa('CADA_UNO', [
      { ref: 'A', plan: ok(), items: [alm(), bebida(1)] },
      { ref: 'B', plan: ok(), items: [alm(), extraE(1)] },
      { ref: 'C', plan: ok(), items: [carta(1)] },
    ]);
    const desordenada: EntradaCobro = { ...base, personas: [...base.personas].reverse(), items: [...base.items].reverse() };
    const c = cotizar(desordenada);
    // Dentro de cada persona se respeta la posición en el pedido (aquí, invertida).
    expect(c.lineas.map((l) => l.ref)).toEqual(['A:1', 'A:0#1', 'B:1', 'B:0#1', 'C:0']);
    expect(c.porPagador.map((t) => t.pagadorRef)).toEqual(['A', 'B', 'C']);
    expect(c.unidadesPlan.map((u) => u.personaRef)).toEqual(['A', 'B']);
    verificarInvariantes(c);
  });

  it('INVITO_YO cubre primero al anfitrión y luego a los invitados por orden, aunque el anfitrión vaya último en la lista', () => {
    const base = mesa('INVITO_YO', [
      { ref: 'H', plan: ok(2), items: [alm()] },
      { ref: 'G1', plan: sin('SIN_PLAN'), items: [alm()] },
      { ref: 'G2', plan: sin('SIN_PLAN'), items: [alm()] },
    ]);
    const c = cotizar({ ...base, items: [...base.items].reverse() });
    expect(resumen(c)).toEqual(['H:ALMUERZO·PLAN×1', 'G1:ALMUERZO·PLAN×1', 'G2:ALMUERZO·CAJA×1']);
    expect(c.unidadesPlan).toEqual([
      { personaRef: 'H', pagadorRef: 'H' },
      { personaRef: 'G1', pagadorRef: 'H' },
    ]);
    verificarInvariantes(c);
  });

  it('es determinista y no modifica la entrada', () => {
    const entrada = mesa('CADA_UNO', [
      { ref: 'A', plan: ok(1), items: [alm(2), bebida(1)] },
      { ref: 'B', plan: sin('SIN_PLAN'), items: [almOferta(O2)] },
    ]);
    const copia = structuredClone(entrada);
    const congelar = <T>(o: T): T => {
      if (o && typeof o === 'object') {
        Object.values(o).forEach(congelar);
        Object.freeze(o);
      }
      return o;
    };
    const a = cotizar(congelar(entrada));
    expect(cotizar(entrada)).toEqual(a);
    expect(entrada).toEqual(copia);
  });
});

describe('cotizar: partición de un ALMUERZO con q > 1', () => {
  it('parte la línea en k líneas PLAN de cantidad 1 (ref#1, ref#2) y una CAJA × (q − k) con el ref original', () => {
    const c = cotizar(simple('PREORDEN', true, ok(2), [alm(3)]));
    const unidadPlan = {
      fuente: 'PLAN',
      cantidad: 1,
      subtotalCentavos: 350,
      recargoCentavos: 25,
      cubiertoPorPlanCentavos: 350,
      porCobrarCentavos: 25,
    };
    expect(c.lineas).toHaveLength(3);
    expect(c.lineas).toMatchObject([
      { ref: '0:0#1', ...unidadPlan },
      { ref: '0:0#2', ...unidadPlan },
      {
        ref: '0:0',
        fuente: 'CAJA',
        cantidad: 1,
        subtotalCentavos: 350,
        recargoCentavos: 25,
        cubiertoPorPlanCentavos: 0,
        porCobrarCentavos: 375,
      },
    ]);
    expect(c.unidadesPlan).toHaveLength(2);
    expect(c.avisos).toEqual([{ codigo: 'PLAN_NO_ALCANZA', lineaRef: '0:0' }]);
    expect([c.subtotalCentavos, c.recargoCentavos, c.totalCentavos, c.cubiertoPorPlanCentavos, c.saldoPorCobrarCentavos]).toEqual([
      1050, 75, 1125, 700, 425,
    ]);
    verificarInvariantes(c);
  });

  it('el saldo del plan se comparte entre líneas del mismo pagador', () => {
    const c = cotizar(simple('QR', false, ok(1), [alm(1), alm(1)]));
    expect(resumen(c)).toEqual(['0:ALMUERZO·PLAN×1', '0:ALMUERZO·CAJA×1']);
    expect(c.lineas.map((l) => l.ref)).toEqual(['0:0#1', '0:1']);
    verificarInvariantes(c);
  });

  it('una línea totalmente cubierta da una línea PLAN por unidad y ninguna CAJA', () => {
    const c = cotizar(simple('PREORDEN', false, ok(5), [alm(3)]));
    expect(resumen(c)).toEqual(['0:ALMUERZO·PLAN×1', '0:ALMUERZO·PLAN×1', '0:ALMUERZO·PLAN×1']);
    expect(c.lineas.map((l) => l.ref)).toEqual(['0:0#1', '0:0#2', '0:0#3']);
    expect(c.avisos).toEqual([]);
    verificarInvariantes(c);
  });

  it('rechaza un ref de entrada con "#" (reservado para las unidades del plan)', () => {
    const e = simple('QR', false, ok(), [alm()]);
    expect(() => cotizar({ ...e, items: [{ ...e.items[0], ref: 'x#1' }] })).toThrow(expect.objectContaining({ code: 'ENTRADA_INVALIDA' }));
  });
});

describe('cotizar: líneas omitidas', () => {
  it.each(['DUPLICADO', 'LIMITE_SAAS'] as const)('%s: el almuerzo queda omitido con montos 0 y aviso; el resto se cobra', (estado) => {
    const c = cotizar(simple('QR', true, sin(estado), [alm(2), carta(1)]));
    expect(c.lineas[0]).toMatchObject({
      tipo: 'ALMUERZO',
      cantidad: 2,
      omitida: estado,
      subtotalCentavos: 0,
      recargoCentavos: 0,
      cubiertoPorPlanCentavos: 0,
      porCobrarCentavos: 0,
    });
    expect(c.lineas[1]).toMatchObject({ tipo: 'A_LA_CARTA', omitida: null, porCobrarCentavos: 625 });
    expect(c.avisos).toEqual([{ codigo: estado, lineaRef: '0:0' }]);
    expect(c.unidadesPlan).toEqual([]);
    expect(c.saldoPorCobrarCentavos).toBe(625);
    verificarInvariantes(c);
  });

  it('PLATO_AGOTADO (MESA): carta, extra y bebida agotados quedan omitidos con montos 0', () => {
    const c = cotizar(
      mesa('CADA_UNO', [
        {
          ref: 'A',
          plan: ok(),
          llevar: true,
          items: [alm(), carta(1, { disponible: false }), extraE(1, { disponible: false }), bebida(2, { disponible: false })],
        },
      ]),
    );
    expect(resumen(c)).toEqual([
      'A:ALMUERZO·PLAN×1',
      'A:A_LA_CARTA·CAJA×1·PLATO_AGOTADO',
      'A:EXTRA·CAJA×1·PLATO_AGOTADO',
      'A:BEBIDA·CAJA×2·PLATO_AGOTADO',
    ]);
    for (const l of c.lineas.slice(1)) {
      expect([l.subtotalCentavos, l.recargoCentavos, l.cubiertoPorPlanCentavos, l.porCobrarCentavos]).toEqual([0, 0, 0, 0]);
    }
    expect(avisos(c)).toEqual(['PLATO_AGOTADO', 'PLATO_AGOTADO', 'PLATO_AGOTADO']);
    expect(c.saldoPorCobrarCentavos).toBe(25);
    verificarInvariantes(c);
  });

  it.each(['DUPLICADO', 'LIMITE_SAAS'] as const)(
    'plan OK que se acaba y la base responde %s a la unidad siguiente (trasAgotarse): el resto queda omitido, sin PLAN_NO_ALCANZA',
    (estado) => {
      const c = cotizar(simple('QR', true, { estado: 'OK', disponibles: 1, trasAgotarse: estado }, [alm(3)]));
      expect(resumen(c)).toEqual(['0:ALMUERZO·PLAN×1', `0:ALMUERZO·CAJA×2·${estado}`]);
      expect(c.avisos).toEqual([{ codigo: estado, lineaRef: '0:0' }]);
      expect(c.saldoPorCobrarCentavos).toBe(25); // solo el recargo de la unidad cubierta
      verificarInvariantes(c);
    },
  );

  it.each(['SIN_SALDO', 'VENCIDO', 'DIA_NO_VALIDO', 'OK'] as const)(
    'plan OK que se acaba con trasAgotarse %s: el resto va a CAJA con PLAN_NO_ALCANZA (como sin trasAgotarse)',
    (estado) => {
      const c = cotizar(simple('QR', false, { estado: 'OK', disponibles: 1, trasAgotarse: estado }, [alm(2)]));
      expect(resumen(c)).toEqual(['0:ALMUERZO·PLAN×1', '0:ALMUERZO·CAJA×1']);
      expect(c.avisos).toEqual([{ codigo: 'PLAN_NO_ALCANZA', lineaRef: '0:0' }]);
      verificarInvariantes(c);
    },
  );

  it('trasAgotarse no cambia nada si el plan no es OK (manda su estado)', () => {
    const c = cotizar(simple('QR', false, { estado: 'SIN_SALDO', disponibles: 0, trasAgotarse: 'LIMITE_SAAS' }, [alm(1)]));
    expect(resumen(c)).toEqual(['0:ALMUERZO·CAJA×1']);
    verificarInvariantes(c);
  });

  it('un almuerzo agotado no se omite: solo se avisa', () => {
    const c = cotizar(mesa('CADA_UNO', [{ ref: 'A', plan: ok(), items: [alm(1, { disponible: false })] }]));
    expect(resumen(c)).toEqual(['A:ALMUERZO·PLAN×1']);
    expect(c.avisos).toEqual([{ codigo: 'PLATO_AGOTADO', lineaRef: 'A:0' }]);
    verificarInvariantes(c);
  });
});

describe('cotizar: el POS no consulta planes', () => {
  it('un almuerzo en POS va a CAJA aunque la persona tenga plan OK', () => {
    const c = cotizar(simple('POS', false, ok(5), [alm(2)]));
    expect(resumen(c)).toEqual(['0:ALMUERZO·CAJA×2']);
    expect(c.unidadesPlan).toEqual([]);
    verificarInvariantes(c);
  });
});

describe('cotizar: entradas inválidas', () => {
  const error = (entrada: EntradaCobro) => {
    try {
      cotizar(entrada);
    } catch (e) {
      expect(e).toBeInstanceOf(CotizarError);
      return (e as CotizarError).code;
    }
    throw new Error('cotizar no lanzó');
  };

  it.each(['PREORDEN', 'QR', 'OFERTA'] as const)('paraLlevar por línea en %s', (flujo) => {
    const i = flujo === 'OFERTA' ? oferta(O1, 'A_LA_CARTA') : alm();
    expect(error(simple(flujo, false, ok(), [{ ...i, paraLlevar: true }]))).toBe('PARA_LLEVAR_FUERA_DE_POS');
    expect(error(simple(flujo, false, ok(), [{ ...i, paraLlevar: false }]))).toBe('PARA_LLEVAR_FUERA_DE_POS');
  });

  it('paraLlevar por línea en MESA', () => {
    expect(error(mesa('CADA_UNO', [{ ref: 'A', plan: ok(), items: [{ ...alm(), paraLlevar: true }] }]))).toBe('PARA_LLEVAR_FUERA_DE_POS');
  });

  it('OFERTA sin ofertaId', () => {
    expect(error(simple('OFERTA', false, ok(), [{ ...oferta(O1, 'A_LA_CARTA'), ofertaId: null }]))).toBe('OFERTA_SIN_ID');
  });

  it.each([0, 101, -1, 1.5, Number.NaN])('cantidad %s fuera de 1..100', (cantidad) => {
    expect(error(simple('PREORDEN', false, ok(), [carta(cantidad)]))).toBe('CANTIDAD_INVALIDA');
  });

  it('cantidad en los bordes 1 y 100 se acepta', () => {
    verificarInvariantes(cotizar(simple('PREORDEN', false, ok(), [carta(1), bebida(100)])));
  });

  it.each([-1, 0.5, Number.NaN])('precio unitario %s', (precio) => {
    expect(error(simple('PREORDEN', false, ok(), [item('EXTRA', precio)]))).toBe('PRECIO_INVALIDO');
  });

  it('P o R negativos', () => {
    expect(error({ ...simple('PREORDEN', false, ok(), [alm()]), precioAlmuerzo: -1 })).toBe('PRECIO_INVALIDO');
    expect(error({ ...simple('PREORDEN', false, ok(), [alm()]), recargoLlevar: -1 })).toBe('PRECIO_INVALIDO');
  });

  it('almuerzo a CAJA con P = 0 → ALMUERZO_SIN_PRECIO (I-12); cubierto por plan no falla', () => {
    const conP0 = (e: EntradaCobro): EntradaCobro => ({
      ...e,
      precioAlmuerzo: 0,
      items: e.items.map((i) => (i.tipo === 'ALMUERZO' ? { ...i, precioUnitario: 0 } : i)),
    });
    expect(error(conP0(simple('QR', false, sin('SIN_PLAN'), [alm()])))).toBe('ALMUERZO_SIN_PRECIO');
    expect(error(conP0(simple('POS', false, sin('SIN_PLAN'), [alm()])))).toBe('ALMUERZO_SIN_PRECIO');
    verificarInvariantes(cotizar(conP0(simple('QR', false, ok(), [alm()]))), 0);
  });

  it('total que no cabe en un entero seguro', () => {
    expect(error(simple('POS', false, sin('SIN_PLAN'), [libre(Number.MAX_SAFE_INTEGER, 2)]))).toBe('MONTO_NO_SEGURO');
  });

  it('otras entradas inconsistentes', () => {
    expect(error({ ...simple('QR', false, ok(), [alm()]), modoMesa: 'CADA_UNO' })).toBe('MODO_MESA_INVALIDO');
    expect(error({ ...mesa('CADA_UNO', [{ ref: 'A', plan: ok(), items: [] }]), modoMesa: null })).toBe('MODO_MESA_INVALIDO');
    const dos = mesa('CADA_UNO', [
      { ref: 'A', plan: ok(), items: [] },
      { ref: 'B', plan: ok(), items: [] },
    ]);
    expect(error({ ...simple('QR', false, ok(), [alm()]), personas: dos.personas })).toBe('PERSONAS_INVALIDAS');
    expect(error({ ...dos, personas: dos.personas.map((p) => ({ ...p, esAnfitrion: false })) })).toBe('PERSONAS_INVALIDAS');
    const qr = simple('QR', false, ok(), [alm()]);
    expect(error({ ...qr, items: [{ ...qr.items[0], personaRef: 'X' }] })).toBe('PERSONA_DESCONOCIDA');
    expect(error({ ...qr, items: [qr.items[0], qr.items[0]] })).toBe('LINEA_REPETIDA');
    expect(error(simple('QR', false, ok(), [libre(50)]))).toBe('LIBRE_FUERA_DE_POS');
    expect(error(simple('QR', false, ok(), [carta(1, { disponible: false })]))).toBe('DISPONIBLE_FUERA_DE_MESA');
    expect(error(simple('QR', false, ok(), [carta(1, { ofertaId: 'x' })]))).toBe('OFERTA_ID_INESPERADO');
    expect(error(simple('QR', false, ok(), [{ ...almOferta(O2), categoriaBase: 'BEBIDA' }]))).toBe('CATEGORIA_BASE_INVALIDA');
    expect(error(simple('QR', false, ok(), [item('ALMUERZO', P + 1)]))).toBe('PRECIO_ALMUERZO_INCONSISTENTE');
  });
});
