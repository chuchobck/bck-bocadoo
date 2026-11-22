import { RequestContextStore } from '../tenancy/request-context';

/**
 * Estado inicial de un pago no efectivo (transferencia, Deuna…). `pagoConfirmado` solo lo puede marcar el dueño:
 * confirmar un pago es, por diseño, trabajo suyo (`POST /v1/pagos/{id}/confirmar`, `GET /v1/pagos/pendientes`).
 * Un cajero que mande `pagoConfirmado: true` no se salta esa revisión: el pago igual queda PENDIENTE.
 */
export function estadoPagoInicial(esEfectivo: boolean, pagoConfirmado: boolean | undefined): 'CONFIRMADO' | 'PENDIENTE' {
  const puedeAutoconfirmar = RequestContextStore.get()?.role !== 'CAJERO';
  return esEfectivo || (puedeAutoconfirmar && pagoConfirmado) ? 'CONFIRMADO' : 'PENDIENTE';
}
