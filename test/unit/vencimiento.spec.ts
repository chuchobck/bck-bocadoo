import { describe, expect, it } from 'vitest';
import { PREORDER_MINUTES, venceEn } from '../../src/orders/vencimiento';

describe('venceEn = max(creadoEn, horaLlegada) + 30 min', () => {
  const creado = new Date('2026-11-22T11:00:00Z');
  const min = (m: number) => new Date(creado.getTime() + m * 60_000);

  it('sin hora de llegada: creadoEn + 30 min (como antes)', () => {
    expect(PREORDER_MINUTES).toBe(30);
    expect(venceEn(creado, null)).toEqual(min(30));
  });

  it('hora futura: vence 30 min después de la llegada', () => {
    expect(venceEn(creado, min(120))).toEqual(min(150));
  });

  it('hora pasada dentro de la ventana de 5 min: no acorta el plazo', () => {
    expect(venceEn(creado, min(-5))).toEqual(min(30));
    expect(venceEn(creado, min(-1))).toEqual(min(30));
  });

  it('hora igual a la creación: creadoEn + 30 min', () => {
    expect(venceEn(creado, min(0))).toEqual(min(30));
  });

  it('no muta sus argumentos', () => {
    const h = min(10);
    venceEn(creado, h);
    expect(creado).toEqual(new Date('2026-11-22T11:00:00Z'));
    expect(h).toEqual(min(10));
  });
});
