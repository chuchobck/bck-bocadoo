/** Minutos que vive una preorden desde que empieza a valer (creación o hora de llegada, lo que ocurra después). */
export const PREORDER_MINUTES = 30;

/**
 * Vencimiento de un pedido: max(creadoEn, horaLlegada) + 30 min. Sin hora de llegada, creadoEn + 30 min.
 * Una hora pasada (hasta 5 min atrás por la ventana) no acorta el plazo. Es el único sitio donde se calcula;
 * solo se aplica al crear: los pedidos ya guardados conservan su `vence_en`.
 */
export function venceEn(creadoEn: Date, horaLlegada: Date | null): Date {
  const base = horaLlegada && horaLlegada.getTime() > creadoEn.getTime() ? horaLlegada : creadoEn;
  return new Date(base.getTime() + PREORDER_MINUTES * 60_000);
}
