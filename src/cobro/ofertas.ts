// Ofertas flash dentro de pedidos, selección de mesa y cuentas (docs/spec-cobros.md D, E.2, E.8; PR 7b). Con efectos:
// lee la oferta, valida al pedir (sin reservar stock, I-7) y toma el stock al canjear en caja con el mismo UPDATE
// condicional de `POST /v1/ofertas/{id}/canjear`. src/billing sigue puro: aquí solo se prepara su entrada.

import type { CategoriaBase, CodigoAviso, LineaCotizada } from '../billing/tipos';
import { deriveKey } from '../common/derive-key';
import { conflict, notFound, unprocessable } from '../common/errors';
import { PERSONAL_ACTUAL } from '../common/sql';
import type { Queryable } from '../db/db.service';

export type EstadoOferta = 'CERRADA' | 'AGOTADA' | 'EXPIRADA' | 'PROGRAMADA' | 'VIGENTE';

/** Lo que hace falta de una oferta para pedirla o cotizarla. Precios en centavos (strings de BIGINT). */
export interface OfertaFila {
  oferta_flash_id: string;
  public_id: string;
  titulo: string;
  precio: string;
  /** Precio normal del plato (el de la carta; si no tiene, el original de la oferta): lo que se cobra si la oferta ya no vale. */
  precio_normal: string;
  stock_restante: number;
  estado: EstadoOferta;
  plato_id: string | null;
  plato_public_id: string | null;
  plato_nombre: string | null;
  plato_categoria: CategoriaBase | null;
  plato_seccion: string | null;
}

/** Mismo orden de decisión que la vista `OFERTAS` de src/offers/offers.ts. */
const ESTADO_SQL = `CASE WHEN NOT o.activa THEN 'CERRADA'
            WHEN o.stock_restante = 0 THEN 'AGOTADA'
            WHEN o.expira_en <= CURRENT_TIMESTAMP THEN 'EXPIRADA'
            WHEN o.inicia_en > CURRENT_TIMESTAMP THEN 'PROGRAMADA'
            ELSE 'VIGENTE' END`;

const COLS = `o.oferta_flash_id, o.public_id, o.titulo, o.precio_centavos AS precio, COALESCE(p.precio_centavos, o.precio_original_centavos) AS precio_normal,
       o.stock_restante, ${ESTADO_SQL} AS estado, o.plato_id, p.public_id AS plato_public_id, p.nombre AS plato_nombre,
       p.categoria AS plato_categoria, p.seccion AS plato_seccion`;

/** Ofertas de un local por public_id (minúsculas). `oferta_flash` tiene lectura pública: sirve al comensal y a la caja. */
export async function cargarOfertas(q: Queryable, restauranteId: string, publicIds: string[]): Promise<Map<string, OfertaFila>> {
  const ids = [...new Set(publicIds.map((x) => x.toLowerCase()))];
  if (!ids.length) return new Map();
  const r = await q.query<OfertaFila>(
    `SELECT ${COLS} FROM oferta_flash o LEFT JOIN plato p ON p.restaurante_id = o.restaurante_id AND p.plato_id = o.plato_id
      WHERE o.restaurante_id = $1 AND o.public_id = ANY($2::uuid[])`,
    [restauranteId, ids],
  );
  return new Map(r.rows.map((o) => [String(o.public_id), o]));
}

/** El error de una oferta que no se puede pedir ahora (los mismos códigos del canje suelto). null = se puede pedir `cantidad`. */
export function errorDeOferta(o: OfertaFila, cantidad: number) {
  switch (o.estado) {
    case 'CERRADA':
      return conflict('OFERTA_CERRADA', 'La oferta fue cerrada por el local.');
    case 'EXPIRADA':
      return conflict('OFERTA_EXPIRADA', 'La oferta ya terminó.');
    case 'PROGRAMADA':
      return conflict('OFERTA_NO_INICIADA', 'La oferta todavía no empieza.');
    case 'AGOTADA':
      return conflict('OFERTA_AGOTADA', 'Ya no quedan unidades.');
    default:
      return o.stock_restante < cantidad
        ? conflict('STOCK_INSUFICIENTE', `Solo quedan ${o.stock_restante} unidades y se pidieron ${cantidad}.`)
        : null;
  }
}

/** Al pedir o elegir: la oferta existe en el local, tiene plato y se puede pedir `cantidad` (no reserva stock). */
export function validarOfertaParaPedir(o: OfertaFila | undefined, cantidad: number): OfertaFila & { plato_public_id: string } {
  if (!o) throw notFound('OFERTA_NO_ENCONTRADA', 'Oferta no encontrada.');
  if (!o.plato_public_id || !o.plato_categoria)
    throw unprocessable('OFERTA_SIN_PLATO', 'Esa oferta no tiene un plato asociado y no se puede pedir.');
  const e = errorDeOferta(o, cantidad);
  if (e) throw e;
  return o as OfertaFila & { plato_public_id: string };
}

/** `almuerzo.ofertaId`: la oferta debe ser de un plato ALMUERZO y ese plato debe estar entre los del almuerzo elegido. */
export function validarOfertaDeAlmuerzo(o: OfertaFila & { plato_public_id: string }, platosDelAlmuerzo: string[]): void {
  if (o.plato_categoria !== 'ALMUERZO' || !platosDelAlmuerzo.map((p) => p.toLowerCase()).includes(o.plato_public_id.toLowerCase()))
    throw unprocessable('OFERTA_NO_APLICA_ALMUERZO', 'Esa oferta no es de un plato del almuerzo que elegiste.');
}

/** Aviso de una oferta que dejó de valer entre pedir y canjear. */
export const avisoDeCaida = (estado: EstadoOferta | 'STOCK_INSUFICIENTE'): CodigoAviso =>
  estado === 'EXPIRADA' ? 'OFERTA_EXPIRADA' : 'OFERTA_AGOTADA';

export interface NecesidadStock {
  /** public_id de la oferta. */
  ofertaId: string;
  cantidad: number;
}

/**
 * Toma el stock de cada oferta al canjear en caja (I-7: primero que llega a caja). El UPDATE condicional bloquea la fila
 * de la oferta: dos canjes a la vez se turnan y el stock nunca baja de cero. Se toma en orden de id interno (así dos
 * cajas con varias ofertas no se bloquean entre sí). Devuelve, por oferta, null si se tomó o por qué no se pudo; una
 * oferta que no se pudo tomar no descuenta nada (la línea se recotiza a precio normal, D4).
 */
export async function tomarStocks(
  q: Queryable,
  necesidades: NecesidadStock[],
): Promise<Map<string, EstadoOferta | 'STOCK_INSUFICIENTE' | null>> {
  const out = new Map<string, EstadoOferta | 'STOCK_INSUFICIENTE' | null>();
  const total = new Map<string, number>();
  for (const n of necesidades) total.set(n.ofertaId.toLowerCase(), (total.get(n.ofertaId.toLowerCase()) ?? 0) + n.cantidad);
  if (!total.size) return out;
  const ids = (
    await q.query<{ oferta_flash_id: string; public_id: string }>(
      `SELECT oferta_flash_id, public_id FROM oferta_flash WHERE restaurante_id = app_tenant_id() AND public_id = ANY($1::uuid[])
        ORDER BY oferta_flash_id`,
      [[...total.keys()]],
    )
  ).rows;
  for (const o of ids) {
    const cantidad = total.get(String(o.public_id))!;
    const r = await q.query(
      `UPDATE oferta_flash SET stock_restante = stock_restante - $2
        WHERE restaurante_id = app_tenant_id() AND oferta_flash_id = $1 AND activa
          AND inicia_en <= CURRENT_TIMESTAMP AND expira_en > CURRENT_TIMESTAMP AND stock_restante >= $2`,
      [o.oferta_flash_id, cantidad],
    );
    if (r.rowCount) {
      out.set(String(o.public_id), null);
      continue;
    }
    const e = (
      await q.query<{ estado: EstadoOferta; stock_restante: number }>(
        `SELECT ${ESTADO_SQL} AS estado, o.stock_restante FROM oferta_flash o WHERE o.oferta_flash_id = $1`,
        [o.oferta_flash_id],
      )
    ).rows[0]!;
    out.set(String(o.public_id), e.estado === 'VIGENTE' ? 'STOCK_INSUFICIENTE' : e.estado);
  }
  for (const k of total.keys()) if (!out.has(k)) out.set(k, 'CERRADA'); // la oferta ya no existe en el local
  return out;
}

/** Líneas OFERTA que se cobran (no omitidas) de un pagador: lo que consume stock. */
export const lineasDeOferta = (lineas: LineaCotizada[], pagadorRef?: string) =>
  lineas.filter(
    (l) => l.fuente === 'OFERTA' && l.omitida === null && l.ofertaId && (pagadorRef === undefined || l.pagadorRef === pagadorRef),
  );

export interface CanjesDeCuenta {
  key: string;
  pagadorRef: string;
  /** Cuenta interna; null si no hay cuenta (saldo 0 sin `cobro`): el canje igual se registra, el stock ya se tomó. */
  cuentaId: string | null;
  usuarioId: string | null;
  lineas: LineaCotizada[];
}

/**
 * Registra el canje de cada oferta de las líneas de un pagador (una fila por oferta, con la suma de sus unidades). El
 * pago es el de la cuenta, no uno propio (F.2): el canje solo apunta a ella. Devuelve public_id de oferta → canje interno.
 */
export async function registrarCanjes(q: Queryable, c: CanjesDeCuenta): Promise<Map<string, string>> {
  const porOferta = new Map<string, { cantidad: number; monto: number }>();
  for (const l of lineasDeOferta(c.lineas, c.pagadorRef)) {
    const x = porOferta.get(l.ofertaId!.toLowerCase()) ?? { cantidad: 0, monto: 0 };
    x.cantidad += l.cantidad;
    x.monto += l.subtotalCentavos;
    porOferta.set(l.ofertaId!.toLowerCase(), x);
  }
  const out = new Map<string, string>();
  for (const [ofertaId, x] of porOferta) {
    const r = await q.query<{ canje_id: string }>(
      `INSERT INTO canje_oferta_flash (restaurante_id, oferta_flash_id, usuario_id, personal_id, cantidad, monto_centavos, clave_idempotencia, cuenta_cobro_id)
       SELECT app_tenant_id(), o.oferta_flash_id, $2, ${PERSONAL_ACTUAL}, $3, $4, $5, $6
         FROM oferta_flash o WHERE o.restaurante_id = app_tenant_id() AND o.public_id = $1
       RETURNING canje_id`,
      [ofertaId, c.usuarioId, x.cantidad, x.monto, deriveKey(c.key, `canje:${c.pagadorRef}:${ofertaId}`), c.cuentaId],
    );
    out.set(ofertaId, String(r.rows[0]!.canje_id));
  }
  return out;
}
