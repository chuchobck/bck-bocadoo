import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { ActualizarPlatoDto, CrearPlatoDto, DefinirMenuDto } from './dto';

// --- Platos -------------------------------------------------------------------------------------------------------

interface PlatoRow {
  plato_id: string;
  categoria: string;
  seccion: string | null;
  nombre: string;
  descripcion: string | null;
  precio_centavos: string | null;
  foto_url: string | null;
  etiquetas: string[];
  activo: boolean;
}
const PLATO_COLS = 'plato_id, categoria, seccion, nombre, descripcion, precio_centavos, foto_url, etiquetas, activo';
const toPlato = (p: PlatoRow) => ({
  id: p.plato_id,
  categoria: p.categoria,
  seccion: p.seccion,
  nombre: p.nombre,
  descripcion: p.descripcion,
  precioCentavos: p.precio_centavos === null ? null : Number(p.precio_centavos),
  fotoUrl: p.foto_url,
  etiquetas: p.etiquetas,
  activo: p.activo,
});

const PLATO_UPDATABLE: Record<keyof ActualizarPlatoDto, string> = {
  categoria: 'categoria',
  seccion: 'seccion',
  nombre: 'nombre',
  descripcion: 'descripcion',
  precioCentavos: 'precio_centavos',
  fotoUrl: 'foto_url',
  etiquetas: 'etiquetas',
  activo: 'activo',
};

// --- Menú del día -------------------------------------------------------------------------------------------------

export interface MenuItemRow {
  menu_diario_detalle_id: string;
  plato_id: string;
  nombre: string;
  categoria: string;
  descripcion: string | null;
  foto_url: string | null;
  etiquetas: string[];
  seccion: string;
  precio_dia: string | null;
  precio: string | null;
  porciones: number | null;
  agotado: boolean;
  agotado_en: Date | null;
  orden: number;
}

/** Platos de un menú ya identificado. Sirve tanto al personal (por tenant) como a la vitrina pública. */
export async function fetchMenuItems(q: Queryable, menuDiarioId: string): Promise<MenuItemRow[]> {
  const r = await q.query<MenuItemRow>(
    `SELECT d.menu_diario_detalle_id, d.plato_id, p.nombre, p.categoria, p.descripcion, p.foto_url, p.etiquetas, d.seccion,
            d.precio_centavos AS precio_dia, COALESCE(d.precio_centavos, p.precio_centavos) AS precio,
            d.porciones, d.agotado, d.agotado_en, d.orden
       FROM menu_diario_detalle d JOIN plato p ON p.plato_id = d.plato_id
      WHERE d.menu_diario_id = $1 ORDER BY d.seccion, d.orden, p.nombre`,
    [menuDiarioId],
  );
  return r.rows;
}

export const toMenuItem = (i: MenuItemRow) => ({
  id: i.menu_diario_detalle_id,
  platoId: i.plato_id,
  nombre: i.nombre,
  categoria: i.categoria,
  descripcion: i.descripcion,
  fotoUrl: i.foto_url,
  etiquetas: i.etiquetas,
  seccion: i.seccion,
  precioCentavos: i.precio === null ? null : Number(i.precio),
  precioDelDiaCentavos: i.precio_dia === null ? null : Number(i.precio_dia),
  porciones: i.porciones,
  agotado: i.agotado,
  agotadoEn: i.agotado_en,
  orden: i.orden,
});

@Injectable()
export class MenuService {
  constructor(private readonly db: DbService) {}

  // --- Catálogo de platos ---

  listDishes(categoria?: string, soloActivos = false) {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<PlatoRow>(
          `SELECT ${PLATO_COLS} FROM plato WHERE restaurante_id = app_tenant_id()
              AND ($1::text IS NULL OR categoria::text = $1) AND (NOT $2::boolean OR activo)
            ORDER BY categoria, nombre LIMIT 500`,
          [categoria ?? null, soloActivos],
        );
        return r.rows.map(toPlato);
      },
      { readOnly: true },
    );
  }

  createDish(dto: CrearPlatoDto) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<PlatoRow>(
        `INSERT INTO plato (restaurante_id, categoria, seccion, nombre, descripcion, precio_centavos, foto_url, etiquetas)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING ${PLATO_COLS}`,
        [
          dto.categoria,
          dto.seccion ?? null,
          dto.nombre,
          dto.descripcion ?? null,
          dto.precioCentavos ?? null,
          dto.fotoUrl ?? null,
          dto.etiquetas ?? [],
        ],
      );
      return toPlato(r.rows[0]!);
    });
  }

  updateDish(id: string, dto: ActualizarPlatoDto) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, col] of Object.entries(PLATO_UPDATABLE) as [keyof ActualizarPlatoDto, string][]) {
      if (dto[key] === undefined) continue;
      params.push(dto[key]);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) throw new BadRequestException('No hay nada que actualizar.');
    return this.db.forRequest(async (q) => {
      const r = await q.query<PlatoRow>(
        `UPDATE plato SET ${sets.join(', ')}, actualizado_en = CURRENT_TIMESTAMP
          WHERE restaurante_id = app_tenant_id() AND plato_id = $1 RETURNING ${PLATO_COLS}`,
        params,
      );
      if (!r.rows[0]) throw new NotFoundException('Plato no encontrado.');
      return toPlato(r.rows[0]);
    });
  }

  // --- Menú diario ---

  async getMenu(fecha: string) {
    return this.db.forRequest(
      async (q) => {
        const date = await this.resolveDate(q, fecha);
        return this.render(q, date);
      },
      { readOnly: true },
    );
  }

  /** Define el menú completo del día. Lo que ya estaba y se mantiene conserva su estado de agotado. */
  async setMenu(fecha: string, dto: DefinirMenuDto) {
    const ids = dto.items.map((i) => i.platoId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Un plato no puede repetirse en el mismo menú.');
    return this.db.forRequest(async (q) => {
      const date = await this.resolveDate(q, fecha);
      await this.assertEditable(q, date);
      if (ids.length) {
        const ok = await q.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM plato WHERE restaurante_id = app_tenant_id() AND activo AND plato_id = ANY($1::bigint[])',
          [ids],
        );
        if (ok.rows[0]!.n !== ids.length)
          throw new BadRequestException('Algún plato no existe, está inactivo o no es de este restaurante.');
      }
      const menuId = await this.ensureMenu(q, date);
      await q.query('DELETE FROM menu_diario_detalle WHERE menu_diario_id = $1 AND NOT (plato_id = ANY($2::bigint[]))', [menuId, ids]);
      for (const [i, it] of dto.items.entries()) {
        await q.query(
          `INSERT INTO menu_diario_detalle (menu_diario_id, restaurante_id, plato_id, seccion, precio_centavos, porciones, orden)
           VALUES ($1, app_tenant_id(), $2, $3, $4, $5, $6)
           ON CONFLICT (menu_diario_id, plato_id) DO UPDATE
             SET seccion = EXCLUDED.seccion, precio_centavos = EXCLUDED.precio_centavos, porciones = EXCLUDED.porciones, orden = EXCLUDED.orden`,
          [menuId, it.platoId, it.seccion, it.precioCentavos ?? null, it.porciones ?? null, it.orden ?? i],
        );
      }
      return this.render(q, date);
    });
  }

  async publish(fecha: string) {
    return this.db.forRequest(async (q) => {
      const date = await this.resolveDate(q, fecha);
      await this.assertEditable(q, date);
      const menu = await this.find(q, date);
      if (!menu) throw new ConflictException('Ese día no tiene menú: define los platos antes de publicar.');
      const n = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM menu_diario_detalle WHERE menu_diario_id = $1', [
        menu.menu_diario_id,
      ]);
      if (n.rows[0]!.n === 0) throw new ConflictException('No se puede publicar un menú sin platos.');
      await q.query(
        `UPDATE menu_diario_cabecera
            SET publicado_en = COALESCE(publicado_en, CURRENT_TIMESTAMP),
                publicado_por_personal_id = COALESCE(publicado_por_personal_id,
                  (SELECT personal_id FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id()))
          WHERE menu_diario_id = $1`,
        [menu.menu_diario_id],
      );
      return this.render(q, date);
    });
  }

  async unpublish(fecha: string) {
    return this.db.forRequest(async (q) => {
      const date = await this.resolveDate(q, fecha);
      await this.assertEditable(q, date);
      await q.query(
        'UPDATE menu_diario_cabecera SET publicado_en = NULL, publicado_por_personal_id = NULL WHERE restaurante_id = app_tenant_id() AND fecha_local = $1',
        [date],
      );
      return this.render(q, date);
    });
  }

  /** Copia los platos de otro día (por defecto, el último menú anterior que tenga platos). Queda como borrador. */
  async copy(fecha: string, desde?: string, reemplazar = false) {
    return this.db.forRequest(async (q) => {
      const date = await this.resolveDate(q, fecha);
      await this.assertEditable(q, date);
      let origin = desde;
      if (!origin) {
        const last = await q.query<{ fecha: string }>(
          `SELECT c.fecha_local::text AS fecha FROM menu_diario_cabecera c
            WHERE c.restaurante_id = app_tenant_id() AND c.fecha_local < $1 AND EXISTS (SELECT 1 FROM menu_diario_detalle d WHERE d.menu_diario_id = c.menu_diario_id)
            ORDER BY c.fecha_local DESC LIMIT 1`,
          [date],
        );
        origin = last.rows[0]?.fecha;
      }
      if (!origin) throw new NotFoundException('No hay un menú anterior que copiar.');
      if (origin === date) throw new BadRequestException('El día de origen y el de destino son el mismo.');
      const src = await this.find(q, origin);
      if (!src) throw new NotFoundException(`No hay menú el ${origin}.`);
      const menuId = await this.ensureMenu(q, date);
      const existing = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM menu_diario_detalle WHERE menu_diario_id = $1', [
        menuId,
      ]);
      if (existing.rows[0]!.n > 0) {
        if (!reemplazar) throw new ConflictException('Ese día ya tiene platos: usa reemplazar para sustituirlos.');
        await q.query('DELETE FROM menu_diario_detalle WHERE menu_diario_id = $1', [menuId]);
      }
      // Solo platos que siguen activos; el estado de agotado no se copia.
      await q.query(
        `INSERT INTO menu_diario_detalle (menu_diario_id, restaurante_id, plato_id, seccion, precio_centavos, porciones, orden)
         SELECT $1, d.restaurante_id, d.plato_id, d.seccion, d.precio_centavos, d.porciones, d.orden
           FROM menu_diario_detalle d JOIN plato p ON p.plato_id = d.plato_id AND p.activo WHERE d.menu_diario_id = $2`,
        [menuId, src.menu_diario_id],
      );
      return this.render(q, date);
    });
  }

  /** Marca o desmarca un plato como agotado, guardando a qué hora se acabó. Lo pueden hacer dueño y cajero. */
  async setSoldOut(fecha: string, itemId: string, agotado: boolean) {
    return this.db.forRequest(async (q) => {
      const date = await this.resolveDate(q, fecha);
      const r = await q.query(
        `UPDATE menu_diario_detalle d
            SET agotado = $3, agotado_en = CASE WHEN $3::boolean THEN COALESCE(d.agotado_en, CURRENT_TIMESTAMP) END
           FROM menu_diario_cabecera c
          WHERE c.menu_diario_id = d.menu_diario_id AND c.restaurante_id = app_tenant_id() AND c.fecha_local = $1 AND d.menu_diario_detalle_id = $2`,
        [date, itemId, agotado],
      );
      if (!r.rowCount) throw new NotFoundException('Ese plato no está en el menú de ese día.');
      return this.render(q, date);
    });
  }

  // --- Internos ---

  private async resolveDate(q: Queryable, fecha: string): Promise<string> {
    if (fecha !== 'hoy') return fecha;
    return this.today(q);
  }

  /** Fecha de hoy en la zona horaria del restaurante (no la del servidor). */
  async today(q: Queryable): Promise<string> {
    const r = await q.query<{ hoy: string }>(
      '(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date::text AS hoy FROM restaurante WHERE restaurante_id = app_tenant_id())',
    );
    return r.rows[0]!.hoy;
  }

  private async assertEditable(q: Queryable, date: string) {
    if (date < (await this.today(q))) throw new ConflictException('No se puede modificar el menú de un día pasado.');
  }

  private async find(q: Queryable, date: string) {
    const r = await q.query<{ menu_diario_id: string; publicado_en: Date | null }>(
      'SELECT menu_diario_id, publicado_en FROM menu_diario_cabecera WHERE restaurante_id = app_tenant_id() AND fecha_local = $1',
      [date],
    );
    return r.rows[0];
  }

  private async ensureMenu(q: Queryable, date: string): Promise<string> {
    await q.query(
      'INSERT INTO menu_diario_cabecera (restaurante_id, fecha_local) VALUES (app_tenant_id(), $1) ON CONFLICT (restaurante_id, fecha_local) DO NOTHING',
      [date],
    );
    return (await this.find(q, date))!.menu_diario_id;
  }

  private async render(q: Queryable, date: string) {
    const menu = await this.find(q, date);
    const items = menu ? (await fetchMenuItems(q, menu.menu_diario_id)).map(toMenuItem) : [];
    return { fecha: date, publicado: Boolean(menu?.publicado_en), publicadoEn: menu?.publicado_en ?? null, items };
  }
}
