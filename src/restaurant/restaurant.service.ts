import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, Queryable } from '../db/db.service';
import { ActualizarMesaDto, CrearMesaDto, HorarioDto, UpdateRestauranteDto } from './dto';

const COLS = `public_id, nombre, slug, descripcion_corta, etiquetas, pais_codigo, ciudad_id, zona_id, moneda_codigo, zona_horaria,
  direccion, latitud, longitud, telefono_e164, logo_url, puestos, anotar_mesa, momento_cobro, precio_suelto_centavos,
  recargo_para_llevar_centavos, lleno_manual_hasta, estado, creado_en, actualizado_en`;

interface Row {
  public_id: string;
  nombre: string;
  slug: string;
  descripcion_corta: string | null;
  etiquetas: string[];
  pais_codigo: string;
  ciudad_id: string;
  zona_id: string | null;
  moneda_codigo: string;
  zona_horaria: string;
  direccion: string | null;
  latitud: string | null;
  longitud: string | null;
  telefono_e164: string | null;
  logo_url: string | null;
  puestos: number;
  anotar_mesa: boolean;
  momento_cobro: string;
  precio_suelto_centavos: string;
  recargo_para_llevar_centavos: string;
  lleno_manual_hasta: Date | null;
  estado: string;
  creado_en: Date;
  actualizado_en: Date;
}

/** Campo del DTO → columna. Solo lo que está aquí se puede actualizar (nunca estado, slug, moneda ni país). */
const UPDATABLE: Record<keyof UpdateRestauranteDto, string> = {
  nombre: 'nombre',
  descripcionCorta: 'descripcion_corta',
  etiquetas: 'etiquetas',
  direccion: 'direccion',
  latitud: 'latitud',
  longitud: 'longitud',
  telefono: 'telefono_e164',
  logoUrl: 'logo_url',
  puestos: 'puestos',
  anotarMesa: 'anotar_mesa',
  momentoCobro: 'momento_cobro',
  precioSueltoCentavos: 'precio_suelto_centavos',
  recargoParaLlevarCentavos: 'recargo_para_llevar_centavos',
  zonaId: 'zona_id',
};

const num = (v: string | null) => (v === null ? null : Number(v));

export function toRestauranteDto(r: Row) {
  return {
    id: r.public_id,
    nombre: r.nombre,
    slug: r.slug,
    descripcionCorta: r.descripcion_corta,
    etiquetas: r.etiquetas,
    paisCodigo: r.pais_codigo,
    ciudadId: Number(r.ciudad_id),
    zonaId: num(r.zona_id),
    monedaCodigo: r.moneda_codigo,
    zonaHoraria: r.zona_horaria,
    direccion: r.direccion,
    latitud: num(r.latitud),
    longitud: num(r.longitud),
    telefono: r.telefono_e164,
    logoUrl: r.logo_url,
    puestos: r.puestos,
    anotarMesa: r.anotar_mesa,
    momentoCobro: r.momento_cobro,
    precioSueltoCentavos: Number(r.precio_suelto_centavos),
    recargoParaLlevarCentavos: Number(r.recargo_para_llevar_centavos),
    llenoManualHasta: r.lleno_manual_hasta,
    estado: r.estado,
    creadoEn: r.creado_en,
    actualizadoEn: r.actualizado_en,
  };
}

@Injectable()
export class RestaurantService {
  constructor(private readonly db: DbService) {}

  async get() {
    return this.db.forRequest(async (q) => toRestauranteDto(await this.load(q)), { readOnly: true });
  }

  async update(dto: UpdateRestauranteDto) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of Object.entries(UPDATABLE) as [keyof UpdateRestauranteDto, string][]) {
      if (dto[key] === undefined) continue;
      params.push(dto[key]);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) throw new BadRequestException('No hay nada que actualizar.');
    return this.db.forRequest(async (q) => {
      if (dto.zonaId) {
        const z = await q.query(
          `SELECT 1 FROM zona z WHERE z.zona_id = $1 AND z.activa AND z.ciudad_id = (SELECT ciudad_id FROM restaurante WHERE restaurante_id = app_tenant_id())`,
          [dto.zonaId],
        );
        if (!z.rowCount) throw new BadRequestException('zonaId no existe o no es de la ciudad del local.');
      }
      const r = await q.query<Row>(
        `UPDATE restaurante SET ${sets.join(', ')}, actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() RETURNING ${COLS}`,
        params,
      );
      return toRestauranteDto(r.rows[0]!);
    });
  }

  /** BORRADOR/PAUSADO → ACTIVO, solo si el local ya se puede mostrar. */
  async activate() {
    return this.db.forRequest(async (q) => {
      const r = await this.load(q);
      if (r.estado === 'ACTIVO') return toRestauranteDto(r);
      if (r.estado === 'BAJA') throw new ConflictException('Un restaurante dado de baja no se puede activar.');
      const h = await q.query('SELECT 1 FROM restaurante_horario WHERE restaurante_id = app_tenant_id() LIMIT 1');
      const faltan: string[] = [];
      if (Number(r.precio_suelto_centavos) <= 0) faltan.push('precio del almuerzo suelto');
      if (!h.rowCount) faltan.push('al menos un horario');
      if (faltan.length) throw new ConflictException(`Para activar el local falta: ${faltan.join(' y ')}.`);
      const u = await q.query<Row>(
        `UPDATE restaurante SET estado = 'ACTIVO', actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() RETURNING ${COLS}`,
      );
      return toRestauranteDto(u.rows[0]!);
    });
  }

  async pause() {
    return this.db.forRequest(async (q) => {
      const r = await this.load(q);
      if (r.estado === 'PAUSADO') return toRestauranteDto(r);
      if (r.estado !== 'ACTIVO') throw new ConflictException('Solo un restaurante activo se puede pausar.');
      const u = await q.query<Row>(
        `UPDATE restaurante SET estado = 'PAUSADO', actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() RETURNING ${COLS}`,
      );
      return toRestauranteDto(u.rows[0]!);
    });
  }

  // --- Horarios ---------------------------------------------------------------------------------------------------

  async getHorarios() {
    return this.db.forRequest((q) => this.loadHorarios(q), { readOnly: true });
  }

  async replaceHorarios(horarios: HorarioDto[]) {
    const byDay = new Map<number, HorarioDto[]>();
    for (const h of horarios) {
      if (h.cierra <= h.abre)
        throw new BadRequestException(`Día ${h.diaSemana}: cierra (${h.cierra}) debe ser posterior a abre (${h.abre}).`);
      byDay.set(h.diaSemana, [...(byDay.get(h.diaSemana) ?? []), h]);
    }
    for (const [dia, list] of byDay) {
      const sorted = [...list].sort((a, b) => a.abre.localeCompare(b.abre));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.abre < sorted[i - 1]!.cierra) throw new BadRequestException(`Día ${dia}: los horarios se traslapan.`);
      }
    }
    return this.db.forRequest(async (q) => {
      await q.query('DELETE FROM restaurante_horario WHERE restaurante_id = app_tenant_id()');
      for (const h of horarios) {
        await q.query('INSERT INTO restaurante_horario (restaurante_id, dia_semana, abre, cierra) VALUES (app_tenant_id(), $1, $2, $3)', [
          h.diaSemana,
          h.abre,
          h.cierra,
        ]);
      }
      return this.loadHorarios(q);
    });
  }

  private async loadHorarios(q: Queryable) {
    const r = await q.query<{ dia_semana: number; abre: string; cierra: string }>(
      `SELECT dia_semana, to_char(abre, 'HH24:MI') AS abre, to_char(cierra, 'HH24:MI') AS cierra
         FROM restaurante_horario WHERE restaurante_id = app_tenant_id() ORDER BY dia_semana, abre`,
    );
    return r.rows.map((h) => ({ diaSemana: h.dia_semana, abre: h.abre, cierra: h.cierra }));
  }

  // --- Mesas ------------------------------------------------------------------------------------------------------

  async listMesas() {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<MesaRow>(
          'SELECT mesa_local_id, etiqueta, capacidad, activo FROM mesa_local WHERE restaurante_id = app_tenant_id() ORDER BY etiqueta',
        );
        return r.rows.map(toMesa);
      },
      { readOnly: true },
    );
  }

  async createMesa(dto: CrearMesaDto) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<MesaRow>(
        'INSERT INTO mesa_local (restaurante_id, etiqueta, capacidad) VALUES (app_tenant_id(), $1, $2) RETURNING mesa_local_id, etiqueta, capacidad, activo',
        [dto.etiqueta, dto.capacidad],
      );
      return toMesa(r.rows[0]!);
    });
  }

  async updateMesa(id: string, dto: ActualizarMesaDto) {
    const fields: [string, unknown][] = [
      ['etiqueta', dto.etiqueta],
      ['capacidad', dto.capacidad],
      ['activo', dto.activo],
    ];
    const present = fields.filter(([, v]) => v !== undefined);
    if (!present.length) throw new BadRequestException('No hay nada que actualizar.');
    return this.db.forRequest(async (q) => {
      const r = await q.query<MesaRow>(
        `UPDATE mesa_local SET ${present.map(([c], i) => `${c} = $${i + 2}`).join(', ')}
          WHERE restaurante_id = app_tenant_id() AND mesa_local_id = $1 RETURNING mesa_local_id, etiqueta, capacidad, activo`,
        [id, ...present.map(([, v]) => v)],
      );
      if (!r.rows[0]) throw new NotFoundException('Mesa no encontrada.');
      return toMesa(r.rows[0]);
    });
  }

  // --- "Local lleno" ----------------------------------------------------------------------------------------------

  /** Marca "Local lleno" por 20 minutos (expira solo) o lo quita. */
  async setFull(lleno: boolean) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ lleno_manual_hasta: Date | null }>(
        `UPDATE restaurante SET lleno_manual_hasta = CASE WHEN $1::boolean THEN CURRENT_TIMESTAMP + interval '20 minutes' END
          WHERE restaurante_id = app_tenant_id() RETURNING lleno_manual_hasta`,
        [lleno],
      );
      return { lleno, llenoManualHasta: r.rows[0]!.lleno_manual_hasta };
    });
  }

  private async load(q: Queryable): Promise<Row> {
    const r = await q.query<Row>(`SELECT ${COLS} FROM restaurante WHERE restaurante_id = app_tenant_id()`);
    if (!r.rows[0]) throw new NotFoundException('Restaurante no encontrado.');
    return r.rows[0];
  }
}

interface MesaRow {
  mesa_local_id: string;
  etiqueta: string;
  capacidad: number;
  activo: boolean;
}
const toMesa = (m: MesaRow) => ({ id: m.mesa_local_id, etiqueta: m.etiqueta, capacidad: m.capacidad, activo: m.activo });
