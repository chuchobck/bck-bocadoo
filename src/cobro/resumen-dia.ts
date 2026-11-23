import type { Queryable } from '../db/db.service';

/**
 * Lo que las cuentas de cobro aportan a un día local del restaurante (entrega D, PR 8). Una sola definición para el
 * cierre de caja y los reportes del dueño, así sus cifras cuadran:
 * - Dinero: pagos `CONFIRMADO` de cuentas (`cuenta_cobro_id`), netos de reversos, del día de cada pago. Un pago
 *   PENDIENTE o RECHAZADO no suma; una cuenta ANULADA netea 0 con sus pagos inversos. Una ABIERTA no tiene pagos
 *   confirmados por definición de saldo y solo se informa (cantidad y saldo).
 * - Almuerzos sueltos: líneas `CAJA` de tipo `ALMUERZO`, no omitidas, de cuentas `COBRADA`, por el día local de la
 *   línea (`creada_en`; un reverso resta el día en que ocurre, como consumos y POS). Las líneas `PLAN` no cuentan:
 *   ya están en `consumo_almuerzo`.
 */
export interface ResumenCuentasDia {
  cobradas: number;
  abiertas: number;
  saldoAbiertasCentavos: number;
  almuerzosSueltos: number;
  almuerzosSueltosParaLlevar: number;
}

export async function resumenCuentasDia(q: Queryable, fecha: string): Promise<ResumenCuentasDia> {
  const cuentas = (
    await q.query<{ cobradas: number; abiertas: number; saldo: string }>(
      `SELECT count(*) FILTER (WHERE c.estado = 'COBRADA')::int AS cobradas,
              count(*) FILTER (WHERE c.estado = 'ABIERTA')::int AS abiertas,
              COALESCE(sum(s.saldo_centavos) FILTER (WHERE c.estado = 'ABIERTA'), 0) AS saldo
         FROM cuenta_cobro c JOIN v_cuenta_saldo s ON s.cuenta_id = c.cuenta_id
        WHERE c.restaurante_id = app_tenant_id() AND c.fecha_local = $1`,
      [fecha],
    )
  ).rows[0]!;
  const almuerzos = (
    await q.query<{ n: number; llevar: number }>(
      `SELECT COALESCE(sum(l.cantidad), 0)::int AS n, COALESCE(sum(l.cantidad) FILTER (WHERE c.para_llevar), 0)::int AS llevar
         FROM cuenta_cobro_linea l
         JOIN cuenta_cobro c ON c.restaurante_id = l.restaurante_id AND c.cuenta_id = l.cuenta_id
         JOIN restaurante r ON r.restaurante_id = l.restaurante_id
        WHERE l.restaurante_id = app_tenant_id() AND c.estado = 'COBRADA' AND l.fuente = 'CAJA' AND l.tipo = 'ALMUERZO'
          AND l.omitida IS NULL AND (l.creada_en AT TIME ZONE r.zona_horaria)::date = $1`,
      [fecha],
    )
  ).rows[0]!;
  return {
    cobradas: cuentas.cobradas,
    abiertas: cuentas.abiertas,
    saldoAbiertasCentavos: Number(cuentas.saldo),
    almuerzosSueltos: almuerzos.n,
    almuerzosSueltosParaLlevar: almuerzos.llevar,
  };
}
