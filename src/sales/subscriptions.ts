/** Lectura de planes vendidos (suscripciones) con su pago original y, si existe, el pago inverso. */
export const SUBS_SELECT = `SELECT s.public_id, s.cliente_id, c.nombre AS cliente_nombre, s.plantilla_plan_id, s.origen, s.nombre_plan,
       s.almuerzos_totales, s.almuerzos_restantes, s.precio_pagado_centavos, s.precio_unitario_centavos, s.moneda_codigo, s.dias_validos,
       s.comprada_en, s.vence_el::text AS vence_el, s.estado, s.anulada_en, s.anotacion,
       p.public_id AS pago_id, p.estado AS pago_estado, p.monto_centavos AS pago_monto, m.codigo AS pago_metodo, p.fecha_local::text AS pago_fecha,
       p.comprobante_url AS pago_comprobante, rv.public_id AS reverso_id, rv.monto_centavos AS reverso_monto
  FROM suscripcion_plan s
  JOIN cliente_restaurante c ON c.restaurante_id = s.restaurante_id AND c.cliente_id = s.cliente_id
  LEFT JOIN transaccion_pago p ON p.restaurante_id = s.restaurante_id AND p.suscripcion_id = s.suscripcion_id AND p.revierte_a_pago_id IS NULL
  LEFT JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
  LEFT JOIN transaccion_pago rv ON rv.restaurante_id = s.restaurante_id AND rv.revierte_a_pago_id = p.pago_id`;

export interface SubRow {
  public_id: string;
  cliente_id: string;
  cliente_nombre: string;
  plantilla_plan_id: string | null;
  origen: string;
  nombre_plan: string;
  almuerzos_totales: number;
  almuerzos_restantes: number;
  precio_pagado_centavos: string;
  precio_unitario_centavos: string;
  moneda_codigo: string;
  dias_validos: number[];
  comprada_en: Date;
  vence_el: string;
  estado: string;
  anulada_en: Date | null;
  anotacion: string | null;
  pago_id: string | null;
  pago_estado: string | null;
  pago_monto: string | null;
  pago_metodo: string | null;
  pago_fecha: string | null;
  pago_comprobante: string | null;
  reverso_id: string | null;
  reverso_monto: string | null;
}

export const toSub = (s: SubRow) => ({
  id: s.public_id,
  cliente: { id: String(s.cliente_id), nombre: s.cliente_nombre },
  planId: s.plantilla_plan_id === null ? null : String(s.plantilla_plan_id),
  origen: s.origen,
  nombrePlan: s.nombre_plan,
  almuerzosTotales: s.almuerzos_totales,
  almuerzosRestantes: s.almuerzos_restantes,
  precioPagadoCentavos: Number(s.precio_pagado_centavos),
  precioUnitarioCentavos: Number(s.precio_unitario_centavos),
  monedaCodigo: s.moneda_codigo,
  diasValidos: s.dias_validos,
  compradaEn: s.comprada_en,
  venceEl: s.vence_el,
  estado: s.estado,
  anuladaEn: s.anulada_en,
  anotacion: s.anotacion,
  pago: s.pago_id
    ? {
        id: s.pago_id,
        estado: s.pago_estado,
        metodo: s.pago_metodo,
        montoCentavos: Number(s.pago_monto),
        fecha: s.pago_fecha,
        comprobanteUrl: s.pago_comprobante,
        reverso: s.reverso_id ? { id: s.reverso_id, montoCentavos: Number(s.reverso_monto) } : null,
      }
    : null,
});
