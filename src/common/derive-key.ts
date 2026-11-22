import { createHash } from 'node:crypto';

/**
 * Clave de idempotencia derivada de la `Idempotency-Key` de la petición y una etiqueta (docs/spec-cobros.md, F.3).
 * Determinista: un reintento con la misma llave regenera exactamente las mismas claves (consumo por miembro de mesa,
 * cuenta, líneas, pago). El resultado tiene forma de UUID para caber en las columnas `clave_idempotencia`.
 */
export function deriveKey(key: string, etiqueta: string): string {
  const h = createHash('sha256').update(`${key}:${etiqueta}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** sha256 en hex (64 caracteres) de un valor serializado con claves ordenadas: la `huella` de una entrada (F.1). */
export function huella(valor: unknown): string {
  return createHash('sha256').update(estable(valor)).digest('hex');
}

function estable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(estable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${estable(o[k])}`)
    .join(',')}}`;
}
