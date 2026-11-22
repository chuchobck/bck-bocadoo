import { describe, expect, it } from 'vitest';
import type { PlanPersona } from '../../src/billing/tipos';
import { type MiembroParaCobro, type PlatoSuelto, SIN_PLAN, entradaMesa, entradaPedido } from '../../src/cobro/adaptador';
import { type ResultadoDescuento, descontarYRecotizar, estadoPlanDe } from '../../src/cobro/aplicar';
import { deriveKey, huella } from '../../src/common/derive-key';

const P = 350;
const R = 25;
const ok = (disponibles = 5): PlanPersona => ({ estado: 'OK', disponibles });
const cola: PlatoSuelto = { platoId: 'p-cola', nombre: 'Cola', categoria: 'BEBIDA', cantidad: 1, precioUnitario: 100 };
const pedido = (plan: PlanPersona) =>
  entradaPedido({
    precioAlmuerzo: P,
    recargoLlevar: R,
    momentoCobro: 'DESPUES_DE_SERVIR',
    paraLlevar: true,
    conAlmuerzo: true,
    extras: [cola],
    plan,
  });

describe('deriveKey y huella (F.3)', () => {
  const K = '0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10';

  it('deriveKey es determinista, con forma de UUID y distinta por etiqueta', () => {
    expect(deriveKey(K, 'cuenta:0')).toBe(deriveKey(K, 'cuenta:0'));
    expect(deriveKey(K, 'cuenta:0')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveKey(K, 'cuenta:0')).not.toBe(deriveKey(K, 'pago:0'));
    expect(deriveKey(K, 'cuenta:0')).not.toBe(deriveKey('otra', 'cuenta:0'));
  });

  it('huella no depende del orden de las claves ni de los undefined; sí de los valores y del orden de las listas', () => {
    expect(huella({ a: 1, b: { c: 2, d: 3 } })).toBe(huella({ b: { d: 3, c: 2 }, a: 1 }));
    expect(huella({ a: 1, x: undefined })).toBe(huella({ a: 1 }));
    expect(huella({ a: 1 })).not.toBe(huella({ a: 2 }));
    expect(huella({ a: null })).not.toBe(huella({}));
    expect(huella([1, 2])).not.toBe(huella([2, 1]));
    expect(huella({ a: '1' })).not.toBe(huella({ a: 1 }));
    expect(huella('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('estadoPlanDe (resultado de fn_descontar_almuerzo → plan de la cotización)', () => {
  it.each([
    ['OK', 'OK'],
    ['OK_ADVERTENCIA', 'OK'],
    ['SIN_SALDO', 'SIN_SALDO'],
    ['VENCIDO', 'VENCIDO'],
    ['DIA_NO_VALIDO', 'DIA_NO_VALIDO'],
    ['DUPLICADO', 'DUPLICADO'],
    ['algo nuevo', 'SIN_PLAN'],
  ])('%s → %s', (r, e) => expect(estadoPlanDe(r)).toBe(e));
});

describe('descontarYRecotizar', () => {
  it('descuento OK: cotización final (estimada: false) con el almuerzo cubierto y el consumo devuelto', async () => {
    const llamadas: number[] = [];
    const { cotizacion, consumos } = await descontarYRecotizar(pedido(ok(1)), async (_u, i) => {
      llamadas.push(i);
      return { estado: 'OK', consumoId: '77' };
    });
    expect(llamadas).toEqual([0]);
    expect(consumos).toEqual(['77']);
    expect(cotizacion).toMatchObject({ estimada: false, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: 100 + R });
  });

  it.each([
    ['SIN_SALDO', { estado: 'SIN_SALDO', consumoId: null }],
    ['VENCIDO', { estado: 'VENCIDO', consumoId: null }],
    ['OK sin consumo (no debería pasar): como sin saldo', { estado: 'OK', consumoId: null }],
  ] as [string, ResultadoDescuento][])('la base responde %s: el almuerzo va a caja a P', async (_n, r) => {
    const { cotizacion, consumos } = await descontarYRecotizar(pedido(ok(1)), async () => r);
    expect(consumos).toEqual([]);
    expect(cotizacion).toMatchObject({ estimada: false, cubiertoPorPlanCentavos: 0, saldoPorCobrarCentavos: P + 100 + R });
    expect(cotizacion.lineas[0]).toMatchObject({ tipo: 'ALMUERZO', fuente: 'CAJA' });
  });

  it('sin plan no llama a la base', async () => {
    let llamadas = 0;
    const { cotizacion } = await descontarYRecotizar(pedido(SIN_PLAN), async () => {
      llamadas++;
      return { estado: 'OK', consumoId: '1' };
    });
    expect(llamadas).toBe(0);
    expect(cotizacion.saldoPorCobrarCentavos).toBe(P + 100 + R);
  });

  it('la unidad que descuenta es la del pagador "0" y un error de la base corta todo (la transacción se deshace)', async () => {
    const unidades: unknown[] = [];
    await descontarYRecotizar(pedido(ok(2)), async (u) => {
      unidades.push(u);
      return { estado: 'OK', consumoId: '1' };
    });
    expect(unidades).toEqual([{ personaRef: '0', pagadorRef: '0' }]);
    await expect(
      descontarYRecotizar(pedido(ok(2)), async () => {
        throw new Error('se cayó la base');
      }),
    ).rejects.toThrow('se cayó la base');
  });

  describe('mesa INVITO_YO: el plan del anfitrión paga en orden y la base manda (B.3 paso 5)', () => {
    const miembro = (ref: string, extra: Partial<MiembroParaCobro> = {}): MiembroParaCobro => ({
      ref,
      esAnfitrion: ref === 'h',
      paraLlevar: false,
      plan: SIN_PLAN,
      seleccion: null,
      ...extra,
    });
    const mesa = (plan: PlanPersona) =>
      entradaMesa({
        modo: 'INVITO_YO',
        base: 'seleccion',
        precioAlmuerzo: P,
        recargoLlevar: R,
        momentoCobro: 'DESPUES_DE_SERVIR',
        miembros: [miembro('h', { plan }), miembro('g1'), miembro('g2', { paraLlevar: true }), miembro('g3')],
      });
    const almuerzos = (c: { lineas: { personaRef: string; tipo: string; fuente: string; omitida: string | null }[] }) =>
      c.lineas.filter((l) => l.tipo === 'ALMUERZO').map((l) => [l.personaRef, l.fuente, l.omitida]);

    it('G-31: con 2 almuerzos y la base diciendo SIN_SALDO al tercero, los dos últimos van a caja con PLAN_NO_ALCANZA', async () => {
      const r = await descontarYRecotizar(mesa(ok(5)), async (_u, i) =>
        i < 2 ? { estado: 'OK', consumoId: String(i + 1) } : { estado: 'SIN_SALDO', consumoId: null },
      );
      expect(r.consumos).toEqual(['1', '2']);
      expect(almuerzos(r.cotizacion)).toEqual([
        ['h', 'PLAN', null],
        ['g1', 'PLAN', null],
        ['g2', 'CAJA', null],
        ['g3', 'CAJA', null],
      ]);
      expect(r.cotizacion).toMatchObject({
        subtotalCentavos: 4 * P,
        recargoCentavos: R,
        cubiertoPorPlanCentavos: 2 * P,
        saldoPorCobrarCentavos: 2 * P + R,
      });
      expect(r.cotizacion.avisos.map((a) => a.codigo)).toContain('PLAN_NO_ALCANZA');
    });

    it('LIMITE_SAAS a mitad de la mesa: las unidades que quedan se omiten, no se cobran a precio suelto (I-10)', async () => {
      let llamadas = 0;
      const r = await descontarYRecotizar(mesa(ok(5)), async () =>
        ++llamadas <= 2 ? { estado: 'OK', consumoId: String(llamadas) } : { estado: 'LIMITE_SAAS', consumoId: null },
      );
      // Tras el primer rechazo ya no se intenta otra unidad del mismo pagador.
      expect(llamadas).toBe(3);
      expect(almuerzos(r.cotizacion)).toEqual([
        ['h', 'PLAN', null],
        ['g1', 'PLAN', null],
        ['g2', 'CAJA', 'LIMITE_SAAS'],
        ['g3', 'CAJA', 'LIMITE_SAAS'],
      ]);
      expect(r.cotizacion).toMatchObject({ subtotalCentavos: 2 * P, recargoCentavos: 0, saldoPorCobrarCentavos: 0 });
      expect(r.cotizacion.avisos.map((a) => a.codigo)).toEqual(['LIMITE_SAAS', 'LIMITE_SAAS']);
    });

    it('LIMITE_SAAS en la primera unidad: todo omitido, nada por cobrar', async () => {
      const r = await descontarYRecotizar(mesa(ok(5)), async () => ({ estado: 'LIMITE_SAAS', consumoId: null }));
      expect(r.consumos).toEqual([]);
      expect(r.cotizacion.saldoPorCobrarCentavos).toBe(0);
      expect(almuerzos(r.cotizacion).every(([, , o]) => o === 'LIMITE_SAAS')).toBe(true);
    });
  });
});
