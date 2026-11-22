// Platos pedidos sueltos (carta fija, extras, bebidas o un plato del menú de hoy fuera del almuerzo): las reglas para
// aceptarlos y su precio de hoy. Las comparten la selección de una mesa (src/tables/selection.ts), `items` de
// `POST /v1/caja/validar` y `POST /v1/caja/cuentas/{id}/items` (docs/spec-cobros.md E.2, E.4 y E.11).

import { conflict, unprocessable } from '../common/errors';
import type { Queryable } from '../db/db.service';
import { CATEGORIAS_CARTA, platoAgotadoSql } from '../menu/carta';
import type { CategoriaPlato, PlatoSuelto } from './adaptador';

/** Lo que hace falta de un plato para decidir si se acepta suelto. `precio` = precio del menú de hoy o el del plato. */
export interface PlatoSueltoFila {
  plato_id: string;
  public_id: string;
  nombre: string;
  categoria: string;
  activo: boolean;
  precio: string | null;
  en_menu: boolean;
  agotado: boolean;
}

/**
 * Un plato suelto se acepta si existe en el local y está activo, es de la carta fija o está en el menú publicado de
 * hoy, tiene precio y no está agotado hoy (ni en el menú ni en la carta). Devuelve la fila con `precio` no nulo.
 */
export function validarPlatoSuelto<T extends PlatoSueltoFila>(p: T | undefined, hayMenu: boolean): T & { precio: string } {
  if (!p?.activo) throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no existe en este restaurante o está inactivo.');
  const deCarta = (CATEGORIAS_CARTA as readonly string[]).includes(p.categoria);
  if (!p.en_menu && !deCarta) {
    if (!hayMenu) throw conflict('MENU_NO_PUBLICADO', 'El restaurante aún no publicó el menú de hoy.');
    throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no está en el menú de hoy.');
  }
  if (p.precio === null) throw unprocessable('PLATO_SIN_PRECIO', `"${p.nombre}" solo se sirve dentro del almuerzo.`);
  if (p.agotado) throw conflict('PLATO_AGOTADO', `"${p.nombre}" se agotó.`);
  return p as T & { precio: string };
}

export interface PlatoPedido {
  /** public_id del plato. */
  plato: string;
  cantidad: number;
}

/**
 * Resuelve platos sueltos en el local del tenant (la caja): valida cada uno con `validarPlatoSuelto` y devuelve su
 * precio de hoy, en el orden pedido. Corre con RLS (`tenant_total`).
 */
export async function resolverPlatosSueltos(q: Queryable, pedidos: PlatoPedido[]): Promise<PlatoSuelto[]> {
  if (!pedidos.length) return [];
  const r = await q.query<PlatoSueltoFila & { seccion: string | null; hay_menu: boolean }>(
    `WITH m AS (
       SELECT c.menu_diario_id FROM menu_diario_cabecera c JOIN restaurante r ON r.restaurante_id = c.restaurante_id
        WHERE c.restaurante_id = app_tenant_id() AND c.publicado_en IS NOT NULL
          AND c.fecha_local = (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date
     )
     SELECT p.plato_id, p.public_id, p.nombre, p.categoria, p.seccion, p.activo, COALESCE(d.precio_centavos, p.precio_centavos) AS precio,
            d.menu_diario_detalle_id IS NOT NULL AS en_menu, (COALESCE(d.agotado, false) OR ${platoAgotadoSql('p', 'r')}) AS agotado,
            EXISTS (SELECT 1 FROM m) AS hay_menu
       FROM plato p JOIN restaurante r ON r.restaurante_id = p.restaurante_id
       LEFT JOIN menu_diario_detalle d ON d.plato_id = p.plato_id AND d.menu_diario_id = (SELECT menu_diario_id FROM m)
      WHERE p.restaurante_id = app_tenant_id() AND p.public_id = ANY($1::uuid[])`,
    [pedidos.map((x) => x.plato.toLowerCase())],
  );
  const filas = new Map(r.rows.map((p) => [String(p.public_id), p]));
  // Sin filas, el primer plato ya falla por no existir: `hayMenu` no llega a importar.
  const hayMenu = r.rows[0]?.hay_menu ?? false;
  return pedidos.map((x) => {
    const p = validarPlatoSuelto(filas.get(x.plato.toLowerCase()), hayMenu);
    return {
      platoId: String(p.public_id),
      nombre: p.nombre,
      categoria: p.categoria as CategoriaPlato,
      seccion: p.seccion,
      cantidad: x.cantidad,
      precioUnitario: Number(p.precio),
    };
  });
}
