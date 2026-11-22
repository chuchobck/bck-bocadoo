// Fase 2 del cobro (docs/spec-cobros.md, B.1 `aplicar`, F.1, F.3 y F.4): lo que pasa dentro de la transacción de la
// caja. Descuenta las unidades que la cotización marcó PLAN, recotiza con lo que respondió la base y persiste el
// resultado como una cuenta de cobro con sus líneas (libro de solo-inserción) y, si se pide, su pago.
//
// src/billing no puede tocar la base: este módulo es su contraparte con efectos. Es el mismo para todos los orígenes
// de una cuenta (pedido hoy; QR, intento de escaneo y miembro de mesa en los PR siguientes). Nunca hace UPDATE de un
// monto: un reverso es una línea (o un pago) nueva con cantidad negativa enlazada a la original.

import { cotizar } from '../billing/cotizar';
import type { Cotizacion, EntradaCobro, EstadoPlan, LineaCotizada, MomentoCobro, UnidadPlan } from '../billing/tipos';
import { deriveKey } from '../common/derive-key';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors';
import { HOY_TENANT, PERSONAL_ACTUAL } from '../common/sql';
import type { Queryable } from '../db/db.service';
import { RequestContextStore } from '../tenancy/request-context';
import { aRespuesta } from './adaptador';
import type { CuentaResponse, MetodoPago } from './cuenta.dto';

/** De dónde sale la cuenta (exactamente uno, `ck_cuenta_origen_unico`). Ids internos. */
export type OrigenCuenta =
  | { tipo: 'PEDIDO'; ordenId: string }
  | { tipo: 'CONSUMO'; consumoId: string }
  | { tipo: 'INTENTO'; intentoId: string }
  | { tipo: 'MESA'; mesaCompartidaId: string; miembroId: string };

/** Lo que respondió `fn_descontar_almuerzo` para una unidad. `consumoId` (interno) solo si se descontó. */
export interface ResultadoDescuento {
  estado: EstadoPlan;
  consumoId: string | null;
}

/** Resultado de `fn_descontar_almuerzo` → estado del plan de la cotización (B.3 paso 5). */
export function estadoPlanDe(resultado: string): EstadoPlan {
  switch (resultado) {
    case 'OK':
    case 'OK_ADVERTENCIA':
      return 'OK';
    case 'SIN_SALDO':
    case 'VENCIDO':
    case 'DIA_NO_VALIDO':
    case 'DUPLICADO':
    case 'LIMITE_SAAS':
      return resultado;
    default:
      return 'SIN_PLAN';
  }
}

/**
 * B.1 `aplicar`, paso de descuento: cotiza, llama a `descontar` por cada unidad PLAN (en orden) y recotiza con lo que
 * respondió la base. Si una unidad no se descuenta, el resto de las unidades de ese pagador ya no se intentan y se
 * reclasifican con ese resultado (CAJA, u omitidas con DUPLICADO / LIMITE_SAAS). Devuelve la cotización final
 * (`estimada: false`) y los consumos creados, en el orden de sus líneas PLAN.
 *
 * Límite conocido (relevante desde el PR 6, mesas): si un pagador descuenta k > 0 unidades y la siguiente responde
 * DUPLICADO o LIMITE_SAAS, el resto se cobra como CAJA en vez de omitirse (la cotización pura no distingue el motivo
 * por unidad). En un pedido hay a lo sumo una unidad.
 */
export async function descontarYRecotizar(
  entrada: EntradaCobro,
  descontar: (unidad: UnidadPlan, indice: number) => Promise<ResultadoDescuento>,
): Promise<{ cotizacion: Cotizacion; consumos: string[] }> {
  const previa = cotizar(entrada, { estimada: false });
  const porPagador = new Map<string, { ok: number; falla: EstadoPlan | null }>();
  const consumos: string[] = [];
  for (const [i, u] of previa.unidadesPlan.entries()) {
    const st = porPagador.get(u.pagadorRef) ?? { ok: 0, falla: null };
    porPagador.set(u.pagadorRef, st);
    if (st.falla) continue;
    const r = await descontar(u, i);
    if (r.estado === 'OK' && r.consumoId) {
      st.ok += 1;
      consumos.push(r.consumoId);
    } else st.falla = r.estado === 'OK' ? 'SIN_SALDO' : r.estado;
  }
  const personas = entrada.personas.map((p) => {
    const st = porPagador.get(p.ref);
    if (!st) return p;
    return { ...p, plan: st.ok > 0 ? { estado: 'OK' as const, disponibles: st.ok } : { estado: st.falla ?? 'SIN_PLAN', disponibles: 0 } };
  });
  return { cotizacion: cotizar({ ...entrada, personas }, { estimada: false }), consumos };
}

// --- Persistir --------------------------------------------------------------------------------------------------

export interface CuentaNueva {
  /** Idempotency-Key de la petición (K): todas las claves de la cuenta se derivan de ella (F.3). */
  key: string;
  /** Pagador de la cuenta en la cotización ("0" fuera de mesa; el miembro_id en una mesa). */
  pagadorRef: string;
  origen: OrigenCuenta;
  /** Cotización final (`estimada: false`). Solo se guardan las líneas de `pagadorRef`. */
  cotizacion: Cotizacion;
  /** Consumos (ids internos) de las líneas PLAN de este pagador, en su orden. */
  consumos: string[];
  pagador: { clienteId: string | null; usuarioId: string | null; nombre: string; esAnfitrion?: boolean };
  momentoCobro: MomentoCobro;
  paraLlevar: boolean;
  /** sha256 de la entrada normalizada: misma llave con otro cuerpo → 409 (F.3). */
  huella: string;
}

export const claveCuenta = (key: string, pagadorRef: string) => deriveKey(key, `cuenta:${pagadorRef}`);
export const clavePagoEnElPaso = (key: string, pagadorRef: string) => deriveKey(key, `pago:${pagadorRef}`);
const claveLinea = (key: string, pagadorRef: string, ref: string) => deriveKey(key, `linea:${pagadorRef}:${ref}`);

const NOMBRE_TIPO: Record<LineaCotizada['tipo'], string> = {
  ALMUERZO: 'Almuerzo',
  A_LA_CARTA: 'Plato a la carta',
  EXTRA: 'Extra',
  BEBIDA: 'Bebida',
  OFERTA: 'Oferta',
  LIBRE: 'Cobro libre',
};

async function idsInternos(q: Queryable, tabla: 'plato' | 'oferta_flash', publicIds: string[]): Promise<Map<string, string>> {
  if (!publicIds.length) return new Map();
  const col = tabla === 'plato' ? 'plato_id' : 'oferta_flash_id';
  const r = await q.query<{ id: string; public_id: string }>(
    `SELECT ${col} AS id, public_id FROM ${tabla} WHERE restaurante_id = app_tenant_id() AND public_id = ANY($1::uuid[])`,
    [publicIds],
  );
  return new Map(r.rows.map((x) => [String(x.public_id), String(x.id)]));
}

/**
 * Inserta la cuenta y sus líneas (solo-inserción). Sin saldo nace COBRADA (no hay nada que cobrar); si no, ABIERTA.
 * No paga: el pago es `registrarPago`. Devuelve el id interno de la cuenta.
 */
export async function persistirCuenta(q: Queryable, c: CuentaNueva): Promise<string> {
  const lineas = c.cotizacion.lineas.filter((l) => l.pagadorRef === c.pagadorRef);
  const planes = lineas.filter((l) => l.fuente === 'PLAN').length;
  if (planes !== c.consumos.length) throw new Error(`aplicar: ${planes} líneas PLAN y ${c.consumos.length} consumos`);
  const porCobrar = lineas.reduce((s, l) => s + l.porCobrarCentavos, 0);
  const platos = await idsInternos(q, 'plato', [...new Set(lineas.flatMap((l) => (l.platoId ? [l.platoId] : [])))]);
  const ofertas = await idsInternos(q, 'oferta_flash', [...new Set(lineas.flatMap((l) => (l.ofertaId ? [l.ofertaId] : [])))]);
  const o = c.origen;
  const cuentaId = (
    await q.query<{ cuenta_id: string }>(
      `INSERT INTO cuenta_cobro (restaurante_id, orden_id, consumo_id, intento_id, mesa_compartida_id, miembro_id, cliente_id, usuario_id,
                                 nombre_pagador, momento_cobro, para_llevar, moneda_codigo, estado, cobrada_en, clave_idempotencia, huella,
                                 personal_id, fecha_local)
       SELECT app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9::momento_cobro_enum, $10, r.moneda_codigo,
              CASE WHEN $11::boolean THEN 'COBRADA' ELSE 'ABIERTA' END::estado_cuenta_cobro_enum,
              CASE WHEN $11::boolean THEN CURRENT_TIMESTAMP END, $12, $13, ${PERSONAL_ACTUAL}, (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date
         FROM restaurante r WHERE r.restaurante_id = app_tenant_id()
       RETURNING cuenta_id`,
      [
        o.tipo === 'PEDIDO' ? o.ordenId : null,
        o.tipo === 'CONSUMO' ? o.consumoId : null,
        o.tipo === 'INTENTO' ? o.intentoId : null,
        o.tipo === 'MESA' ? o.mesaCompartidaId : null,
        o.tipo === 'MESA' ? o.miembroId : null,
        c.pagador.clienteId,
        c.pagador.usuarioId,
        c.pagador.nombre,
        c.momentoCobro,
        c.paraLlevar,
        porCobrar === 0,
        claveCuenta(c.key, c.pagadorRef),
        c.huella,
      ],
    )
  ).rows[0]!.cuenta_id;
  let k = 0;
  for (const l of lineas) {
    const consumoId = l.fuente === 'PLAN' ? c.consumos[k++]! : null;
    await q.query(
      `INSERT INTO cuenta_cobro_linea (cuenta_id, restaurante_id, ref, persona_ref, tipo, fuente, pagador, omitida, plato_id, oferta_flash_id,
                                       consumo_id, nombre, cantidad, precio_unitario_centavos, recargo_unitario_centavos, subtotal_centavos,
                                       recargo_centavos, cubierto_centavos, clave_idempotencia)
       VALUES ($1, app_tenant_id(), $2, $3, $4::tipo_linea_cobro_enum, $5::fuente_cobro_enum, $6::pagador_linea_enum, $7::motivo_omision_enum,
               $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        cuentaId,
        l.ref,
        l.personaRef,
        l.tipo,
        l.fuente,
        l.pagador,
        l.omitida,
        l.platoId ? (platos.get(l.platoId) ?? null) : null,
        l.ofertaId ? (ofertas.get(l.ofertaId) ?? null) : null,
        consumoId,
        l.nombre ?? NOMBRE_TIPO[l.tipo],
        l.cantidad,
        l.precioUnitarioCentavos,
        l.recargoUnitarioCentavos,
        l.subtotalCentavos,
        l.recargoCentavos,
        l.cubiertoPorPlanCentavos,
        claveLinea(c.key, c.pagadorRef, l.ref),
      ],
    );
  }
  return String(cuentaId);
}

/** La cuenta (no anulada) creada con esta Idempotency-Key para ese pagador, con su origen y su huella. */
export async function cuentaPorClave(q: Queryable, key: string, pagadorRef: string) {
  const r = await q.query<{ cuenta_id: string; orden_id: string | null; huella: string }>(
    `SELECT cuenta_id, orden_id, huella FROM cuenta_cobro WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1`,
    [claveCuenta(key, pagadorRef)],
  );
  return r.rows[0] ?? null;
}

/** Cuenta no anulada de un pedido (a lo sumo una, `uq_cuenta_por_orden`). */
export async function cuentaDeOrden(q: Queryable, ordenId: string): Promise<string | null> {
  const r = await q.query<{ cuenta_id: string }>(
    `SELECT cuenta_id FROM cuenta_cobro WHERE restaurante_id = app_tenant_id() AND orden_id = $1 AND estado <> 'ANULADA'`,
    [ordenId],
  );
  return r.rows[0] ? String(r.rows[0].cuenta_id) : null;
}

// --- Pagos ------------------------------------------------------------------------------------------------------

export interface PagoCuenta {
  metodoPago: MetodoPago;
  saldoEsperadoCentavos: number;
  montoCentavos?: number;
  pagoConfirmado?: boolean;
  comprobanteUrl?: string;
  referenciaExterna?: string;
}

/** 409 `SALDO_CAMBIO` con el saldo real, para que la caja lo muestre y reenvíe confirmándolo. */
export const saldoCambio = (saldoCentavos: number, extra: Record<string, unknown> = {}) =>
  conflict(
    'SALDO_CAMBIO',
    `El saldo por cobrar ahora es ${saldoCentavos} centavos: confírmalo con saldoEsperadoCentavos. No se descontó ni se cobró nada.`,
    { saldoCentavos, ...extra },
  );

async function saldoDe(q: Queryable, cuentaId: string): Promise<number> {
  const r = await q.query<{ saldo_centavos: string }>('SELECT saldo_centavos FROM v_cuenta_saldo WHERE cuenta_id = $1', [cuentaId]);
  return Number(r.rows[0]!.saldo_centavos);
}

/** Bloquea la cuenta (FOR UPDATE): cobrar, anular, deshacer y confirmar/rechazar pagos se serializan por cuenta. */
async function bloquear(q: Queryable, cuentaId: string) {
  const r = await q.query<{ estado: 'ABIERTA' | 'COBRADA' | 'ANULADA'; es_hoy: boolean }>(
    `SELECT estado, fecha_local = ${HOY_TENANT} AS es_hoy FROM cuenta_cobro WHERE restaurante_id = app_tenant_id() AND cuenta_id = $1 FOR UPDATE`,
    [cuentaId],
  );
  if (!r.rows[0]) throw notFound('CUENTA_NO_ENCONTRADA', 'Cuenta no encontrada.');
  return r.rows[0];
}

/** El estado sigue al saldo (pagos no rechazados): sin saldo → COBRADA; con saldo → ABIERTA. Una ANULADA no cambia. */
export async function actualizarEstado(q: Queryable, cuentaId: string): Promise<void> {
  await q.query(
    `UPDATE cuenta_cobro c
        SET estado = CASE WHEN s.saldo_centavos <= 0 THEN 'COBRADA' ELSE 'ABIERTA' END::estado_cuenta_cobro_enum,
            cobrada_en = CASE WHEN s.saldo_centavos <= 0 THEN CURRENT_TIMESTAMP END
       FROM v_cuenta_saldo s
      WHERE s.cuenta_id = c.cuenta_id AND c.cuenta_id = $1 AND c.estado <> 'ANULADA'
        AND c.estado <> CASE WHEN s.saldo_centavos <= 0 THEN 'COBRADA' ELSE 'ABIERTA' END::estado_cuenta_cobro_enum`,
    [cuentaId],
  );
}

/**
 * Registra un pago de la cuenta (I-14: parcial o total, varios métodos). Con la cuenta bloqueada: la misma clave ya
 * usada para este pago → no hace nada (reintento); para otra cosa → 409. Exige la cuenta ABIERTA y que la caja haya
 * visto el saldo real (`saldoEsperadoCentavos`): dos pagos simultáneos nunca pasan del total.
 */
export async function registrarPago(q: Queryable, cuentaId: string, p: PagoCuenta, clave: string): Promise<void> {
  const cuenta = await bloquear(q, cuentaId);
  const previo = (
    await q.query<{ cuenta_cobro_id: string | null; codigo: string; monto_centavos: string }>(
      `SELECT t.cuenta_cobro_id, m.codigo, t.monto_centavos FROM transaccion_pago t JOIN metodo_pago m ON m.metodo_pago_id = t.metodo_pago_id
        WHERE t.restaurante_id = app_tenant_id() AND t.clave_idempotencia = $1`,
      [clave],
    )
  ).rows[0];
  if (previo) {
    const mismo =
      String(previo.cuenta_cobro_id) === cuentaId &&
      previo.codigo === p.metodoPago &&
      (p.montoCentavos === undefined || Number(previo.monto_centavos) === p.montoCentavos);
    if (mismo) return;
    throw conflict('IDEMPOTENCY_KEY_REUTILIZADA', 'Esa Idempotency-Key ya se usó en otro pago.');
  }
  if (cuenta.estado !== 'ABIERTA') throw conflict('CUENTA_CERRADA', `La cuenta está ${cuenta.estado.toLowerCase()}.`);
  const saldo = await saldoDe(q, cuentaId);
  if (p.saldoEsperadoCentavos !== saldo) throw saldoCambio(saldo);
  if (saldo <= 0) return actualizarEstado(q, cuentaId);
  const monto = p.montoCentavos ?? saldo;
  if (monto > saldo) throw unprocessable('MONTO_EXCEDE_SALDO', `El pago (${monto}) es mayor que el saldo (${saldo}).`);
  const m = (
    await q.query<{ metodo_pago_id: string; es_efectivo: boolean }>(
      `SELECT metodo_pago_id, es_efectivo FROM metodo_pago WHERE codigo = $1 AND activo
          AND (pais_codigo IS NULL OR pais_codigo = (SELECT pais_codigo FROM restaurante WHERE restaurante_id = app_tenant_id()))`,
      [p.metodoPago],
    )
  ).rows[0];
  if (!m) throw unprocessable('METODO_PAGO_NO_DISPONIBLE', 'Ese método de pago no está disponible en este local.');
  await q.query(
    `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, cuenta_cobro_id, cobrado_por_personal_id,
         fecha_local, comprobante_url, referencia_externa, clave_idempotencia)
     SELECT app_tenant_id(), $1, $2, c.moneda_codigo, $3, c.cuenta_id, ${PERSONAL_ACTUAL}, ${HOY_TENANT}, $4, $5, $6
       FROM cuenta_cobro c WHERE c.restaurante_id = app_tenant_id() AND c.cuenta_id = $7`,
    [
      m.metodo_pago_id,
      monto,
      m.es_efectivo || p.pagoConfirmado ? 'CONFIRMADO' : 'PENDIENTE',
      p.comprobanteUrl ?? null,
      p.referenciaExterna ?? null,
      clave,
      cuentaId,
    ],
  );
  await actualizarEstado(q, cuentaId);
}

/** Traduce los choques de índices de un pago a errores de negocio (fuera de la transacción, que ya abortó). */
export function errorDePago(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23505' && e.constraint === 'uq_pago_referencia_externa')
    return conflict('REFERENCIA_PAGO_REPETIDA', 'Esa referencia de pago ya se registró: no se puede usar el mismo depósito dos veces.');
  return err;
}

/**
 * Confirmar o rechazar un pago PENDIENTE de una cuenta (`POST /v1/pagos/{id}/confirmar|rechazar`). Bloquea primero la
 * cuenta y después el pago (mismo orden que cobrar y anular). Rechazado: el saldo vuelve a ser > 0 y la cuenta vuelve
 * a ABIERTA. Repetir la misma acción no cambia nada.
 */
export async function resolverPagoDeCuenta(q: Queryable, cuentaId: string, pagoId: string, accion: 'CONFIRMADO' | 'RECHAZADO') {
  await bloquear(q, cuentaId);
  const pago = (
    await q.query<{ estado: string }>(
      'SELECT estado FROM transaccion_pago WHERE restaurante_id = app_tenant_id() AND pago_id = $1 FOR UPDATE',
      [pagoId],
    )
  ).rows[0]!;
  if (pago.estado !== 'PENDIENTE') {
    if (pago.estado === accion) return;
    throw conflict('CONFLICT', `Ese pago ya está ${pago.estado.toLowerCase()}.`);
  }
  await q.query('UPDATE transaccion_pago SET estado = $2 WHERE pago_id = $1', [pagoId, accion]);
  await actualizarEstado(q, cuentaId);
}

// --- Reversos ---------------------------------------------------------------------------------------------------

/** Línea inversa (cantidad y montos con signo contrario, mismo ref) enlazada a la original. */
async function revertirLinea(q: Queryable, lineaId: string, clave: string) {
  await q.query(
    `INSERT INTO cuenta_cobro_linea (cuenta_id, restaurante_id, ref, persona_ref, tipo, fuente, pagador, omitida, plato_id, oferta_flash_id,
                                     canje_oferta_id, consumo_id, nombre, cantidad, precio_unitario_centavos, recargo_unitario_centavos,
                                     subtotal_centavos, recargo_centavos, cubierto_centavos, clave_idempotencia, revierte_a_linea_id)
     SELECT cuenta_id, restaurante_id, ref, persona_ref, tipo, fuente, pagador, omitida, plato_id, oferta_flash_id, canje_oferta_id, consumo_id,
            nombre, -cantidad, precio_unitario_centavos, recargo_unitario_centavos, -subtotal_centavos, -recargo_centavos, -cubierto_centavos,
            $2, linea_id
       FROM cuenta_cobro_linea WHERE restaurante_id = app_tenant_id() AND linea_id = $1`,
    [lineaId, clave],
  );
}

const SIN_REVERSO = (alias: string) =>
  `${alias}.cantidad > 0 AND NOT EXISTS (SELECT 1 FROM cuenta_cobro_linea x WHERE x.revierte_a_linea_id = ${alias}.linea_id)`;

/**
 * Anular la cuenta (D «Anular cuenta», F.4), en una transacción y con la cuenta bloqueada: líneas inversas de todo, un
 * pago inverso por cada pago confirmado (los pendientes pasan a RECHAZADO), `fn_revertir_consumo` de cada consumo de
 * la cuenta y estado ANULADA. Repetirla devuelve la cuenta ya anulada. El cajero solo anula cuentas del día local.
 */
export async function anularCuenta(q: Queryable, cuentaId: string, key: string, motivo: string | null): Promise<void> {
  const cuenta = await bloquear(q, cuentaId);
  if (cuenta.estado === 'ANULADA') return;
  if (RequestContextStore.get()?.role === 'CAJERO' && !cuenta.es_hoy)
    throw forbidden('SOLO_CUENTAS_DEL_DIA', 'El cajero solo puede anular cuentas del mismo día.');
  const lineas = await q.query<{ linea_id: string; consumo_id: string | null }>(
    `SELECT l.linea_id, l.consumo_id FROM cuenta_cobro_linea l WHERE l.cuenta_id = $1 AND ${SIN_REVERSO('l')} ORDER BY l.linea_id`,
    [cuentaId],
  );
  for (const l of lineas.rows) await revertirLinea(q, String(l.linea_id), deriveKey(key, `reverso-linea:${l.linea_id}`));
  const pagos = await q.query<{ pago_id: string; estado: string; monto_centavos: string; metodo_pago_id: string }>(
    `SELECT t.pago_id, t.estado, t.monto_centavos, t.metodo_pago_id FROM transaccion_pago t
      WHERE t.restaurante_id = app_tenant_id() AND t.cuenta_cobro_id = $1 AND t.revierte_a_pago_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM transaccion_pago x WHERE x.revierte_a_pago_id = t.pago_id)
      ORDER BY t.pago_id FOR UPDATE`,
    [cuentaId],
  );
  for (const p of pagos.rows) {
    if (p.estado === 'CONFIRMADO')
      await q.query(
        `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, cuenta_cobro_id, cobrado_por_personal_id,
             fecha_local, clave_idempotencia, revierte_a_pago_id)
         SELECT app_tenant_id(), $1, -$2::bigint, c.moneda_codigo, 'CONFIRMADO', c.cuenta_id, ${PERSONAL_ACTUAL}, ${HOY_TENANT}, $3, $4
           FROM cuenta_cobro c WHERE c.restaurante_id = app_tenant_id() AND c.cuenta_id = $5`,
        [p.metodo_pago_id, p.monto_centavos, deriveKey(key, `reverso-pago:${p.pago_id}`), p.pago_id, cuentaId],
      );
    else if (p.estado === 'PENDIENTE') await q.query(`UPDATE transaccion_pago SET estado = 'RECHAZADO' WHERE pago_id = $1`, [p.pago_id]);
  }
  // Los consumos que todavía no se revirtieron (un deshacer previo ya pudo devolver alguno).
  const consumos = [...new Set(lineas.rows.flatMap((l) => (l.consumo_id ? [String(l.consumo_id)] : [])))];
  for (const consumoId of consumos) {
    const vivo = await q.query(
      `SELECT 1 FROM consumo_almuerzo c WHERE c.restaurante_id = app_tenant_id() AND c.consumo_id = $1
          AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id)`,
      [consumoId],
    );
    if (vivo.rowCount) await q.query(`SELECT fn_revertir_consumo(app_tenant_id(), $1, ${PERSONAL_ACTUAL}, 'Cuenta anulada')`, [consumoId]);
  }
  await q.query(
    `UPDATE cuenta_cobro SET estado = 'ANULADA', anulada_en = CURRENT_TIMESTAMP, anulada_por_personal_id = ${PERSONAL_ACTUAL}, motivo_anulacion = $2
      WHERE restaurante_id = app_tenant_id() AND cuenta_id = $1`,
    [cuentaId, motivo],
  );
}

/**
 * Deshacer un consumo que es parte de una cuenta (D, casos G-43 y G-45). Va ANTES de `fn_revertir_consumo`.
 * - Sin cuenta viva: nada (los consumos de hoy no tienen cuenta y se comportan igual).
 * - Cuenta COBRADA, o con algún pago no rechazado: 409 `CUENTA_COBRADA` (primero se anula la cuenta, que devuelve el
 *   dinero; así nunca queda un pago mayor que lo que se debe).
 * - Cuenta ABIERTA sin pagos: línea inversa de la unidad del plan (lleva su recargo) y, si la cuenta queda sin nada
 *   por cobrar, ANULADA.
 */
export async function revertirConsumoEnCuenta(q: Queryable, consumoId: string): Promise<void> {
  const linea = (
    await q.query<{ linea_id: string; cuenta_id: string; clave_idempotencia: string }>(
      `SELECT l.linea_id, l.cuenta_id, l.clave_idempotencia FROM cuenta_cobro_linea l JOIN cuenta_cobro c ON c.cuenta_id = l.cuenta_id
        WHERE l.restaurante_id = app_tenant_id() AND l.consumo_id = $1 AND c.estado <> 'ANULADA' AND ${SIN_REVERSO('l')}`,
      [consumoId],
    )
  ).rows[0];
  if (!linea) return;
  const cuentaId = String(linea.cuenta_id);
  const cuenta = await bloquear(q, cuentaId);
  const conPagos = await q.query(`SELECT 1 FROM transaccion_pago WHERE cuenta_cobro_id = $1 AND estado <> 'RECHAZADO' LIMIT 1`, [cuentaId]);
  if (cuenta.estado === 'COBRADA' || conPagos.rowCount)
    throw conflict('CUENTA_COBRADA', 'Ese almuerzo es parte de una cuenta ya cobrada: anula la cuenta (devuelve el dinero y el almuerzo).');
  await revertirLinea(q, String(linea.linea_id), deriveKey(linea.clave_idempotencia, 'reverso'));
  const s = (
    await q.query<{ por_cobrar_centavos: string }>('SELECT por_cobrar_centavos FROM v_cuenta_saldo WHERE cuenta_id = $1', [cuentaId])
  ).rows[0]!;
  if (Number(s.por_cobrar_centavos) === 0)
    await q.query(
      `UPDATE cuenta_cobro SET estado = 'ANULADA', anulada_en = CURRENT_TIMESTAMP, anulada_por_personal_id = ${PERSONAL_ACTUAL},
              motivo_anulacion = 'Deshacer en caja'
        WHERE restaurante_id = app_tenant_id() AND cuenta_id = $1`,
      [cuentaId],
    );
}

// --- Lectura ----------------------------------------------------------------------------------------------------

/** La cuenta como la ve la API (E.1). `cotizacion` se arma con las líneas guardadas (reversos incluidos). */
export async function renderCuenta(q: Queryable, cuentaId: string): Promise<CuentaResponse> {
  const c = (
    await q.query<{
      public_id: string;
      orden_id: string | null;
      mesa_compartida_id: string | null;
      miembro_id: string | null;
      es_anfitrion: boolean | null;
      nombre_pagador: string;
      momento_cobro: string;
      moneda_codigo: string;
      estado: string;
      creada_en: Date;
      cobrada_en: Date | null;
      anulada_en: Date | null;
      pagado_centavos: string;
      saldo_centavos: string;
    }>(
      `SELECT c.public_id, c.orden_id, c.mesa_compartida_id, c.miembro_id, m.es_anfitrion, c.nombre_pagador, c.momento_cobro, c.moneda_codigo,
              c.estado, c.creada_en, c.cobrada_en, c.anulada_en, s.pagado_centavos, s.saldo_centavos
         FROM cuenta_cobro c
         JOIN v_cuenta_saldo s ON s.cuenta_id = c.cuenta_id
         LEFT JOIN mesa_compartida_miembro m ON m.miembro_id = c.miembro_id
        WHERE c.restaurante_id = app_tenant_id() AND c.cuenta_id = $1`,
      [cuentaId],
    )
  ).rows[0];
  if (!c) throw notFound('CUENTA_NO_ENCONTRADA', 'Cuenta no encontrada.');
  const pagadorRef = c.miembro_id === null ? '0' : String(c.miembro_id);
  const filas = await q.query<{
    ref: string;
    persona_ref: string;
    tipo: LineaCotizada['tipo'];
    fuente: LineaCotizada['fuente'];
    pagador: LineaCotizada['pagador'];
    omitida: LineaCotizada['omitida'];
    plato: string | null;
    oferta: string | null;
    nombre: string;
    cantidad: number;
    precio_unitario_centavos: string;
    recargo_unitario_centavos: string;
    subtotal_centavos: string;
    recargo_centavos: string;
    cubierto_centavos: string;
    para_llevar: boolean;
  }>(
    `SELECT l.ref, l.persona_ref, l.tipo, l.fuente, l.pagador, l.omitida, p.public_id AS plato, o.public_id AS oferta, l.nombre, l.cantidad,
            l.precio_unitario_centavos, l.recargo_unitario_centavos, l.subtotal_centavos, l.recargo_centavos, l.cubierto_centavos,
            (l.recargo_unitario_centavos > 0 OR c.para_llevar) AS para_llevar
       FROM cuenta_cobro_linea l
       JOIN cuenta_cobro c ON c.cuenta_id = l.cuenta_id
       LEFT JOIN plato p ON p.plato_id = l.plato_id
       LEFT JOIN oferta_flash o ON o.oferta_flash_id = l.oferta_flash_id
      WHERE l.cuenta_id = $1 ORDER BY l.linea_id`,
    [cuentaId],
  );
  const lineas: LineaCotizada[] = filas.rows.map((l) => {
    const subtotal = Number(l.subtotal_centavos);
    const recargo = Number(l.recargo_centavos);
    const cubierto = Number(l.cubierto_centavos);
    return {
      ref: l.ref,
      personaRef: l.persona_ref,
      pagadorRef,
      tipo: l.tipo,
      nombre: l.nombre,
      platoId: l.plato,
      ofertaId: l.oferta,
      cantidad: l.cantidad,
      paraLlevar: l.para_llevar,
      precioUnitarioCentavos: Number(l.precio_unitario_centavos),
      subtotalCentavos: subtotal,
      recargoUnitarioCentavos: Number(l.recargo_unitario_centavos),
      recargoCentavos: recargo,
      fuente: l.fuente,
      pagador: l.pagador,
      cubiertoPorPlanCentavos: cubierto,
      porCobrarCentavos: subtotal - cubierto + recargo,
      omitida: l.omitida,
    };
  });
  const suma = (f: (l: LineaCotizada) => number) => lineas.reduce((s, l) => s + f(l), 0);
  const subtotal = suma((l) => l.subtotalCentavos);
  const recargo = suma((l) => l.recargoCentavos);
  const cubierto = suma((l) => l.cubiertoPorPlanCentavos);
  const cotizacion: Cotizacion = {
    estimada: false,
    lineas,
    porPagador: [{ pagadorRef, subtotal, recargo, total: subtotal + recargo, cubierto, saldo: subtotal + recargo - cubierto }],
    subtotalCentavos: subtotal,
    recargoCentavos: recargo,
    totalCentavos: subtotal + recargo,
    cubiertoPorPlanCentavos: cubierto,
    saldoPorCobrarCentavos: subtotal + recargo - cubierto,
    unidadesPlan: [],
    avisos: [],
  };
  const pagos = await q.query<{ public_id: string; codigo: string; monto_centavos: string; estado: string; creado_en: Date }>(
    `SELECT t.public_id, m.codigo, t.monto_centavos, t.estado, t.creado_en FROM transaccion_pago t JOIN metodo_pago m ON m.metodo_pago_id = t.metodo_pago_id
      WHERE t.restaurante_id = app_tenant_id() AND t.cuenta_cobro_id = $1 ORDER BY t.pago_id`,
    [cuentaId],
  );
  const saldo = Number(c.saldo_centavos);
  return {
    id: c.public_id,
    origen: c.orden_id !== null ? 'PEDIDO' : c.mesa_compartida_id !== null ? 'MESA' : 'QR',
    estado: c.estado,
    momentoCobro: c.momento_cobro,
    debeCobrarseAntesDeServir: c.momento_cobro === 'ANTES_DE_SERVIR' && c.estado === 'ABIERTA' && saldo > 0,
    pagador: { nombre: c.nombre_pagador, esAnfitrion: c.es_anfitrion === true },
    cotizacion: aRespuesta(cotizacion, c.moneda_codigo),
    pagadoCentavos: Number(c.pagado_centavos),
    saldoCentavos: saldo,
    pagos: pagos.rows.map((p) => ({
      id: p.public_id,
      metodo: p.codigo,
      montoCentavos: Number(p.monto_centavos),
      estado: p.estado,
      creadoEn: p.creado_en,
    })),
    creadaEn: c.creada_en,
    cobradaEn: c.cobrada_en,
    anuladaEn: c.anulada_en,
  };
}
