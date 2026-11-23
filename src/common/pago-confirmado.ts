// Quién confirma un pago y con qué condición (auditoría de seguridad, PR «cajero confirma pagos»).
//
// - El cajero conserva `pagoConfirmado`, pero al confirmar una transferencia o un pago Deuna debe dar `referenciaExterna`
//   (el índice uq_pago_referencia_externa impide usar el mismo depósito dos veces en el local). El dueño no la necesita.
// - Todo pago que queda CONFIRMADO (al nacer, efectivo incluido, o al confirmarse después) guarda usuario, rol y momento,
//   tomados de la sesión y nunca del body. Los reversos no: el cierre los atribuye al pago original.
import { conflict, unprocessable } from './errors';
import type { Queryable } from '../db/db.service';
import { RequestContextStore } from '../tenancy/request-context';

/** Rol de quien hace la petición en el restaurante de la sesión (mismo criterio que PERSONAL_ACTUAL). */
const ROL_ACTUAL = `(SELECT rol FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id() AND activo)`;

/** Columnas de quién confirmó, en el orden de `confirmadoPorSql`. */
export const CONFIRMADO_POR_COLS = 'confirmado_por_usuario_id, confirmado_por_rol, confirmado_en';

/** Valores SQL para `CONFIRMADO_POR_COLS` en el INSERT de un pago: la sesión si nace CONFIRMADO, NULL si nace PENDIENTE. */
export const confirmadoPorSql = (confirmado: boolean) =>
  confirmado ? `app_user_id(), ${ROL_ACTUAL}, CURRENT_TIMESTAMP` : 'NULL, NULL, NULL';

/**
 * 422 `REFERENCIA_PAGO_REQUERIDA` si un cajero deja CONFIRMADO un pago que no es en efectivo sin `referenciaExterna`.
 * Va antes de insertar nada; dentro de una transacción, la aborta entera.
 */
export function exigirReferenciaAlConfirmar(p: { esEfectivo: boolean; confirmado: boolean; referenciaExterna?: string | null }) {
  if (p.esEfectivo || !p.confirmado || p.referenciaExterna) return;
  if (RequestContextStore.get()?.role !== 'CAJERO') return;
  throw unprocessable(
    'REFERENCIA_PAGO_REQUERIDA',
    'Para dejar confirmada una transferencia o un pago Deuna, el cajero debe registrar su referencia (referenciaExterna).',
  );
}

/** Confirma o rechaza un pago PENDIENTE (único UPDATE que admite fn_pago_solo_cambia_estado). Confirmar guarda quién. */
export async function resolverEstadoPago(q: Queryable, pagoId: string, accion: 'CONFIRMADO' | 'RECHAZADO'): Promise<void> {
  if (accion === 'CONFIRMADO') {
    await q.query(
      `UPDATE transaccion_pago SET estado = 'CONFIRMADO', confirmado_por_usuario_id = app_user_id(), confirmado_por_rol = ${ROL_ACTUAL},
              confirmado_en = CURRENT_TIMESTAMP
        WHERE restaurante_id = app_tenant_id() AND pago_id = $1`,
      [pagoId],
    );
  } else {
    await q.query(`UPDATE transaccion_pago SET estado = 'RECHAZADO' WHERE restaurante_id = app_tenant_id() AND pago_id = $1`, [pagoId]);
  }
}

/** El 23505 de `uq_pago_referencia_externa` como 409 `REFERENCIA_PAGO_REPETIDA`; cualquier otro error, igual. */
export function errorReferenciaRepetida(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23505' && e.constraint === 'uq_pago_referencia_externa')
    return conflict('REFERENCIA_PAGO_REPETIDA', 'Esa referencia de pago ya se registró: no se puede usar el mismo depósito dos veces.');
  return err;
}
