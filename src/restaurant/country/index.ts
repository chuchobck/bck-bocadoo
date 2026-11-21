import { ecuador } from './ec';

/** Reglas de datos del negocio por país. Para sumar un país: crear su archivo y registrarlo en REGLAS. */
export interface CountryRules {
  /** Devuelve el teléfono normalizado a E.164, o null si el formato no es válido. */
  telefono(raw: string): string | null;
  telefonoAyuda: string;
  /** Documento fiscal (cédula o RUC), ya reducido a dígitos. */
  cedulaRuc(raw: string): boolean;
  cedulaRucAyuda: string;
  /** El punto cae dentro del país. */
  enPais(lat: number, lng: number): boolean;
  /** Una sola coordenada cae dentro del rango del país (cuando la otra no está). */
  enPaisEje(eje: 'lat' | 'lng', valor: number): boolean;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** País sin reglas propias: teléfono E.164 genérico, rangos geográficos del planeta y sin documento fiscal. */
const generico: CountryRules = {
  telefono: (raw) => (E164.test(raw) ? raw : null),
  telefonoAyuda: 'telefono debe estar en formato E.164, p. ej. +593990000001.',
  cedulaRuc: () => false,
  cedulaRucAyuda: 'cedulaRuc todavía no se admite para el país de este local.',
  enPais: (lat, lng) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180,
  enPaisEje: (eje, v) => (eje === 'lat' ? v >= -90 && v <= 90 : v >= -180 && v <= 180),
};

const REGLAS: Record<string, CountryRules> = { EC: ecuador };

export const reglasDePais = (paisCodigo: string): CountryRules => REGLAS[paisCodigo.toUpperCase()] ?? generico;
