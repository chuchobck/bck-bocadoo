import { HttpStatus, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QrSecretService } from '../../src/auth/qr-secret.service';
import { CheckoutService } from '../../src/checkout/checkout';
import { BusinessError } from '../../src/common/errors';
import type { DbService, Queryable } from '../../src/db/db.service';
import { PassEventBus, type CanjeRegistrado, type PassEvent } from '../../src/pass-events/bus';
import { PassStreamHub, type PassStreamLimits, type SseSink } from '../../src/pass-events/stream';

// Los avisos de suscriptor roto y conexión lenta son esperados aquí.
Logger.overrideLogger(false);

const canje = (consumoId = 'c1', saldoRestante = 4): CanjeRegistrado => ({
  tipo: 'CANJE_REGISTRADO',
  consumoId,
  restauranteNombre: 'La Sazón',
  saldoRestante,
  platoNombre: null,
  hora: '2026-11-18T17:00:00.000Z',
});

describe('PassEventBus', () => {
  it('entrega el evento solo a los suscriptores de ese usuario', () => {
    const bus = new PassEventBus();
    const a: PassEvent[] = [];
    const b: PassEvent[] = [];
    bus.subscribe('1', (e) => a.push(e));
    bus.subscribe('2', (e) => b.push(e));
    expect(bus.publish('1', canje())).toBe(1);
    expect(a).toEqual([canje()]);
    expect(b).toEqual([]);
    expect(bus.publish('3', canje())).toBe(0); // nadie escuchando: no falla
  });

  it('darse de baja limpia la suscripción; un suscriptor que lanza no corta a los demás', () => {
    const bus = new PassEventBus();
    const got: PassEvent[] = [];
    const off = bus.subscribe('1', () => {
      throw new Error('roto');
    });
    bus.subscribe('1', (e) => got.push(e));
    bus.publish('1', canje());
    expect(got).toHaveLength(1);
    off();
    off(); // idempotente
    expect(bus.listenerCount('1')).toBe(1);
  });

  it('pending(): nada sale hasta flush(); flush() publica una sola vez; un cliente sin cuenta (null) se ignora', () => {
    const bus = new PassEventBus();
    const got: PassEvent[] = [];
    bus.subscribe('1', (e) => got.push(e));
    const p = bus.pending();
    p.add('1', canje());
    p.add(null, canje('sin-cuenta'));
    expect(p.size).toBe(1);
    expect(got).toEqual([]);
    p.flush();
    p.flush();
    expect(got).toEqual([canje()]);
  });
});

/** DbService falso: corre la "transacción" sobre respuestas armadas por SQL y puede fallar en el COMMIT. */
function fakeDb(rows: (sql: string) => unknown[], commit: 'ok' | 'falla') {
  const q: Queryable = {
    query: (async (sql: string) => {
      const r = rows(sql);
      return { rows: r, rowCount: r.length };
    }) as Queryable['query'],
  };
  return {
    forRequest: async <T>(fn: (q: Queryable) => Promise<T>) => {
      const result = await fn(q);
      if (commit === 'falla') throw new Error('could not serialize access (COMMIT)');
      return result;
    },
  } as unknown as DbService;
}

describe('CheckoutService: eventos solo después del COMMIT', () => {
  const undoRows = (sql: string) => {
    if (sql.includes('AS viejo')) return [{ consumo_id: '7', cantidad: 1, viejo: false, revertido: false }];
    if (sql.includes('AS saldo')) return [{ usuario_id: '42', restaurante_nombre: 'La Sazón', saldo: 5, hora: new Date() }];
    // El consumo no es parte de ninguna cuenta de cobro (como los consumos de antes de la entrega D).
    if (sql.includes('FROM cuenta_cobro_linea')) return [];
    return [{}];
  };

  it('deshacer con COMMIT exitoso → CANJE_REVERTIDO al comensal dueño del consumo', async () => {
    const bus = new PassEventBus();
    const got: PassEvent[] = [];
    bus.subscribe('42', (e) => got.push(e));
    const svc = new CheckoutService(fakeDb(undoRows, 'ok'), {} as QrSecretService, bus);
    await svc.undo('0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10');
    expect(got).toEqual([
      expect.objectContaining({ tipo: 'CANJE_REVERTIDO', consumoId: '0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10', saldoRestante: 5 }),
    ]);
  });

  it('si la transacción falla (aun en el COMMIT) no se emite nada', async () => {
    const bus = new PassEventBus();
    const got: PassEvent[] = [];
    bus.subscribe('42', (e) => got.push(e));
    const svc = new CheckoutService(fakeDb(undoRows, 'falla'), {} as QrSecretService, bus);
    await expect(svc.undo('0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10')).rejects.toThrow(/COMMIT/);
    expect(got).toEqual([]);
  });

  const deductRows = (nuevo: boolean) => (sql: string) => {
    if (sql.includes('fn_descontar_almuerzo'))
      return [{ resultado: 'OK', consumo_id: '9', almuerzos_restantes_total: 3, dias_para_vencer: 5 }];
    if (sql.includes('AS nuevo'))
      return [
        {
          public_id: 'consumo-uuid',
          creado_en: new Date('2026-11-18T17:00:00Z'),
          nombre_plan: 'Semanal',
          vence_el: '2026-11-25',
          nuevo,
          usuario_id: '42',
          restaurante_nombre: 'La Sazón',
        },
      ];
    return [];
  };
  const args = { clienteId: '1', personalId: '1', key: 'k', canal: 'QR', paraLlevar: false };

  it('deduct junta CANJE_REGISTRADO con el saldo restante; un reintento idempotente (consumo viejo) no lo repite', async () => {
    const bus = new PassEventBus();
    const got: PassEvent[] = [];
    bus.subscribe('42', (e) => got.push(e));
    const svc = new CheckoutService({} as DbService, {} as QrSecretService, bus);
    const q = (rows: (s: string) => unknown[]): Queryable => ({
      query: (async (s: string) => ({ rows: rows(s), rowCount: 1 })) as Queryable['query'],
    });

    const eventos = bus.pending();
    await svc.deduct(q(deductRows(true)), { ...args, eventos, platoNombre: 'Seco de pollo' });
    expect(got).toEqual([]); // todavía dentro de la transacción
    eventos.flush();
    expect(got).toEqual([
      {
        tipo: 'CANJE_REGISTRADO',
        consumoId: 'consumo-uuid',
        restauranteNombre: 'La Sazón',
        saldoRestante: 3,
        platoNombre: 'Seco de pollo',
        hora: '2026-11-18T17:00:00.000Z',
      },
    ]);

    const replay = bus.pending();
    await svc.deduct(q(deductRows(false)), { ...args, eventos: replay });
    expect(replay.size).toBe(0);
  });
});

/** Respuesta SSE falsa: guarda lo escrito. */
class FakeSink implements SseSink {
  chunks: string[] = [];
  ended = false;
  pending = 0;
  write(c: string) {
    if (this.ended) throw new Error('write after end');
    this.chunks.push(c);
  }
  end() {
    this.ended = true;
  }
  get text() {
    return this.chunks.join('');
  }
  events(name: string) {
    return [...this.text.matchAll(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`, 'g'))].map((m) => JSON.parse(m[1]!) as unknown);
  }
}

describe('PassStreamHub', () => {
  const limits: PassStreamLimits = { perUser: 2, total: 3, heartbeatMs: 20_000, retryMs: 5_000 };
  let bus: PassEventBus;
  let hub: PassStreamHub;
  beforeEach(() => {
    vi.useFakeTimers();
    bus = new PassEventBus();
    hub = new PassStreamHub(bus, limits);
  });
  afterEach(() => {
    hub.onModuleDestroy();
    vi.useRealTimers();
  });

  it('al abrir indica retry y entrega los eventos del usuario', () => {
    const s = new FakeSink();
    hub.open('1', s);
    expect(s.text.startsWith('retry: 5000\n')).toBe(true);
    bus.publish('1', canje());
    expect(s.events('CANJE_REGISTRADO')).toEqual([canje()]);
  });

  it('aislamiento: los eventos de un comensal no llegan a la conexión de otro', () => {
    const a = new FakeSink();
    const b = new FakeSink();
    hub.open('1', a);
    hub.open('2', b);
    bus.publish('1', canje('de-a'));
    bus.publish('2', canje('de-b'));
    expect(a.events('CANJE_REGISTRADO')).toEqual([canje('de-a')]);
    expect(b.events('CANJE_REGISTRADO')).toEqual([canje('de-b')]);
  });

  it('máximo 2 por usuario: la 3.ª cierra la más vieja con FIN REEMPLAZADA (y retry largo)', () => {
    const [s1, s2, s3] = [new FakeSink(), new FakeSink(), new FakeSink()];
    hub.open('1', s1);
    hub.open('1', s2);
    hub.open('1', s3);
    expect(s1.ended).toBe(true);
    expect(s1.events('FIN')).toEqual([{ motivo: 'REEMPLAZADA' }]);
    expect(s1.text).toContain('retry: 60000\n');
    expect([s2.ended, s3.ended]).toEqual([false, false]);
    expect(hub.connectionsOf('1')).toBe(2);
    expect(bus.listenerCount('1')).toBe(2);
    bus.publish('1', canje());
    expect(s1.events('CANJE_REGISTRADO')).toEqual([]);
    expect(s3.events('CANJE_REGISTRADO')).toEqual([canje()]);
  });

  it('tope global: 503 EVENTOS_SATURADO, salvo que reemplace una conexión del mismo usuario', () => {
    hub.open('1', new FakeSink());
    hub.open('1', new FakeSink());
    hub.open('2', new FakeSink());
    expect(hub.size).toBe(3);
    let err: unknown;
    try {
      hub.open('3', new FakeSink());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BusinessError);
    expect((err as BusinessError).code).toBe('EVENTOS_SATURADO');
    expect((err as BusinessError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(() => hub.open('1', new FakeSink())).not.toThrow(); // reemplaza: el total no sube
    expect(hub.size).toBe(3);
  });

  it('latido cada 20 s; al cerrar se limpian timers y suscripción', () => {
    const s = new FakeSink();
    const close = hub.open('1', s);
    vi.advanceTimersByTime(19_999);
    expect(s.events('LATIDO')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(s.events('LATIDO')).toHaveLength(1);
    vi.advanceTimersByTime(40_000);
    expect(s.events('LATIDO')).toHaveLength(3);
    close();
    close(); // idempotente (el socket avisa 'close' también tras nuestro end)
    expect(s.ended).toBe(true);
    expect(bus.listenerCount()).toBe(0);
    expect(hub.size).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(s.events('LATIDO')).toHaveLength(3);
  });

  it('al vencer el token cierra con FIN TOKEN_VENCIDO', () => {
    const s = new FakeSink();
    hub.open('1', s, Date.now() + 5_000);
    vi.advanceTimersByTime(5_000);
    expect(s.events('FIN')).toEqual([{ motivo: 'TOKEN_VENCIDO' }]);
    expect(s.ended).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('un cliente que no lee (buffer lleno) se corta', () => {
    const s = new FakeSink();
    hub.open('1', s);
    s.pending = 1024 * 1024;
    bus.publish('1', canje());
    expect(s.ended).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('al apagar: FIN APAGADO a todas y no acepta nuevas', () => {
    const [a, b] = [new FakeSink(), new FakeSink()];
    hub.open('1', a);
    hub.open('2', b);
    hub.onModuleDestroy();
    expect(a.events('FIN')).toEqual([{ motivo: 'APAGADO' }]);
    expect(b.ended).toBe(true);
    expect(hub.size).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    expect(() => hub.open('3', new FakeSink())).toThrow(BusinessError);
  });
});
