import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LARGO_REF,
  calcularRef,
  configurarRefsMesa,
  opacarCotizacionMesa,
  opacarRefLinea,
  refMiembro,
  subclaveRefs,
} from '../../src/cobro/refs-mesa';

const claveBase = Buffer.alloc(32, 7);

describe('refs opacos de mesa (PR 9)', () => {
  it('ref = base64url(HMAC-SHA256(HMAC-SHA256(claveBase, "bocadoo:ref:v1"), "mesa-ref:v1|mesa|miembro"))[:22]', () => {
    const sub = createHmac('sha256', claveBase).update('bocadoo:ref:v1').digest();
    const esperado = createHmac('sha256', sub).update('mesa-ref:v1|10|57').digest('base64url').slice(0, 22);
    expect(subclaveRefs(claveBase)).toEqual(sub);
    expect(calcularRef(sub, '10', '57')).toBe(esperado);
    expect(esperado).toHaveLength(LARGO_REF);
    expect(esperado).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('determinista; distinto entre miembros, entre mesas y con otra llave', () => {
    const sub = subclaveRefs(claveBase);
    expect(calcularRef(sub, '10', '57')).toBe(calcularRef(sub, '10', '57'));
    expect(calcularRef(sub, '10', '57')).not.toBe(calcularRef(sub, '10', '58'));
    expect(calcularRef(sub, '10', '57')).not.toBe(calcularRef(sub, '11', '57'));
    // Sin ambigüedad por concatenación: "1|23" ≠ "12|3".
    expect(calcularRef(sub, '1', '23')).not.toBe(calcularRef(sub, '12', '3'));
    expect(calcularRef(subclaveRefs(Buffer.alloc(32, 8)), '10', '57')).not.toBe(calcularRef(sub, '10', '57'));
  });

  it('opaca personaRef, pagadorRef y el prefijo de los refs de línea y de aviso; montos y demás campos intactos', () => {
    configurarRefsMesa(claveBase);
    const [a, h] = [refMiembro('10', '57'), refMiembro('10', '55')];
    const cot = {
      estimada: true,
      lineas: [
        { ref: '57:almuerzo#1', personaRef: '57', pagadorRef: '55', subtotalCentavos: 350 },
        { ref: '57:oferta:abc', personaRef: '57', pagadorRef: '55', subtotalCentavos: 200 },
      ],
      porPagador: [{ pagadorRef: '55', saldo: 550 }],
      avisos: [
        { codigo: 'PLAN_NO_ALCANZA', lineaRef: '57:almuerzo' },
        { codigo: 'X', lineaRef: null },
      ],
      totalCentavos: 550,
    };
    expect(opacarCotizacionMesa(cot, '10')).toEqual({
      estimada: true,
      lineas: [
        { ref: `${a}:almuerzo#1`, personaRef: a, pagadorRef: h, subtotalCentavos: 350 },
        { ref: `${a}:oferta:abc`, personaRef: a, pagadorRef: h, subtotalCentavos: 200 },
      ],
      porPagador: [{ pagadorRef: h, saldo: 550 }],
      avisos: [
        { codigo: 'PLAN_NO_ALCANZA', lineaRef: `${a}:almuerzo` },
        { codigo: 'X', lineaRef: null },
      ],
      totalCentavos: 550,
    });
    // La original no cambia.
    expect(cot.lineas[0]!.personaRef).toBe('57');
    // Un ref sin prefijo numérico (pedido, QR) no se toca.
    expect(opacarRefLinea('almuerzo#1', '10')).toBe('almuerzo#1');
    expect(opacarRefLinea('item:abc', '10')).toBe('item:abc');
  });
});
