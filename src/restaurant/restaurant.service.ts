import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { unprocessable } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { ActualizarMesaDto, CrearMesaDto, HorarioDto, LlenoDto, NivelManual, UpdateRestauranteDto } from './dto';
import { menuAgotadoSql, occupancy } from '../catalog/catalog.service';
import { datosPendientes, enmascararCedulaRuc, validarPerfil } from './profile';

/** La cédula/RUC vive en `restaurante_fiscal` (tabla privada del tenant), no en `restaurante`. */
const COLS = `r.public_id, r.nombre, r.slug, r.descripcion_corta, r.etiquetas, r.pais_codigo, r.ciudad_id, r.zona_id, r.moneda_codigo, r.zona_horaria,
  r.direccion, r.latitud, r.longitud, r.telefono_e164, r.logo_url, r.puestos, r.mesas_total, r.puestos_definidos, r.anotar_mesa, r.momento_cobro,
  r.precio_suelto_centavos, r.precio_solo_segundo_centavos, r.precio_solo_sopa_centavos, r.recargo_para_llevar_centavos,
  r.lleno_manual_hasta, r.concurrido_manual_hasta, r.estado, r.creado_en, r.actualizado_en, f.cedula_ruc`;
const FROM = 'FROM restaurante r LEFT JOIN restaurante_fiscal f ON f.restaurante_id = r.restaurante_id';

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
  mesas_total: number | null;
  puestos_definidos: boolean;
  anotar_mesa: boolean;
  momento_cobro: string;
  precio_suelto_centavos: string;
  precio_solo_segundo_centavos: string | null;
  precio_solo_sopa_centavos: string | null;
  recargo_para_llevar_centavos: string;
  cedula_ruc: string | null;
  lleno_manual_hasta: Date | null;
  concurrido_manual_hasta: Date | null;
  estado: string;
  creado_en: Date;
  actualizado_en: Date;
}

/** Campo del DTO → columna. Solo lo que está aquí se puede actualizar (nunca estado, slug, moneda ni país). */
const UPDATABLE: Record<Exclude<keyof UpdateRestauranteDto, 'cedulaRuc'>, string> = {
  nombre: 'nombre',
  descripcionCorta: 'descripcion_corta',
  etiquetas: 'etiquetas',
  direccion: 'direccion',
  latitud: 'latitud',
  longitud: 'longitud',
  telefono: 'telefono_e164',
  logoUrl: 'logo_url',
  puestos: 'puestos',
  mesas: 'mesas_total',
  anotarMesa: 'anotar_mesa',
  momentoCobro: 'momento_cobro',
  precioSueltoCentavos: 'precio_suelto_centavos',
  precioAlmuerzoCentavos: 'precio_suelto_centavos',
  precioSoloSegundoCentavos: 'precio_solo_segundo_centavos',
  precioSoloSopaCentavos: 'precio_solo_sopa_centavos',
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
    mesas: r.mesas_total,
    cedulaRuc: enmascararCedulaRuc(r.cedula_ruc),
    anotarMesa: r.anotar_mesa,
    momentoCobro: r.momento_cobro,
    precioSueltoCentavos: Number(r.precio_suelto_centavos),
    precioAlmuerzoCentavos: Number(r.precio_suelto_centavos),
    precioSoloSegundoCentavos: num(r.precio_solo_segundo_centavos),
    precioSoloSopaCentavos: num(r.precio_solo_sopa_centavos),
    recargoParaLlevarCentavos: Number(r.recargo_para_llevar_centavos),
    llenoManualHasta: r.lleno_manual_hasta,
    concurridoManualHasta: r.concurrido_manual_hasta,
    estado: r.estado,
    creadoEn: r.creado_en,
    actualizadoEn: r.actualizado_en,
  };
}

@Injectable()
export class RestaurantService {
  constructor(private readonly db: DbService) {}

  async get() {
    return this.db.forRequest(
      async (q) => {
        const r = await this.load(q);
        // fn_ocupacion_local decide la vigencia con el reloj de la base y solo devuelve fila si el local está ACTIVO.
        const o = await q.query<{ personas: number; puestos: number; lleno_manual: boolean; concurrido_manual: boolean }>(
          'SELECT personas, puestos, lleno_manual, concurrido_manual FROM fn_ocupacion_local(app_tenant_id())',
        );
        const f = o.rows[0];
        const m = await q.query<{ menu_agotado: boolean }>(
          `SELECT ${menuAgotadoSql('r')} AS menu_agotado FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
        );
        const pendientes = datosPendientes(r);
        return {
          ...toRestauranteDto(r),
          perfilCompleto: pendientes.length === 0,
          datosPendientes: pendientes,
          menuAgotado: m.rows[0]?.menu_agotado ?? false,
          ocupacion: f ? occupancy(f.personas, f.puestos, f.lleno_manual, f.concurrido_manual) : null,
        };
      },
      { readOnly: true },
    );
  }

  async update(dto: UpdateRestauranteDto) {
    return this.db.forRequest(async (q) => {
      // Se bloquea la fila: las comparaciones con lo guardado (puestos ≥ mesas) no se cruzan con otro PATCH.
      const actual = await this.load(q, true);
      const perfil = validarPerfil(actual.pais_codigo, dto, {
        puestos: actual.puestos,
        puestosDefinidos: actual.puestos_definidos,
        mesas: actual.mesas_total,
      });
      // P > 0 en un local ACTIVO (PR 6c, I-12): con P = 0 la caja no puede cobrar el almuerzo suelto ni abrir su cuenta.
      // `null` o `""` ya los rechaza el DTO (400) en cualquier estado: la columna es NOT NULL. El candado de la fila
      // ordena este PATCH con `activar`, que exige lo mismo.
      const precio = dto.precioAlmuerzoCentavos ?? dto.precioSueltoCentavos;
      if (precio !== undefined && precio <= 0 && actual.estado === 'ACTIVO')
        throw unprocessable(
          'PRECIO_ALMUERZO_REQUERIDO',
          'Un local activo necesita precio del almuerzo mayor que 0. Para dejarlo sin precio, primero pausa el local.',
        );
      const values: Partial<Record<keyof UpdateRestauranteDto, unknown>> = { ...dto, telefono: perfil.telefono };
      // precioSueltoCentavos y precioAlmuerzoCentavos son la misma columna (ya validados como iguales si vienen ambos).
      if (dto.precioAlmuerzoCentavos !== undefined) delete values.precioSueltoCentavos;

      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, col] of Object.entries(UPDATABLE) as [Exclude<keyof UpdateRestauranteDto, 'cedulaRuc'>, string][]) {
        if (values[key] === undefined) continue;
        params.push(values[key]);
        sets.push(`${col} = $${params.length}`);
      }
      if (dto.puestos !== undefined) sets.push('puestos_definidos = true');
      if (sets.length === 0 && dto.cedulaRuc === undefined) throw new BadRequestException('No hay nada que actualizar.');

      if (dto.zonaId) {
        const z = await q.query(
          `SELECT 1 FROM zona z WHERE z.zona_id = $1 AND z.activa AND z.ciudad_id = (SELECT ciudad_id FROM restaurante WHERE restaurante_id = app_tenant_id())`,
          [dto.zonaId],
        );
        if (!z.rowCount) throw new BadRequestException('zonaId no existe o no es de la ciudad del local.');
      }
      if (sets.length) {
        await q.query(
          `UPDATE restaurante SET ${sets.join(', ')}, actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id()`,
          params,
        );
      }
      if (dto.cedulaRuc !== undefined) {
        // `null` borra el dato (la app no tiene DELETE). Nunca se registra en el log de auditoría: esa tabla no tiene trigger.
        await q.query(
          `INSERT INTO restaurante_fiscal (restaurante_id, cedula_ruc) VALUES (app_tenant_id(), $1)
           ON CONFLICT (restaurante_id) DO UPDATE SET cedula_ruc = EXCLUDED.cedula_ruc`,
          [dto.cedulaRuc],
        );
      }
      return toRestauranteDto(await this.load(q));
    });
  }

  /** BORRADOR/PAUSADO → ACTIVO, solo si el local ya se puede mostrar. */
  async activate() {
    return this.db.forRequest(async (q) => {
      // Con la fila bloqueada: un PATCH simultáneo que deja el precio en 0 no se cuela entre la comprobación y el UPDATE.
      const r = await this.load(q, true);
      if (r.estado === 'ACTIVO') return toRestauranteDto(r);
      if (r.estado === 'BAJA') throw new ConflictException('Un restaurante dado de baja no se puede activar.');
      const h = await q.query('SELECT 1 FROM restaurante_horario WHERE restaurante_id = app_tenant_id() LIMIT 1');
      const faltan: string[] = [];
      if (Number(r.precio_suelto_centavos) <= 0) faltan.push('precio del almuerzo suelto');
      if (!h.rowCount) faltan.push('al menos un horario');
      if (faltan.length) throw new ConflictException(`Para activar el local falta: ${faltan.join(' y ')}.`);
      await q.query(`UPDATE restaurante SET estado = 'ACTIVO', actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id()`);
      return toRestauranteDto(await this.load(q));
    });
  }

  async pause() {
    return this.db.forRequest(async (q) => {
      const r = await this.load(q);
      if (r.estado === 'PAUSADO') return toRestauranteDto(r);
      if (r.estado !== 'ACTIVO') throw new ConflictException('Solo un restaurante activo se puede pausar.');
      await q.query(`UPDATE restaurante SET estado = 'PAUSADO', actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id()`);
      return toRestauranteDto(await this.load(q));
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

  /**
   * Estado manual del local. `nivel` manda sobre `lleno` si llegan los dos. LLENO/CONCURRIDO duran 20 minutos (reloj de
   * la base) y son excluyentes; LIBRE limpia ambos.
   */
  async setFull(dto: LlenoDto) {
    const nivel: NivelManual | undefined = dto.nivel ?? (dto.lleno === undefined ? undefined : dto.lleno ? 'LLENO' : 'LIBRE');
    if (!nivel) throw new BadRequestException('Envía `nivel` (LIBRE, CONCURRIDO o LLENO) o `lleno` (booleano).');
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ lleno_manual_hasta: Date | null; concurrido_manual_hasta: Date | null }>(
        `UPDATE restaurante
            SET lleno_manual_hasta = CASE WHEN $1::text = 'LLENO' THEN CURRENT_TIMESTAMP + interval '20 minutes' END,
                concurrido_manual_hasta = CASE WHEN $1::text = 'CONCURRIDO' THEN CURRENT_TIMESTAMP + interval '20 minutes' END
          WHERE restaurante_id = app_tenant_id() RETURNING lleno_manual_hasta, concurrido_manual_hasta`,
        [nivel],
      );
      const row = r.rows[0]!;
      return {
        lleno: nivel === 'LLENO',
        nivel,
        llenoManualHasta: row.lleno_manual_hasta,
        concurridoManualHasta: row.concurrido_manual_hasta,
      };
    });
  }

  private async load(q: Queryable, lock = false): Promise<Row> {
    const r = await q.query<Row>(`SELECT ${COLS} ${FROM} WHERE r.restaurante_id = app_tenant_id()${lock ? ' FOR UPDATE OF r' : ''}`);
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
