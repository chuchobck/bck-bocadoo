import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { fetchMenuItems } from '../menu/menu.service';

export interface SearchFilters {
  q?: string;
  zonaId?: string;
  ciudadId?: string;
  etiqueta?: string;
  limit: number;
  cursor?: string;
}

interface ListRow {
  restaurante_id: string;
  public_id: string;
  nombre: string;
  slug: string;
  descripcion_corta: string | null;
  etiquetas: string[];
  zona_id: string | null;
  zona_nombre: string | null;
  ciudad_id: string;
  direccion: string | null;
  latitud: string | null;
  longitud: string | null;
  logo_url: string | null;
  precio_suelto_centavos: string;
  moneda_codigo: string;
  abierto_ahora: boolean;
  personas: number | null;
  puestos: number | null;
  lleno_manual: boolean | null;
}

/** Nivel de ocupación para el comensal: LIBRE (<50%), MODERADO (50–89%), LLENO (≥90% o "Local lleno" manual). */
export function occupancy(personas: number | null, puestos: number | null, llenoManual: boolean | null) {
  const p = personas ?? 0;
  const pct = puestos ? Math.min(100, Math.round((p * 100) / puestos)) : 0;
  const lleno = Boolean(llenoManual) || pct >= 90;
  return { nivel: lleno ? 'LLENO' : pct >= 50 ? 'MODERADO' : 'LIBRE', porcentaje: pct, lleno };
}

const num = (v: string | null) => (v === null ? null : Number(v));

/** Escapa % _ \ para usar el texto del usuario dentro de un ILIKE. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const encodeCursor = (nombre: string, id: string) => Buffer.from(JSON.stringify({ n: nombre, i: id })).toString('base64url');
function decodeCursor(cursor: string): { n: string; i: string } {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { n?: unknown; i?: unknown };
    if (typeof c.n === 'string' && typeof c.i === 'string' && /^[1-9][0-9]{0,17}$/.test(c.i)) return { n: c.n, i: c.i };
  } catch {
    /* cae al error de abajo */
  }
  throw new BadRequestException('cursor inválido.');
}

const OPEN_NOW = `EXISTS (SELECT 1 FROM restaurante_horario h
        WHERE h.restaurante_id = r.restaurante_id
          AND h.dia_semana = EXTRACT(ISODOW FROM (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria))::int
          AND (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::time >= h.abre
          AND (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::time < h.cierra)`;

const BASE_SELECT = `SELECT r.restaurante_id, r.public_id, r.nombre, r.slug, r.descripcion_corta, r.etiquetas, r.zona_id, z.nombre AS zona_nombre,
       r.ciudad_id, r.direccion, r.latitud, r.longitud, r.logo_url, r.precio_suelto_centavos, r.moneda_codigo,
       ${OPEN_NOW} AS abierto_ahora, o.personas, o.puestos, o.lleno_manual
  FROM restaurante r
  LEFT JOIN zona z ON z.zona_id = r.zona_id
  LEFT JOIN LATERAL fn_ocupacion_local(r.restaurante_id) o ON true`;

function toCard(r: ListRow) {
  return {
    id: r.public_id,
    nombre: r.nombre,
    slug: r.slug,
    descripcionCorta: r.descripcion_corta,
    etiquetas: r.etiquetas,
    zona: r.zona_id ? { id: Number(r.zona_id), nombre: r.zona_nombre } : null,
    ciudadId: Number(r.ciudad_id),
    direccion: r.direccion,
    latitud: num(r.latitud),
    longitud: num(r.longitud),
    logoUrl: r.logo_url,
    precioSueltoCentavos: Number(r.precio_suelto_centavos),
    monedaCodigo: r.moneda_codigo,
    abiertoAhora: r.abierto_ahora,
    ocupacion: occupancy(r.personas, r.puestos, r.lleno_manual),
  };
}

/**
 * Vitrina pública: sin token. Corre como bck_api sin tenant; las políticas `lectura_publica` dejan leer todos los
 * restaurantes, por eso TODA consulta filtra estado = 'ACTIVO' y solo devuelve campos públicos.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly db: DbService) {}

  search(f: SearchFilters) {
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.scope({ readOnly: true }, async (q) => {
      const r = await q.query<ListRow>(
        `${BASE_SELECT}
          WHERE r.estado = 'ACTIVO'
            AND ($1::bigint IS NULL OR r.zona_id = $1)
            AND ($2::bigint IS NULL OR r.ciudad_id = $2)
            AND ($3::text IS NULL OR r.nombre ILIKE '%' || $3 || '%')
            AND ($4::text IS NULL OR $4 = ANY(r.etiquetas))
            AND ($5::text IS NULL OR (r.nombre, r.restaurante_id) > ($5, $6::bigint))
          ORDER BY r.nombre, r.restaurante_id
          LIMIT $7`,
        [
          f.zonaId ?? null,
          f.ciudadId ?? null,
          f.q ? likeEscape(f.q) : null,
          f.etiqueta ?? null,
          cur?.n ?? null,
          cur?.i ?? null,
          f.limit + 1,
        ],
      );
      const page = r.rows.slice(0, f.limit);
      const last = page.at(-1);
      return {
        items: page.map(toCard),
        nextCursor: r.rows.length > f.limit && last ? encodeCursor(last.nombre, last.restaurante_id) : null,
      };
    });
  }

  detail(slug: string) {
    return this.db.scope({ readOnly: true }, async (q) => {
      const r = await q.query<ListRow & { telefono_e164: string | null; hoy: string }>(
        `${BASE_SELECT.replace('r.moneda_codigo,', 'r.moneda_codigo, r.telefono_e164, (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date::text AS hoy,')}
          WHERE r.estado = 'ACTIVO' AND r.slug = $1`,
        [slug],
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundException('Restaurante no encontrado.');
      const [horarios, menu, planes] = await Promise.all([
        this.horarios(q, row.restaurante_id),
        this.menuOfDay(q, row.restaurante_id, row.hoy),
        this.plans(q, row.restaurante_id),
      ]);
      return { ...toCard(row), telefono: row.telefono_e164, horarios, menuHoy: menu, planes };
    });
  }

  private async horarios(q: Queryable, id: string) {
    const r = await q.query<{ dia_semana: number; abre: string; cierra: string }>(
      `SELECT dia_semana, to_char(abre, 'HH24:MI') AS abre, to_char(cierra, 'HH24:MI') AS cierra
         FROM restaurante_horario WHERE restaurante_id = $1 ORDER BY dia_semana, abre`,
      [id],
    );
    return r.rows.map((h) => ({ diaSemana: h.dia_semana, abre: h.abre, cierra: h.cierra }));
  }

  /** Solo el menú publicado de hoy (en la zona horaria del local); un borrador nunca se ve. */
  private async menuOfDay(q: Queryable, id: string, hoy: string) {
    const m = await q.query<{ menu_diario_id: string }>(
      'SELECT menu_diario_id FROM menu_diario_cabecera WHERE restaurante_id = $1 AND fecha_local = $2 AND publicado_en IS NOT NULL',
      [id, hoy],
    );
    if (!m.rows[0]) return { fecha: hoy, publicado: false, secciones: [] as { seccion: string; platos: unknown[] }[] };
    const items = await fetchMenuItems(q, m.rows[0].menu_diario_id);
    const secciones = new Map<string, unknown[]>();
    for (const it of items) {
      // Solo lo que ve el comensal: sin ids internos, porciones ni horas de agotado. `id` (public_id) sirve para pedir.
      const plato = {
        id: it.plato_public_id,
        nombre: it.nombre,
        descripcion: it.descripcion,
        fotoUrl: it.foto_url,
        etiquetas: it.etiquetas,
        precioCentavos: it.precio === null ? null : Number(it.precio),
        agotado: it.agotado,
      };
      secciones.set(it.seccion, [...(secciones.get(it.seccion) ?? []), plato]);
    }
    return { fecha: hoy, publicado: true, secciones: [...secciones].map(([seccion, platos]) => ({ seccion, platos })) };
  }

  private async plans(q: Queryable, id: string) {
    const r = await q.query<{
      plantilla_plan_id: string;
      tipo: string;
      nombre: string;
      almuerzos: number;
      precio_centavos: string;
      vigencia_dias: number;
      dias_validos: number[];
      incluye: string[];
    }>(
      `SELECT plantilla_plan_id, tipo, nombre, almuerzos, precio_centavos, vigencia_dias, dias_validos, incluye
         FROM plantilla_plan WHERE restaurante_id = $1 AND activo AND visible_en_marketplace ORDER BY almuerzos, precio_centavos`,
      [id],
    );
    return r.rows.map((p) => ({
      id: String(p.plantilla_plan_id),
      tipo: p.tipo,
      nombre: p.nombre,
      almuerzos: p.almuerzos,
      precioCentavos: Number(p.precio_centavos),
      vigenciaDias: p.vigencia_dias,
      diasValidos: p.dias_validos,
      incluye: p.incluye,
    }));
  }
}
