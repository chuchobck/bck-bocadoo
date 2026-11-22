// Cotización informativa de una mesa compartida (docs/spec-cobros.md, E.5 y E.6): lee precios, planes y selecciones de
// la base y arma la entrada del adaptador. Corre con los permisos de quien consulta (RLS).

import type { MomentoCobro, PlanPersona } from '../billing/tipos';
import type { Queryable } from '../db/db.service';
import { platoAgotadoSql } from '../menu/carta';
import {
  type CategoriaPlato,
  type CotizacionesMesa,
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
  }>(
    `SELECT i.miembro_id, p.public_id, p.nombre, p.categoria, p.seccion AS plato_seccion, i.seccion, i.cantidad,
            COALESCE(d.precio_centavos, p.precio_centavos) AS precio,
            (COALESCE(d.agotado, false) OR ${platoAgotadoSql('p', 'r')}) AS agotado
       FROM mesa_compartida_miembro_item i
       JOIN plato p ON p.restaurante_id = i.restaurante_id AND p.plato_id = i.plato_id
       JOIN restaurante r ON r.restaurante_id = i.restaurante_id
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
  /** En el orden de la mesa: anfitrión primero, luego (unido_en, miembro_id). */
  miembros: MiembroMesaBase[];
  /** 'seleccion' (E.6) o 'un-almuerzo' (E.5, validar sin aplicarSeleccion). */
  base: 'seleccion' | 'un-almuerzo';
  /** Mesa ya validada (solo personal): el plan se reconstruye sumando lo que se descontó aquí. */
  reponerConsumos?: boolean;
}

export async function cotizarMesa(q: Queryable, o: OpcionesCotizarMesa): Promise<CotizacionesMesa & { monedaCodigo: string }> {
  const rest = (
    await q.query<{ precio: string; recargo: string; moneda: string; momento: MomentoCobro }>(
      `SELECT precio_suelto_centavos AS precio, recargo_para_llevar_centavos AS recargo, moneda_codigo AS moneda, momento_cobro AS momento
         FROM restaurante WHERE restaurante_id = $1`,
      [o.restauranteId],
    )
  ).rows[0]!;
  const planes = await cargarPlanes(
    q,
    o.miembros.filter((m) => m.planLegible).map((m) => ({ restauranteId: o.restauranteId, clienteId: m.clienteId })),
  );
  const gastados = o.reponerConsumos ? await consumidosEnMesa(q, o.mesaId) : new Map<string, number>();
  const selecciones = o.base === 'seleccion' ? await cargarSelecciones(q, o.mesaId) : new Map<string, SeleccionCotizable>();

  const planDe = (m: MiembroMesaBase): PlanPersona | null => {
    if (!m.planLegible) return null;
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
  const c = cotizacionesDeMesa({
    modo: o.modo,
    base: o.base,
    precioAlmuerzo: Number(rest.precio),
    recargoLlevar: Number(rest.recargo),
    momentoCobro: rest.momento,
    miembros,
  });
  return { ...c, monedaCodigo: rest.moneda };
}
