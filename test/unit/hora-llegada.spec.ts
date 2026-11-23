import { describe, expect, it } from 'vitest';
import { BusinessError, problemCode } from '../../src/common/errors';
import { ARRIVAL_WINDOW, horaLlegadaEnVentana } from '../../src/common/hora-llegada';

describe('ventana de la hora de llegada (mesas y pedidos)', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('acepta los bordes: 5 minutos atrás y 12 horas adelante', () => {
    expect(horaLlegadaEnVentana(at(-ARRIVAL_WINDOW.pastMs), now).getTime()).toBe(now - ARRIVAL_WINDOW.pastMs);
    expect(horaLlegadaEnVentana(at(ARRIVAL_WINDOW.futureMs), now).getTime()).toBe(now + ARRIVAL_WINDOW.futureMs);
    expect(ARRIVAL_WINDOW).toEqual({ pastMs: 5 * 60_000, futureMs: 12 * 3_600_000 });
  });

  it.each([
    ['más de 5 minutos atrás', at(-ARRIVAL_WINDOW.pastMs - 1)],
    ['más de 12 horas adelante', at(ARRIVAL_WINDOW.futureMs + 1)],
    ['no es una fecha', 'mañana'],
  ])('%s → 400 HORA_LLEGADA_INVALIDA', (_, iso) => {
    try {
      horaLlegadaEnVentana(iso, now);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessError);
      expect((e as BusinessError).getStatus()).toBe(400);
      expect(problemCode(400, (e as BusinessError).getResponse())).toBe('HORA_LLEGADA_INVALIDA');
    }
  });
});
