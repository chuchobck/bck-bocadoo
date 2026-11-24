// Cotización informativa de una mesa compartida (docs/spec-cobros.md, E.5 y E.6): lee precios, planes y selecciones de
// la base y arma la entrada del adaptador. Corre con los permisos de quien consulta (RLS).

import type { MomentoCobro, PlanPersona } from '../billing/tipos';
import type { Queryable } from '../db/db.service';
import { platoAgotadoSql } from '../menu/carta';
import {
  type CategoriaPlato,
  type CotizacionesMesa,
  type MesaParaCobro,
  type MiembroParaCobro,
  type PlatoSuelto,
  SIN_PLAN,
  cotizacionesDeMesa,
} from './adaptador';
import { cargarPlanes, claveCliente } from './planes';

export interface MiembroMesaBase {
  miembroId: string;
  esAnfitrion: boolean;
  paraLlevar: boolean;
  /** Ficha de cliente en el local (null = no es cliente: sin plan). */
  clienteId: string | null;
  /** Quien consulta puede leer el plan de este miembro (el comensal solo el suyo; el personal el de todos). */
  planLegible: boolean;
  /**
   * Plan ya conocido de este miembro como pagador (p. ej. lo que devolvió fn_plan_pagador_mesa al comensal): gana sobre
   * lo que se lee con `cargarPlanes`. Solo se usa si `planLegible`.
   */
  plan?: PlanPersona;
}

type SeleccionCotizable = NonNullable<MiembroParaCobro['seleccion']>;

/**
 * Selección de cada miembro con el precio de hoy (menú publicado de hoy o, si no, el del plato) y si está agotado.
 * Un plato sin precio no se puede cotizar y se omite.
 */
async function cargarSelecciones(q: Queryable, mesaId: string): Promise<Map<string, SeleccionCotizable>> {
  const r = await q.query<{
    miembro_id: string;
    public_id: string;
    nombre: string;
    categoria: CategoriaPlato;
    plato_seccion: string | null;
    seccion: string | null;
    cantidad: number;
    precio: string | null;
    agotado: boolean;
    oferta_public_id: string | null;
    oferta_titulo: string | null;
    oferta_precio: string | null;
    oferta_precio_original: string | null;
    oferta_vigente: boolean | null;
  }>(
    `SELECT i.miembro_id, p.public_id, p.nombre, p.categoria, p.seccion AS plato_seccion, i.seccion, i.cantidad,
            COALESCE(d.precio_centavos, p.precio_centavos) AS precio,
            (COALESCE(d.agotado, false) OR ${platoAgotadoSql('p', 'r')}) AS agotado,
            o.public_id AS oferta_public_id, o.titulo AS oferta_titulo, o.precio_centavos AS oferta_precio,
            COALESCE(p.precio_centavos, o.precio_original_centavos) AS oferta_precio_original,
            (o.activa AND o.inicia_en <= CURRENT_TIMESTAMP AND o.expira_en > CURRENT_TIMESTAMP AND o.stock_restante >= i.cantidad) AS oferta_vigente
       FROM mesa_compartida_miembro_item i
       JOIN plato p ON p.restaurante_id = i.restaurante_id AND p.plato_id = i.plato_id
       JOIN restaurante r ON r.restaurante_id = i.restaurante_id
       LEFT JOIN oferta_flash o ON o.restaurante_id = i.restaurante_id AND o.oferta_flash_id = i.oferta_flash_id
       LEFT JOIN menu_diario_cabecera c ON c.restaurante_id = i.restaurante_id AND c.publicado_en IS NOT NULL
            AND c.fecha_local = (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date
       LEFT JOIN menu_diario_detalle d ON d.menu_diario_id = c.menu_diario_id AND d.plato_id = i.plato_id
      WHERE i.mesa_compartida_id = $1 ORDER BY i.item_id`,
    [mesaId],
  );
  const out = new Map<string, SeleccionCotizable>();
  for (const x of r.rows) {
    const s = out.get(String(x.miembro_id)) ?? { almuerzo: false, extras: [] };
    if (x.seccion) {
      s.almuerzo = true;
      s.almuerzoAgotado = s.almuerzoAgotado || x.agotado;
    } else if (x.oferta_public_id) {
      // Oferta como ítem: al precio de la oferta mientras valga; si no, el plato a su precio normal (se confirma al validar).
      (s.ofertas ??= []).push({
        ofertaId: x.oferta_public_id,
        titulo: x.oferta_titulo!,
        platoId: x.public_id,
        platoNombre: x.nombre,
        categoria: x.categoria,
        seccion: x.plato_seccion,
        cantidad: x.cantidad,
        precioOferta: Number(x.oferta_precio),
        precioNormal: Number(x.oferta_precio_original),
        vigente: x.oferta_vigente === true,
        disponible: !x.agotado,
      });
    } else if (x.precio !== null) {
      const e: PlatoSuelto = {
        platoId: x.public_id,
        nombre: x.nombre,
        categoria: x.categoria,
        seccion: x.plato_seccion,
        cantidad: x.cantidad,
        precioUnitario: Number(x.precio),
        disponible: !x.agotado,
      };
      s.extras.push(e);
    }
    out.set(String(x.miembro_id), s);
  }
  // Oferta del almuerzo de cada miembro (si eligió almuerzo).
  const of = await q.query<{ miembro_id: string; oferta_public_id: string; precio: string; vigente: boolean }>(
    `SELECT x.miembro_id, o.public_id AS oferta_public_id, o.precio_centavos AS precio,
            (o.activa AND o.inicia_en <= CURRENT_TIMESTAMP AND o.expira_en > CURRENT_TIMESTAMP AND o.stock_restante >= 1) AS vigente
       FROM mesa_compartida_miembro x JOIN oferta_flash o ON o.restaurante_id = x.restaurante_id AND o.oferta_flash_id = x.almuerzo_oferta_flash_id
      WHERE x.mesa_compartida_id = $1`,
    [mesaId],
  );
  for (const x of of.rows) {
    const s = out.get(String(x.miembro_id));
    if (s?.almuerzo) s.almuerzoOferta = { ofertaId: x.oferta_public_id, precio: Number(x.precio), vigente: x.vigente };
  }
  return out;
}

/** Almuerzos que cada cliente ya gastó en esta mesa (consumos no revertidos): para reconstruir el plan de antes de validar. */
async function consumidosEnMesa(q: Queryable, mesaId: string): Promise<Map<string, number>> {
  const r = await q.query<{ cliente_id: string; n: number }>(
    `SELECT c.cliente_id, count(*)::int AS n FROM consumo_almuerzo c
      WHERE c.mesa_compartida_id = $1 AND c.cantidad = 1
        AND NOT EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id)
      GROUP BY c.cliente_id`,
    [mesaId],
  );
  return new Map(r.rows.map((x) => [String(x.cliente_id), x.n]));
}

export interface OpcionesCotizarMesa {
  mesaId: string;
  restauranteId: string;
  modo: 'CADA_UNO' | 'INVITO_YO';
  /** En el orden de la mesa: anfitrión primero, luego (unido_en, miembro_id). Solo los que no salieron (D, E.7). */
  miembros: MiembroMesaBase[];
  /** Mesa ya validada (solo personal): el plan se reconstruye sumando lo que se descontó aquí. */
  reponerConsumos?: boolean;
}

/**
 * Lee de la base lo que hace falta para cotizar la mesa (precios del local, planes de los pagadores legibles y la
 * selección de cada miembro) y arma la entrada del adaptador. Es la misma para la vista previa y para validar.
 */
export async function cargarMesaParaCobro(q: Queryable, o: OpcionesCotizarMesa): Promise<{ mesa: MesaParaCobro; monedaCodigo: string }> {
  const rest = (
    await q.query<{ precio: string; recargo: string; moneda: string; momento: MomentoCobro }>(
      `SELECT precio_suelto_centavos AS precio, recargo_para_llevar_centavos AS recargo, moneda_codigo AS moneda, momento_cobro AS momento
         FROM restaurante WHERE restaurante_id = $1`,
      [o.restauranteId],
    )
  ).rows[0]!;
  const planes = await cargarPlanes(
    q,
    o.miembros.filter((m) => m.planLegible && !m.plan).map((m) => ({ restauranteId: o.restauranteId, clienteId: m.clienteId })),
  );
  const gastados = o.reponerConsumos ? await consumidosEnMesa(q, o.mesaId) : new Map<string, number>();
  const selecciones = await cargarSelecciones(q, o.mesaId);

  const planDe = (m: MiembroMesaBase): PlanPersona | null => {
    if (!m.planLegible) return null;
    if (m.plan) return m.plan;
    const plan = (m.clienteId && planes.get(claveCliente(o.restauranteId, m.clienteId))) || SIN_PLAN;
    const n = m.clienteId ? (gastados.get(m.clienteId) ?? 0) : 0;
    return n > 0 ? { estado: 'OK', disponibles: plan.disponibles + n } : plan;
  };
  const miembros: MiembroParaCobro[] = o.miembros.map((m) => ({
    ref: m.miembroId,
    esAnfitrion: m.esAnfitrion,
    paraLlevar: m.paraLlevar,
    plan: planDe(m),
    seleccion: selecciones.get(m.miembroId) ?? null,
  }));
  const mesa: MesaParaCobro = {
    modo: o.modo,
    precioAlmuerzo: Number(rest.precio),
    recargoLlevar: Number(rest.recargo),
    momentoCobro: rest.momento,
    miembros,
  };
  return { mesa, monedaCodigo: rest.moneda };
}

/** Cotización informativa (E.5, E.6) repartida por miembro, con la moneda del local. */
export async function cotizarMesa(q: Queryable, o: OpcionesCotizarMesa): Promise<CotizacionesMesa & { monedaCodigo: string }> {
  const { mesa, monedaCodigo } = await cargarMesaParaCobro(q, o);
  return { ...cotizacionesDeMesa(mesa), monedaCodigo };
}
