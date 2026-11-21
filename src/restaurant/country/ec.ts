import type { CountryRules } from './index';

const digits = (s: string) => /^\d+$/.test(s);
const d = (s: string, i: number) => s.charCodeAt(i) - 48;

/** Provincia del documento: 01..24 (provincias) o 30 (ecuatorianos en el exterior). */
const provinciaValida = (s: string) => {
  const p = Number(s.slice(0, 2));
  return (p >= 1 && p <= 24) || p === 30;
};

/** Módulo 10 (cédula y RUC de persona natural): coeficientes 2,1,2,1,… sobre los 9 primeros; verificador = dígito 10. */
function modulo10(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const p = d(s, i) * (i % 2 === 0 ? 2 : 1);
    sum += p > 9 ? p - 9 : p;
  }
  return (10 - (sum % 10)) % 10 === d(s, 9);
}

/** Módulo 11: verificador en `pos` (0-based) calculado con `coef` sobre los dígitos anteriores. 11 → 0; 10 no es válido. */
function modulo11(s: string, coef: number[], pos: number): boolean {
  let sum = 0;
  coef.forEach((c, i) => (sum += d(s, i) * c));
  const r = 11 - (sum % 11);
  const check = r === 11 ? 0 : r;
  return check !== 10 && check === d(s, pos);
}

/** Cédula: 10 dígitos, provincia válida, tercer dígito < 6 y verificador módulo 10. */
export function cedulaValida(s: string): boolean {
  return s.length === 10 && digits(s) && provinciaValida(s) && d(s, 2) < 6 && modulo10(s);
}

/**
 * RUC: 13 dígitos, provincia válida y los 3 últimos distintos de 000.
 * - Persona natural: tercer dígito < 6 y módulo 10 sobre los 10 primeros.
 * - Sociedad privada: tercer dígito 9, módulo 11 (coef. 4,3,2,7,6,5,4,3,2; verificador = dígito 10).
 * - Sociedad pública: tercer dígito 6, módulo 11 (coef. 3,2,7,6,5,4,3,2; verificador = dígito 9).
 */
export function rucValido(s: string): boolean {
  if (s.length !== 13 || !digits(s) || !provinciaValida(s) || s.slice(10) === '000') return false;
  const t = d(s, 2);
  if (t < 6) return modulo10(s);
  if (t === 9) return modulo11(s, [4, 3, 2, 7, 6, 5, 4, 3, 2], 9);
  if (t === 6) return modulo11(s, [3, 2, 7, 6, 5, 4, 3, 2], 8);
  return false;
}

// Cajas aproximadas (no polígonos): continente y Galápagos. Dejan pasar franjas de países vecinos pegadas a la frontera.
const CAJAS = [
  { lat: [-5.1, 1.5], lng: [-81.2, -75.1] }, // continente
  { lat: [-1.6, 0.8], lng: [-92.2, -89.1] }, // Galápagos
] as const;

export const ecuador: CountryRules = {
  /** 09XXXXXXXX (móvil, 10 dígitos) o el mismo número ya en E.164 (+5939XXXXXXXX). Guarda E.164. */
  telefono(raw) {
    if (/^09\d{8}$/.test(raw)) return `+593${raw.slice(1)}`;
    if (/^\+5939\d{8}$/.test(raw)) return raw;
    return null;
  },
  telefonoAyuda: 'telefono debe ser un móvil de Ecuador: 09XXXXXXXX (10 dígitos).',
  cedulaRuc: (raw) => cedulaValida(raw) || rucValido(raw),
  cedulaRucAyuda: 'cedulaRuc no es una cédula (10 dígitos) ni un RUC (13 dígitos) válido de Ecuador.',
  enPais: (lat, lng) => CAJAS.some((c) => lat >= c.lat[0] && lat <= c.lat[1] && lng >= c.lng[0] && lng <= c.lng[1]),
  enPaisEje: (eje, v) => (eje === 'lat' ? v >= -5.1 && v <= 1.5 : v >= -92.2 && v <= -75.1),
};
