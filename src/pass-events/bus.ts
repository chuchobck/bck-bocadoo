import { Injectable, Logger } from '@nestjs/common';

/** Se descontó un almuerzo del plan del comensal (QR, manual, mesa o preorden). */
export interface CanjeRegistrado {
  tipo: 'CANJE_REGISTRADO';
  /** public_id del consumo. */
  consumoId: string;
  restauranteNombre: string;
  /** Almuerzos que le quedan en ese restaurante, sumando sus planes vigentes, después del canje. */
  saldoRestante: number;
  /** Platos de la preorden; null en un canje directo. */
  platoNombre: string | null;
  /** Instante del canje (ISO 8601, UTC). */
  hora: string;
}

/** La caja deshizo un canje: el almuerzo volvió al plan. */
export interface CanjeRevertido {
  tipo: 'CANJE_REVERTIDO';
  /** public_id del consumo original (el que se deshizo). */
  consumoId: string;
  restauranteNombre: string;
  saldoRestante: number;
  /** Instante del reverso (ISO 8601, UTC). */
  hora: string;
}

export type PassEvent = CanjeRegistrado | CanjeRevertido;
export type PassEventListener = (event: PassEvent) => void;

/**
 * Eventos juntados durante una transacción. Se crean con `PassEventBus.pending()` y no salen hasta `flush()`, que se
 * llama **después** de `await db.forRequest(...)`, o sea, con el COMMIT hecho. Si la transacción lanza, `flush()` no se
 * alcanza y los eventos se pierden con ella: nunca se avisa de algo que se revirtió.
 */
export class PendingPassEvents {
  private items: Array<[string, PassEvent]> = [];

  constructor(private readonly bus: PassEventBus) {}

  /** `userId` = usuario_id interno del comensal; null si el cliente no tiene cuenta en la app (no hay a quién avisar). */
  add(userId: string | null, event: PassEvent): void {
    if (userId) this.items.push([userId, event]);
  }

  get size(): number {
    return this.items.length;
  }

  /** Publica lo juntado (una sola vez). Llamar solo cuando la transacción ya hizo COMMIT. */
  flush(): void {
    const items = this.items;
    this.items = [];
    for (const [userId, event] of items) this.bus.publish(userId, event);
  }
}

/**
 * Bus en memoria por comensal: cada usuario solo recibe lo que se publica con su usuario_id. Vive en el proceso, así
 * que solo funciona con **una instancia** de la API (ver docs/qr-flujo.md para escalar).
 */
@Injectable()
export class PassEventBus {
  private readonly logger = new Logger(PassEventBus.name);
  private readonly listeners = new Map<string, Set<PassEventListener>>();

  /** Suscribe a los eventos de un usuario. Devuelve la función para darse de baja (idempotente). */
  subscribe(userId: string, listener: PassEventListener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      const s = this.listeners.get(userId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(userId);
    };
  }

  /** Entrega un evento a los suscriptores de ese usuario. Un suscriptor que falla no afecta a los demás. */
  publish(userId: string, event: PassEvent): number {
    const set = this.listeners.get(userId);
    if (!set) return 0;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn({ err, tipo: event.tipo }, 'Suscriptor de eventos del pase falló');
      }
    }
    return set.size;
  }

  /** Colector para una transacción: ver `PendingPassEvents`. */
  pending(): PendingPassEvents {
    return new PendingPassEvents(this);
  }

  /** Suscripciones activas (de un usuario o en total). */
  listenerCount(userId?: string): number {
    if (userId !== undefined) return this.listeners.get(userId)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}
