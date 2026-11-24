import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { AuthUser } from '../authz/current-user';
import { avisarExtrasDeprecado } from '../common/deprecaciones';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { UUID_RE, HOY_LOCAL, restaurantePausado } from '../diner/common';
import { platoAgotadoSql } from '../menu/carta';
import { validarPlatoSuelto } from '../cobro/platos';
import { cargarOfertas, validarOfertaDeAlmuerzo, validarOfertaParaPedir } from '../cobro/ofertas';
import { OfertaItemDto, OfertaPedidaResponse } from '../cobro/ofertas.dto';

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
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Oferta flash del almuerzo de este comensal: se cobra el precio de la oferta y no consume plan. Su plato (categoría ALMUERZO) debe ser uno de `platos`; ' +
      'si no, 422 `OFERTA_NO_APLICA_ALMUERZO`. No reserva stock: se toma al validar la mesa en caja.',
  })
  @IsOptional()
  @Matches(UUID_RE, { message: 'ofertaId debe ser un UUID' })
  ofertaId?: string;
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
  @ApiPropertyOptional({
    type: [SeleccionExtraDto],
    deprecated: true,
    description:
      'Platos sueltos con cantidad; un mismo plato no se repite. **Deprecado (PR 9):** sigue funcionando igual (carta fija o menú de ' +
      'hoy); se reemplazará en un PR futuro anunciado.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ArrayUnique((e: SeleccionExtraDto) => String(e?.plato).toLowerCase())
  @ValidateNested({ each: true })
  @Type(() => SeleccionExtraDto)
  extras?: SeleccionExtraDto[];
  @ApiPropertyOptional({
    type: [OfertaItemDto],
    maxItems: 5,
    description:
      'Ofertas flash de este comensal como ítems (su plato, al precio de la oferta; no consumen plan). Solo ofertas con plato. ' +
      'El plato de una oferta no puede repetirse en `almuerzo` ni en `extras`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique((o: OfertaItemDto) => String(o?.oferta).toLowerCase())
  @ValidateNested({ each: true })
  @Type(() => OfertaItemDto)
  ofertas?: OfertaItemDto[];
}

class PlatoAlmuerzoSeleccion {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() nombre!: string;
  @ApiProperty({ enum: SECCIONES_ALMUERZO }) seccion!: string;
}
class AlmuerzoSeleccion {
  @ApiProperty({ type: [PlatoAlmuerzoSeleccion] }) platos!: PlatoAlmuerzoSeleccion[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Oferta flash del almuerzo; null si no hay' })
  ofertaId!: string | null;
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
  @ApiProperty({ type: [OfertaPedidaResponse], description: 'Ofertas flash elegidas como ítems (vacío si no eligió ninguna)' })
  ofertas!: OfertaPedidaResponse[];
}

type Seleccion = {
  almuerzo: { platos: { id: string; nombre: string; seccion: string }[]; ofertaId: string | null } | null;
  extras: ExtraSeleccion[];
  ofertas: OfertaPedidaResponse[];
};
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
    oferta_public_id: string | null;
    oferta_titulo: string | null;
    oferta_precio: string | null;
  }>(
    `SELECT i.miembro_id, p.public_id, p.nombre, p.categoria, i.seccion, i.cantidad,
            o.public_id AS oferta_public_id, o.titulo AS oferta_titulo, o.precio_centavos AS oferta_precio
       FROM mesa_compartida_miembro_item i JOIN plato p ON p.restaurante_id = i.restaurante_id AND p.plato_id = i.plato_id
       LEFT JOIN oferta_flash o ON o.restaurante_id = i.restaurante_id AND o.oferta_flash_id = i.oferta_flash_id
      WHERE i.mesa_compartida_id = $1 ORDER BY i.item_id`,
    [mesaId],
  );
  const out = new Map<string, Seleccion>();
  for (const row of r.rows) {
    const s = out.get(String(row.miembro_id)) ?? { almuerzo: null, extras: [], ofertas: [] };
    if (row.seccion) {
      s.almuerzo ??= { platos: [], ofertaId: null };
      s.almuerzo.platos.push({ id: row.public_id, nombre: row.nombre, seccion: row.seccion });
      s.almuerzo.platos.sort((a, b) => ORDEN_SECCION[a.seccion]! - ORDEN_SECCION[b.seccion]!);
    } else if (row.oferta_public_id) {
      const precio = Number(row.oferta_precio);
      s.ofertas.push({
        id: row.oferta_public_id,
        titulo: row.oferta_titulo!,
        cantidad: row.cantidad,
        precioUnitarioCentavos: precio,
        subtotalCentavos: row.cantidad * precio,
      });
    } else {
      s.extras.push({ id: row.public_id, nombre: row.nombre, categoria: row.categoria, cantidad: row.cantidad });
    }
    out.set(String(row.miembro_id), s);
  }
  // Oferta del almuerzo de cada miembro (columna de la fila del miembro; la escribe fn_fijar_oferta_almuerzo).
  const of = await q.query<{ miembro_id: string; oferta_public_id: string }>(
    `SELECT x.miembro_id, o.public_id AS oferta_public_id
       FROM mesa_compartida_miembro x JOIN oferta_flash o ON o.restaurante_id = x.restaurante_id AND o.oferta_flash_id = x.almuerzo_oferta_flash_id
      WHERE x.mesa_compartida_id = $1`,
    [mesaId],
  );
  for (const x of of.rows) {
    const s = out.get(String(x.miembro_id));
    if (s?.almuerzo) s.almuerzo.ofertaId = x.oferta_public_id;
  }
  return out;
}

export const seleccionDe = (m: Map<string, Seleccion>, miembroId: string): Seleccion =>
  m.get(String(miembroId)) ?? { almuerzo: null, extras: [], ofertas: [] };

const saliste = () => conflict('SALISTE_DE_LA_MESA', 'Saliste de esta mesa: vuelve a unirte con el link para elegir.');

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
          restaurante_public_id: string;
          miembro_id: string;
          mesa_estado: string;
          validada_en: Date | null;
          restaurante_estado: string;
          hoy: string;
          salio: boolean;
        }>(
          `SELECT m.mesa_compartida_id, m.restaurante_id, r.public_id AS restaurante_public_id, x.miembro_id, m.estado AS mesa_estado, m.validada_en, x.salio_en IS NOT NULL AS salio,
                  r.estado AS restaurante_estado, ${HOY_LOCAL('r')}::text AS hoy
             FROM mesa_compartida m
             JOIN restaurante r ON r.restaurante_id = m.restaurante_id
             JOIN mesa_compartida_miembro x ON x.mesa_compartida_id = m.mesa_compartida_id AND x.usuario_id = app_user_id()
            WHERE m.public_id = $1`,
          [mesaPublicId],
        )
      ).rows[0];
      if (!m) throw notFound('MESA_NO_ENCONTRADA', 'Mesa no encontrada.');
      avisarExtrasDeprecado(dto.extras, String(m.restaurante_public_id), 'PUT /v1/mis/mesas/{id}/seleccion');
      if (m.salio) throw saliste();
      if (m.validada_en || !['ABIERTA', 'EN_CAMINO'].includes(m.mesa_estado))
        throw conflict('MESA_CERRADA', 'La mesa ya no admite cambios en la selección.');
      if (m.restaurante_estado === 'PAUSADO') throw restaurantePausado();
      if (m.restaurante_estado !== 'ACTIVO') throw conflict('RESTAURANTE_NO_DISPONIBLE', 'El restaurante no está disponible.');

      const lunchIds = (dto.almuerzo?.platos ?? []).map((p) => p.toLowerCase());
      const extras = (dto.extras ?? []).map((e) => ({ plato: e.plato.toLowerCase(), cantidad: e.cantidad }));
      if (extras.some((e) => lunchIds.includes(e.plato)))
        throw badRequest('SELECCION_INVALIDA', 'Un plato del almuerzo no puede repetirse como plato suelto.');

      // Ofertas (E.8): existen en el local, tienen plato y se pueden elegir ahora; el stock no se reserva (se toma al validar
      // la mesa en caja, I-7). La del almuerzo es de un plato ALMUERZO de los elegidos; las sueltas no repiten plato.
      const ofertaAlmuerzoId = dto.almuerzo?.ofertaId?.toLowerCase() ?? null;
      const ofertasPedidas = (dto.ofertas ?? []).map((o) => ({ oferta: o.oferta.toLowerCase(), cantidad: o.cantidad }));
      const ofertas = await cargarOfertas(q, m.restaurante_id, [
        ...(ofertaAlmuerzoId ? [ofertaAlmuerzoId] : []),
        ...ofertasPedidas.map((o) => o.oferta),
      ]);
      const necesita = new Map<string, number>();
      if (ofertaAlmuerzoId) necesita.set(ofertaAlmuerzoId, 1);
      for (const o of ofertasPedidas) necesita.set(o.oferta, (necesita.get(o.oferta) ?? 0) + o.cantidad);
      const ofertaOk = (id: string) => validarOfertaParaPedir(ofertas.get(id), necesita.get(id)!);
      const ofertaAlmuerzo = ofertaAlmuerzoId ? ofertaOk(ofertaAlmuerzoId) : null;
      if (ofertaAlmuerzo) validarOfertaDeAlmuerzo(ofertaAlmuerzo, lunchIds);
      const ofertasSueltas = ofertasPedidas.map((o) => ({ ...o, fila: ofertaOk(o.oferta) }));
      const platosUsados = new Set([...lunchIds, ...extras.map((e) => e.plato)]);
      for (const o of ofertasSueltas) {
        const plato = o.fila.plato_public_id.toLowerCase();
        if (platosUsados.has(plato))
          throw badRequest(
            'SELECCION_INVALIDA',
            'El plato de una oferta no puede repetirse en el almuerzo, en los platos sueltos ni en otra oferta.',
          );
        platosUsados.add(plato);
      }

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

      const rows: { plato_id: string; seccion: string | null; cantidad: number; oferta_flash_id?: string }[] = [];
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
        // Mismas reglas que los platos sueltos de la caja (src/cobro/platos.ts).
        const p = validarPlatoSuelto(get(e.plato), menuId !== undefined);
        rows.push({ plato_id: p.plato_id, seccion: null, cantidad: e.cantidad });
      }

      for (const o of ofertasSueltas)
        rows.push({ plato_id: o.fila.plato_id!, seccion: null, cantidad: o.cantidad, oferta_flash_id: o.fila.oferta_flash_id });

      // Reemplaza la selección completa. El candado evita que dos envíos simultáneos del mismo miembro se pisen, y es el
      // mismo de fn_salir_mesa y de validar la mesa: si el miembro salió (o la caja validó) mientras tanto, se ve aquí.
      await q.query('SELECT pg_advisory_xact_lock($1::bigint)', [m.miembro_id]);
      const ahora = (
        await q.query<{ salio: boolean; abierta: boolean }>(
          `SELECT x.salio_en IS NOT NULL AS salio, (m.estado IN ('ABIERTA', 'EN_CAMINO') AND m.validada_en IS NULL) AS abierta
             FROM mesa_compartida_miembro x JOIN mesa_compartida m ON m.mesa_compartida_id = x.mesa_compartida_id WHERE x.miembro_id = $1`,
          [m.miembro_id],
        )
      ).rows[0]!;
      if (ahora.salio) throw saliste();
      if (!ahora.abierta) throw conflict('MESA_CERRADA', 'La mesa ya no admite cambios en la selección.');
      await q.query('DELETE FROM mesa_compartida_miembro_item WHERE miembro_id = $1', [m.miembro_id]);
      for (const row of rows) {
        await q.query(
          `INSERT INTO mesa_compartida_miembro_item (miembro_id, mesa_compartida_id, restaurante_id, plato_id, seccion, cantidad, oferta_flash_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [m.miembro_id, m.mesa_compartida_id, m.restaurante_id, row.plato_id, row.seccion, row.cantidad, row.oferta_flash_id ?? null],
        );
      }
      // Oferta del almuerzo: columna de la fila del miembro, que el comensal no puede escribir; la fija (o quita) la función.
      await q.query('SELECT fn_fijar_oferta_almuerzo($1::bigint, $2::uuid)', [m.miembro_id, ofertaAlmuerzoId]);
    });
  }
}
