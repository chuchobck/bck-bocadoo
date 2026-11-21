import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { AuthUser } from '../authz/current-user';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { UUID_RE, HOY_LOCAL, restaurantePausado } from '../diner/common';
import { CATEGORIAS_CARTA, platoAgotadoSql } from '../menu/carta';

/** Secciones que forman el almuerzo (igual que en los pedidos); lo demás va como plato suelto con cantidad. */
export const SECCIONES_ALMUERZO = ['JUGO', 'SOPA', 'FUERTE', 'POSTRE'] as const;

class SeleccionAlmuerzoDto {
  @ApiProperty({
    description: 'public_id de los platos del almuerzo, del menú publicado de hoy: a lo sumo uno por sección (JUGO, SOPA, FUERTE, POSTRE)',
    example: ['uuid-sopa', 'uuid-fuerte'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @Matches(UUID_RE, { each: true, message: 'cada plato debe ser un UUID' })
  platos!: string[];
}

class SeleccionExtraDto {
  @ApiProperty({ description: 'public_id de un plato con precio: de la carta fija (a la carta, extra, bebida) o del menú de hoy' })
  @Matches(UUID_RE, { message: 'plato debe ser un UUID' })
  plato!: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) cantidad!: number;
}

export class SeleccionDto {
  @ApiPropertyOptional({ type: SeleccionAlmuerzoDto, description: 'Omitido = sin almuerzo' })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeleccionAlmuerzoDto)
  almuerzo?: SeleccionAlmuerzoDto;
  @ApiPropertyOptional({ type: [SeleccionExtraDto], description: 'Platos sueltos con cantidad; un mismo plato no se repite' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique((e: SeleccionExtraDto) => String(e?.plato).toLowerCase())
  @ValidateNested({ each: true })
  @Type(() => SeleccionExtraDto)
  extras?: SeleccionExtraDto[];
}

class PlatoAlmuerzoSeleccion {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty({ enum: SECCIONES_ALMUERZO }) seccion!: string;
}
class AlmuerzoSeleccion {
  @ApiProperty({ type: [PlatoAlmuerzoSeleccion] }) platos!: PlatoAlmuerzoSeleccion[];
}
class ExtraSeleccion {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty({ example: 'BEBIDA', description: 'Categoría del plato' }) categoria!: string;
  @ApiProperty({ example: 2 }) cantidad!: number;
}
export class SeleccionMiembroResponse {
  @ApiPropertyOptional({ type: AlmuerzoSeleccion, nullable: true, description: 'null = no eligió almuerzo' })
  almuerzo!: AlmuerzoSeleccion | null;
  @ApiProperty({ type: [ExtraSeleccion] }) extras!: ExtraSeleccion[];
}

type Seleccion = { almuerzo: { platos: { id: string; nombre: string; seccion: string }[] } | null; extras: ExtraSeleccion[] };
const ORDEN_SECCION: Record<string, number> = { JUGO: 1, SOPA: 2, FUERTE: 3, POSTRE: 4 };

/**
 * Selección de cada miembro de una mesa. Lo que RLS deje ver: el personal del local (tenant) ve todo; el anfitrión ve
 * la de toda su mesa; un invitado solo la suya. Devuelve un mapa `miembro_id` → selección (vacía si no eligió nada).
 */
export async function loadSelections(q: Queryable, mesaId: string): Promise<Map<string, Seleccion>> {
  const r = await q.query<{
    miembro_id: string;
    public_id: string;
    nombre: string;
    categoria: string;
    seccion: string | null;
    cantidad: number;
  }>(
    `SELECT i.miembro_id, p.public_id, p.nombre, p.categoria, i.seccion, i.cantidad
       FROM mesa_compartida_miembro_item i JOIN plato p ON p.restaurante_id = i.restaurante_id AND p.plato_id = i.plato_id
      WHERE i.mesa_compartida_id = $1 ORDER BY i.item_id`,
    [mesaId],
  );
  const out = new Map<string, Seleccion>();
  for (const row of r.rows) {
    const s = out.get(String(row.miembro_id)) ?? { almuerzo: null, extras: [] };
    if (row.seccion) {
      s.almuerzo ??= { platos: [] };
      s.almuerzo.platos.push({ id: row.public_id, nombre: row.nombre, seccion: row.seccion });
      s.almuerzo.platos.sort((a, b) => ORDEN_SECCION[a.seccion]! - ORDEN_SECCION[b.seccion]!);
    } else {
      s.extras.push({ id: row.public_id, nombre: row.nombre, categoria: row.categoria, cantidad: row.cantidad });
    }
    out.set(String(row.miembro_id), s);
  }
  return out;
}

export const seleccionDe = (m: Map<string, Seleccion>, miembroId: string): Seleccion =>
  m.get(String(miembroId)) ?? { almuerzo: null, extras: [] };

interface PlatoRow {
  plato_id: string;
  public_id: string;
  nombre: string;
  categoria: string;
  activo: boolean;
  precio: string | null;
  en_menu: boolean;
  menu_seccion: string | null;
  agotado: boolean;
}

/**
 * El comensal elige lo suyo en una mesa compartida. Corre como el comensal (userId, sin tenant); RLS exige que sea su
 * propia fila de miembro y que la mesa siga abierta. Se valida con las mismas reglas que una preorden: menú publicado de
 * hoy, agotados, sección única y precio; además los platos de la carta fija, que no dependen del menú del día.
 */
@Injectable()
export class TableSelectionService {
  constructor(private readonly db: DbService) {}

  set(user: AuthUser, mesaPublicId: string, dto: SeleccionDto): Promise<void> {
    return this.db.scope({ userId: user.userId }, async (q) => {
      const m = (
        await q.query<{
          mesa_compartida_id: string;
          restaurante_id: string;
          miembro_id: string;
          mesa_estado: string;
          validada_en: Date | null;
          restaurante_estado: string;
          hoy: string;
        }>(
          `SELECT m.mesa_compartida_id, m.restaurante_id, x.miembro_id, m.estado AS mesa_estado, m.validada_en,
                  r.estado AS restaurante_estado, ${HOY_LOCAL('r')}::text AS hoy
             FROM mesa_compartida m
             JOIN restaurante r ON r.restaurante_id = m.restaurante_id
             JOIN mesa_compartida_miembro x ON x.mesa_compartida_id = m.mesa_compartida_id AND x.usuario_id = app_user_id()
            WHERE m.public_id = $1`,
          [mesaPublicId],
        )
      ).rows[0];
      if (!m) throw notFound('MESA_NO_ENCONTRADA', 'Mesa no encontrada.');
      if (m.validada_en || !['ABIERTA', 'EN_CAMINO'].includes(m.mesa_estado))
        throw conflict('MESA_CERRADA', 'La mesa ya no admite cambios en la selección.');
      if (m.restaurante_estado === 'PAUSADO') throw restaurantePausado();
      if (m.restaurante_estado !== 'ACTIVO') throw conflict('RESTAURANTE_NO_DISPONIBLE', 'El restaurante no está disponible.');

      const lunchIds = (dto.almuerzo?.platos ?? []).map((p) => p.toLowerCase());
      const extras = (dto.extras ?? []).map((e) => ({ plato: e.plato.toLowerCase(), cantidad: e.cantidad }));
      if (extras.some((e) => lunchIds.includes(e.plato)))
        throw badRequest('SELECCION_INVALIDA', 'Un plato del almuerzo no puede repetirse como plato suelto.');

      // Menú publicado de hoy (fecha local del local), si lo hay.
      const menuId = (
        await q.query<{ menu_diario_id: string }>(
          'SELECT menu_diario_id FROM menu_diario_cabecera WHERE restaurante_id = $1 AND fecha_local = $2::date AND publicado_en IS NOT NULL',
          [m.restaurante_id, m.hoy],
        )
      ).rows[0]?.menu_diario_id;
      if (lunchIds.length && !menuId) throw conflict('MENU_NO_PUBLICADO', 'El restaurante aún no publicó el menú de hoy.');

      const wanted = [...new Set([...lunchIds, ...extras.map((e) => e.plato)])];
      const found = new Map(
        (wanted.length
          ? await q.query<PlatoRow>(
              `SELECT p.plato_id, p.public_id, p.nombre, p.categoria, p.activo, COALESCE(d.precio_centavos, p.precio_centavos) AS precio,
                        d.menu_diario_detalle_id IS NOT NULL AS en_menu, d.seccion AS menu_seccion,
                        (COALESCE(d.agotado, false) OR ${platoAgotadoSql('p', 'r')}) AS agotado
                   FROM plato p JOIN restaurante r ON r.restaurante_id = p.restaurante_id
                   LEFT JOIN menu_diario_detalle d ON d.plato_id = p.plato_id AND d.menu_diario_id = $3::bigint
                  WHERE p.restaurante_id = $1 AND p.public_id = ANY($2::uuid[])`,
              [m.restaurante_id, wanted, menuId ?? null],
            )
          : { rows: [] as PlatoRow[] }
        ).rows.map((p) => [p.public_id, p]),
      );
      const get = (id: string) => {
        const p = found.get(id);
        if (!p?.activo) throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no existe en este restaurante o está inactivo.');
        return p;
      };

      const rows: { plato_id: string; seccion: string | null; cantidad: number }[] = [];
      const sections: string[] = [];
      for (const id of lunchIds) {
        const p = get(id);
        if (!p.en_menu) throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no está en el menú de hoy.');
        if (p.agotado) throw conflict('PLATO_AGOTADO', `"${p.nombre}" se agotó.`);
        sections.push(p.menu_seccion!);
        rows.push({ plato_id: p.plato_id, seccion: p.menu_seccion, cantidad: 1 });
      }
      if (sections.some((s) => !(SECCIONES_ALMUERZO as readonly string[]).includes(s)) || new Set(sections).size !== sections.length)
        throw badRequest('ALMUERZO_INVALIDO', `El almuerzo lleva a lo sumo un plato por sección (${SECCIONES_ALMUERZO.join(', ')}).`);
      for (const e of extras) {
        const p = get(e.plato);
        const deCarta = (CATEGORIAS_CARTA as readonly string[]).includes(p.categoria);
        if (!p.en_menu && !deCarta) {
          if (!menuId) throw conflict('MENU_NO_PUBLICADO', 'El restaurante aún no publicó el menú de hoy.');
          throw unprocessable('PLATO_NO_DISPONIBLE', 'Algún plato no está en el menú de hoy.');
        }
        if (p.precio === null) throw unprocessable('PLATO_SIN_PRECIO', `"${p.nombre}" solo se sirve dentro del almuerzo.`);
        if (p.agotado) throw conflict('PLATO_AGOTADO', `"${p.nombre}" se agotó.`);
        rows.push({ plato_id: p.plato_id, seccion: null, cantidad: e.cantidad });
      }

      // Reemplaza la selección completa. El candado evita que dos envíos simultáneos del mismo miembro se pisen.
      await q.query('SELECT pg_advisory_xact_lock($1::bigint)', [m.miembro_id]);
      await q.query('DELETE FROM mesa_compartida_miembro_item WHERE miembro_id = $1', [m.miembro_id]);
      for (const row of rows) {
        await q.query(
          `INSERT INTO mesa_compartida_miembro_item (miembro_id, mesa_compartida_id, restaurante_id, plato_id, seccion, cantidad)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [m.miembro_id, m.mesa_compartida_id, m.restaurante_id, row.plato_id, row.seccion, row.cantidad],
        );
      }
    });
  }
}
