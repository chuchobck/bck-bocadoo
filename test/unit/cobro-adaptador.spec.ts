import { describe, expect, it } from 'vitest';
import { cotizar } from '../../src/billing/cotizar';
import type { PlanPersona } from '../../src/billing/tipos';
import {
  type MiembroParaCobro,
  type MesaParaCobro,
  type PlatoSuelto,
  SIN_PLAN,
  aRespuesta,
  cotizacionesDeMesa,
  entradaPedido,
  entradaPedidoCreado,
  planDesdeFilas,
  tipoDePlato,
} from '../../src/cobro/adaptador';

const P = 350;
const R = 25;
const ok = (disponibles = 5): PlanPersona => ({ estado: 'OK', disponibles });
const precios = { recargoLlevar: R, momentoCobro: 'ANTES_DE_SERVIR' as const };
const plato = (nombre: string, categoria: PlatoSuelto['categoria'], precioUnitario: number, cantidad = 1): PlatoSuelto => ({
  platoId: `p-${nombre}`,
  nombre,
  categoria,
  cantidad,
  precioUnitario,
});

describe('planDesdeFilas (misma condición que fn_descontar_almuerzo)', () => {
  const base = { disponibles: 0, hayActivaVigente: false, hayVencidaConSaldo: false, hayPlan: false };
  it.each([
    ['sin ficha ni filas', null, { estado: 'SIN_PLAN', disponibles: 0 }],
    ['sin ningún plan', base, { estado: 'SIN_PLAN', disponibles: 0 }],
    ['saldo que vale hoy', { ...base, disponibles: 3, hayActivaVigente: true, hayPlan: true }, { estado: 'OK', disponibles: 3 }],
    // ACTIVA y vigente, pero hoy no es uno de sus días: el saldo no cuenta (INC-12).
    ['activa pero hoy no es día válido', { ...base, hayActivaVigente: true, hayPlan: true }, { estado: 'DIA_NO_VALIDO', disponibles: 0 }],
    ['vencido con saldo', { ...base, hayVencidaConSaldo: true, hayPlan: true }, { estado: 'VENCIDO', disponibles: 0 }],
    ['solo planes agotados', { ...base, hayPlan: true }, { estado: 'SIN_SALDO', disponibles: 0 }],
  ])('%s', (_n, filas, esperado) => {
    expect(planDesdeFilas(filas)).toEqual(esperado);
  });
});

describe('tipoDePlato', () => {
  it('un plato ALMUERZO pedido suelto se mapea por sección (B.3 paso 1)', () => {
    expect(tipoDePlato('ALMUERZO', 'JUGO')).toBe('BEBIDA');
    expect(tipoDePlato('ALMUERZO', 'POSTRE')).toBe('EXTRA');
    expect(tipoDePlato('ALMUERZO', 'SOPA')).toBe('A_LA_CARTA');
    expect(tipoDePlato('ALMUERZO', 'FUERTE')).toBe('A_LA_CARTA');
    expect(tipoDePlato('ALMUERZO', 'ADICIONAL')).toBe('A_LA_CARTA');
    expect(tipoDePlato('ALMUERZO', null)).toBe('A_LA_CARTA');
    expect(tipoDePlato('EXTRA')).toBe('EXTRA');
    expect(tipoDePlato('BEBIDA')).toBe('BEBIDA');
    expect(tipoDePlato('A_LA_CARTA', 'JUGO')).toBe('A_LA_CARTA');
  });

  it.each([
    ['jugo para llevar: sin recargo', 'JUGO', 0],
    ['postre para llevar: sin recargo', 'POSTRE', 0],
    ['fuerte suelto para llevar: con recargo', 'FUERTE', R],
    ['sopa suelta para llevar: con recargo', 'SOPA', R],
  ])('%s', (_n, seccion, recargo) => {
    const c = cotizar(
      entradaPedido({
        ...precios,
        precioAlmuerzo: P,
        paraLlevar: true,
        conAlmuerzo: false,
        extras: [{ ...plato('Suelto', 'ALMUERZO', 300), seccion }],
        plan: SIN_PLAN,
      }),
    );
    expect(c.recargoCentavos).toBe(recargo);
  });
});

describe('entradaPedido (PREORDEN)', () => {
  const base = { ...precios, precioAlmuerzo: P, paraLlevar: false, conAlmuerzo: true, extras: [], plan: ok(2) };

  it('almuerzo cubierto por el plan: cubierto P, saldo 0, siempre estimada', () => {
    const c = cotizar(entradaPedido(base));
    expect(c).toMatchObject({ estimada: true, subtotalCentavos: P, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: 0 });
    expect(c.lineas.map((l) => [l.tipo, l.fuente])).toEqual([['ALMUERZO', 'PLAN']]);
  });

  it.each([
    ['sin plan', SIN_PLAN],
    ['sin saldo', { estado: 'SIN_SALDO', disponibles: 0 }],
    ['día no válido', { estado: 'DIA_NO_VALIDO', disponibles: 0 }],
    ['vencido', { estado: 'VENCIDO', disponibles: 0 }],
  ] as [string, PlanPersona][])('plan %s: el almuerzo va a caja a precio suelto', (_n, plan) => {
    const c = cotizar(entradaPedido({ ...base, plan }));
    expect(c).toMatchObject({ cubiertoPorPlanCentavos: 0, saldoPorCobrarCentavos: P });
    expect(c.lineas[0]).toMatchObject({ fuente: 'CAJA', porCobrarCentavos: P });
  });

  it('para llevar: recargo al almuerzo; el extra EXTRA y la BEBIDA no pagan', () => {
    const c = cotizar(
      entradaPedido({ ...base, plan: SIN_PLAN, paraLlevar: true, extras: [plato('Huevo', 'EXTRA', 75), plato('Cola', 'BEBIDA', 100)] }),
    );
    expect(c).toMatchObject({ subtotalCentavos: 525, recargoCentavos: R, totalCentavos: 550, saldoPorCobrarCentavos: 550 });
  });

  it('un extra A_LA_CARTA para llevar paga recargo por unidad (D2): es el caso que difiere de totalCentavos hasta el PR 7', () => {
    const c = cotizar(entradaPedido({ ...base, plan: SIN_PLAN, paraLlevar: true, extras: [plato('Ceviche', 'A_LA_CARTA', 600, 2)] }));
    expect(c.recargoCentavos).toBe(R * 3); // 1 almuerzo + 2 ceviches
  });

  it('el mismo plato en dos renglones no repite refs', () => {
    expect(() => cotizar(entradaPedido({ ...base, extras: [plato('Cola', 'BEBIDA', 100), plato('Cola', 'BEBIDA', 100)] }))).not.toThrow();
  });

  it('solo extras: sin línea de almuerzo ni plan', () => {
    const c = cotizar(entradaPedido({ ...base, conAlmuerzo: false, extras: [plato('Cola', 'BEBIDA', 100)] }));
    expect(c.lineas).toHaveLength(1);
    expect(c.unidadesPlan).toEqual([]);
  });
});

describe('entradaPedidoCreado (el precio del almuerzo es subtotal − extras)', () => {
  const base = { ...precios, paraLlevar: false, conAlmuerzo: true, plan: SIN_PLAN };

  it('almuerzo cobrado: P sale del subtotal', () => {
    const c = cotizar(
      entradaPedidoCreado({ ...base, subtotal: 350 + 175, extras: [plato('Huevo', 'EXTRA', 75, 1), plato('Cola', 'BEBIDA', 100, 1)] }),
    );
    expect(c.lineas[0]).toMatchObject({ tipo: 'ALMUERZO', precioUnitarioCentavos: 350, fuente: 'CAJA' });
    expect(c.saldoPorCobrarCentavos).toBe(525);
  });

  it('almuerzo guardado en 0 (lo cubrió el plan al pedir): sigue cubierto aunque el plan ya se haya gastado', () => {
    const c = cotizar(entradaPedidoCreado({ ...base, subtotal: 75, extras: [plato('Huevo', 'EXTRA', 75)], plan: SIN_PLAN }));
    expect(c.lineas.find((l) => l.tipo === 'ALMUERZO')).toMatchObject({ fuente: 'PLAN', precioUnitarioCentavos: 0, porCobrarCentavos: 0 });
    expect(c.saldoPorCobrarCentavos).toBe(75); // = totalCentavos guardado
  });

  it('coincide con la regla de hoy (totalCentavos) cuando no hay platos A_LA_CARTA', () => {
    // Regla de hoy: recargo = R si hay almuerzo y es para llevar; los extras no pagan.
    const c = cotizar(entradaPedidoCreado({ ...base, paraLlevar: true, subtotal: 350 + 75, extras: [plato('Huevo', 'EXTRA', 75)] }));
    expect(c.recargoCentavos).toBe(R);
    expect(c.saldoPorCobrarCentavos).toBe(350 + 75 + R);
  });

  it('solo extras para llevar: sin recargo (hoy tampoco hay)', () => {
    const c = cotizar(
      entradaPedidoCreado({ ...base, paraLlevar: true, conAlmuerzo: false, subtotal: 100, extras: [plato('Cola', 'BEBIDA', 100)] }),
    );
    expect(c.recargoCentavos).toBe(0);
  });
});

describe('cotizacionesDeMesa', () => {
  const miembro = (ref: string, o: Partial<MiembroParaCobro> = {}): MiembroParaCobro => ({
    ref,
    esAnfitrion: ref === 'h',
    paraLlevar: false,
    plan: SIN_PLAN,
    seleccion: null,
    ...o,
  });
  const mesa = (modo: MesaParaCobro['modo'], miembros: MiembroParaCobro[], base: MesaParaCobro['base'] = 'seleccion'): MesaParaCobro => ({
    modo,
    base,
    miembros,
    precioAlmuerzo: P,
    ...precios,
  });

  it('CADA_UNO: cada miembro con su plan; sin selección cuenta 1 almuerzo (I-4)', () => {
    const r = cotizacionesDeMesa(mesa('CADA_UNO', [miembro('h', { plan: ok(1) }), miembro('a'), miembro('b', { paraLlevar: true })]));
    expect(r.porMiembro.get('h')).toMatchObject({ subtotalCentavos: P, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: 0 });
    expect(r.porMiembro.get('a')).toMatchObject({ saldoPorCobrarCentavos: P });
    expect(r.porMiembro.get('b')).toMatchObject({ recargoCentavos: R, saldoPorCobrarCentavos: P + R }); // su propio paraLlevar
    expect(r.mesa).toMatchObject({
      subtotalCentavos: 3 * P,
      recargoCentavos: R,
      cubiertoPorPlanCentavos: P,
      saldoPorCobrarCentavos: 2 * P + R,
    });
  });

  it('INVITO_YO: paga el anfitrión; su plan cubre primero al anfitrión y luego a los invitados por orden', () => {
    const r = cotizacionesDeMesa(mesa('INVITO_YO', [miembro('h', { plan: ok(2) }), miembro('a'), miembro('b')]));
    expect(r.porMiembro.get('h')!.lineas[0]).toMatchObject({ fuente: 'PLAN', pagador: 'PROPIO' });
    expect(r.porMiembro.get('a')!.lineas[0]).toMatchObject({ fuente: 'PLAN', pagador: 'ANFITRION', pagadorRef: 'h' });
    expect(r.porMiembro.get('b')!.lineas[0]).toMatchObject({ fuente: 'CAJA', pagador: 'ANFITRION' });
    expect(r.mesa!.avisos).toEqual([{ codigo: 'PLAN_NO_ALCANZA', lineaRef: 'b:almuerzo' }]);
    expect(r.porMiembro.get('b')!.avisos).toEqual([{ codigo: 'PLAN_NO_ALCANZA', lineaRef: 'b:almuerzo' }]);
    expect(r.porMiembro.get('a')!.avisos).toEqual([]);
    expect(r.mesa!.porPagador).toHaveLength(1);
  });

  it('con selección se cotiza lo elegido; solo extras no suma almuerzo', () => {
    const r = cotizacionesDeMesa(
      mesa('CADA_UNO', [
        miembro('h', { seleccion: { almuerzo: true, extras: [plato('Cola', 'BEBIDA', 100, 2)] } }),
        miembro('a', { seleccion: { almuerzo: false, extras: [plato('Huevo', 'EXTRA', 75)] } }),
      ]),
    );
    expect(r.porMiembro.get('h')).toMatchObject({ subtotalCentavos: P + 200 });
    expect(r.porMiembro.get('a')!.lineas.map((l) => l.tipo)).toEqual(['EXTRA']);
    expect(r.porMiembro.get('a')).toMatchObject({ subtotalCentavos: 75 });
  });

  it("base 'un-almuerzo' (E.5) ignora la selección: 1 almuerzo y su paraLlevar", () => {
    const r = cotizacionesDeMesa(
      mesa(
        'CADA_UNO',
        [miembro('h', { paraLlevar: true, seleccion: { almuerzo: false, extras: [plato('Cola', 'BEBIDA', 100)] } }), miembro('a')],
        'un-almuerzo',
      ),
    );
    expect(r.porMiembro.get('h')!.lineas.map((l) => l.tipo)).toEqual(['ALMUERZO']);
    expect(r.mesa).toMatchObject({ subtotalCentavos: 2 * P, recargoCentavos: R });
  });

  it('un plato agotado se omite; un almuerzo con un plato agotado solo avisa', () => {
    const cola = { ...plato('Cola', 'BEBIDA', 100), disponible: false };
    const r = cotizacionesDeMesa(
      mesa('CADA_UNO', [miembro('h', { seleccion: { almuerzo: true, almuerzoAgotado: true, extras: [cola] } })]),
    );
    const l = r.porMiembro.get('h')!;
    expect(l.lineas.find((x) => x.tipo === 'BEBIDA')).toMatchObject({ omitida: 'PLATO_AGOTADO', subtotalCentavos: 0 });
    expect(l.lineas.find((x) => x.tipo === 'ALMUERZO')).toMatchObject({ omitida: null, subtotalCentavos: P });
    expect(l.avisos.map((a) => a.codigo)).toEqual(['PLATO_AGOTADO', 'PLATO_AGOTADO']);
  });

  it('plan ilegible (null): ese miembro y la mesa quedan en null; los legibles se cotizan', () => {
    const r = cotizacionesDeMesa(mesa('CADA_UNO', [miembro('h', { plan: ok(1) }), miembro('a', { plan: null })]));
    expect(r.porMiembro.get('h')).not.toBeNull();
    expect(r.porMiembro.get('a')).toBeNull();
    expect(r.mesa).toBeNull();
  });

  it('INVITO_YO con el plan del anfitrión ilegible: todos null', () => {
    const r = cotizacionesDeMesa(mesa('INVITO_YO', [miembro('h', { plan: null }), miembro('a')]));
    expect([...r.porMiembro.values()]).toEqual([null, null]);
    expect(r.mesa).toBeNull();
  });

  it('invariantes: la suma de las cotizaciones por miembro es la de la mesa', () => {
    const r = cotizacionesDeMesa(
      mesa('INVITO_YO', [
        miembro('h', { plan: ok(1), paraLlevar: true }),
        miembro('a', { paraLlevar: true, seleccion: { almuerzo: true, extras: [plato('Ceviche', 'A_LA_CARTA', 600)] } }),
        miembro('b'),
      ]),
    );
    const partes = [...r.porMiembro.values()].map((c) => c!);
    for (const campo of [
      'subtotalCentavos',
      'recargoCentavos',
      'totalCentavos',
      'cubiertoPorPlanCentavos',
      'saldoPorCobrarCentavos',
    ] as const)
      expect(
        partes.reduce((s, c) => s + c[campo], 0),
        campo,
      ).toBe(r.mesa![campo]);
    for (const c of partes) expect(c.saldoPorCobrarCentavos).toBe(c.totalCentavos - c.cubiertoPorPlanCentavos);
  });
});

describe('aRespuesta', () => {
  it('agrega la moneda y no expone unidadesPlan', () => {
    const c = cotizar(entradaPedido({ ...precios, precioAlmuerzo: P, paraLlevar: false, conAlmuerzo: true, extras: [], plan: ok(1) }));
    expect(c.unidadesPlan).toHaveLength(1);
    const r = aRespuesta(c, 'USD');
    expect(r).not.toHaveProperty('unidadesPlan');
    expect(r.monedaCodigo).toBe('USD');
    expect(r.estimada).toBe(true);
  });
});
