import { badRequest } from './errors';

/** La hora de llegada va de 5 minutos atrás a 12 horas adelante (mesas compartidas y pedidos). */
export const ARRIVAL_WINDOW = { pastMs: 5 * 60_000, futureMs: 12 * 3_600_000 };

/**
 * Valida la hora de llegada (ISO 8601 ya validado por el DTO) contra la ventana y la devuelve como Date.
 * Fuera de la ventana → 400 `HORA_LLEGADA_INVALIDA`.
 */
export function horaLlegadaEnVentana(iso: string, now = Date.now()): Date {
  const llegada = new Date(iso);
  const t = llegada.getTime();
  if (Number.isNaN(t) || t < now - ARRIVAL_WINDOW.pastMs || t > now + ARRIVAL_WINDOW.futureMs)
    throw badRequest('HORA_LLEGADA_INVALIDA', 'La hora de llegada debe estar entre ahora y las próximas 12 horas.');
  return llegada;
}
