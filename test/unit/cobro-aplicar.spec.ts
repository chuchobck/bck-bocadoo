import { describe, expect, it } from 'vitest';
import type { PlanPersona } from '../../src/billing/tipos';
import { type PlatoSuelto, SIN_PLAN, entradaPedido } from '../../src/cobro/adaptador';
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
});
