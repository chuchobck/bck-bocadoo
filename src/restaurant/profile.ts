import { BadRequestException } from '@nestjs/common';
import { reglasDePais } from './country';
import type { PerfilNegocioDto } from './profile.dto';

/** Lo ya guardado del local (o los valores por defecto, en el registro) contra lo que se compara. */
export interface PerfilGuardado {
  puestos: number;
  /** false = `puestos` es el 20 por defecto y nunca lo indicó el dueño: no sirve de referencia. */
  puestosDefinidos: boolean;
  mesas: number | null;
}

export interface PerfilValidado {
  /** Teléfono en E.164 si vino (null = borrar). `undefined` = no vino. */
  telefono?: string | null;
}

/**
 * Reglas que dependen del país y de lo guardado. Lanza 400 con un mensaje por campo. `precioSuelto` es el alias
 * histórico (`precioSueltoCentavos`) de `precioAlmuerzoCentavos`: la misma columna; si llegan los dos deben coincidir.
 */
export function validarPerfil(
  pais: string,
  dto: PerfilNegocioDto & { precioSueltoCentavos?: number },
  guardado: PerfilGuardado,
): PerfilValidado {
  const reglas = reglasDePais(pais);
  const out: PerfilValidado = {};

  if (dto.telefono !== undefined) {
    if (dto.telefono === null) out.telefono = null;
    else {
      const t = reglas.telefono(dto.telefono);
      if (!t) throw new BadRequestException(reglas.telefonoAyuda);
      out.telefono = t;
    }
  }

  if (typeof dto.cedulaRuc === 'string' && !reglas.cedulaRuc(dto.cedulaRuc)) throw new BadRequestException(reglas.cedulaRucAyuda);

  const { latitud: lat, longitud: lng } = dto;
  if (typeof lat === 'number' && typeof lng === 'number') {
    if (!reglas.enPais(lat, lng)) throw new BadRequestException('Las coordenadas (latitud, longitud) quedan fuera del país del local.');
  } else {
    if (typeof lat === 'number' && !reglas.enPaisEje('lat', lat)) throw new BadRequestException('latitud queda fuera del país del local.');
    if (typeof lng === 'number' && !reglas.enPaisEje('lng', lng)) throw new BadRequestException('longitud queda fuera del país del local.');
  }

  if (dto.mesas !== undefined || dto.puestos !== undefined) {
    // Sin puestos en la petición y sin puestos definidos en la base no hay con qué comparar (el 20 es solo un default).
    const puestos = dto.puestos ?? (guardado.puestosDefinidos ? guardado.puestos : undefined);
    const mesas = dto.mesas !== undefined ? dto.mesas : guardado.mesas;
    if (puestos !== undefined && mesas !== null && puestos < mesas) {
      throw new BadRequestException(`puestos (${puestos}) no puede ser menor que mesas (${mesas}).`);
    }
  }

  if (
    dto.precioAlmuerzoCentavos !== undefined &&
    dto.precioSueltoCentavos !== undefined &&
    dto.precioAlmuerzoCentavos !== dto.precioSueltoCentavos
  ) {
    throw new BadRequestException('precioAlmuerzoCentavos y precioSueltoCentavos son el mismo precio: envía solo uno o el mismo valor.');
  }
  return out;
}

/** Máscara de la cédula/RUC para el personal: solo los últimos 4 dígitos. */
export const enmascararCedulaRuc = (v: string | null): string | null =>
  v === null ? null : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;

export const PERFIL_CAMPOS = ['cedulaRuc', 'telefono', 'direccion', 'coordenadas', 'mesas', 'puestos', 'precioAlmuerzo'] as const;
export type PerfilCampo = (typeof PERFIL_CAMPOS)[number];

export interface PerfilEstado {
  cedula_ruc: string | null;
  telefono_e164: string | null;
  direccion: string | null;
  latitud: string | null;
  longitud: string | null;
  mesas_total: number | null;
  puestos_definidos: boolean;
  precio_suelto_centavos: string;
}

/** Campos del perfil que todavía faltan (no bloquea ninguna operación; la obligatoriedad la impone la app). */
export function datosPendientes(r: PerfilEstado): PerfilCampo[] {
  const falta: Record<PerfilCampo, boolean> = {
    cedulaRuc: r.cedula_ruc === null,
    telefono: r.telefono_e164 === null,
    direccion: r.direccion === null || r.direccion.trim() === '',
    coordenadas: r.latitud === null || r.longitud === null,
    mesas: r.mesas_total === null,
    puestos: !r.puestos_definidos,
    precioAlmuerzo: Number(r.precio_suelto_centavos) <= 0,
  };
  return PERFIL_CAMPOS.filter((c) => falta[c]);
}
