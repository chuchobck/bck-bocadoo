import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cada código vale un paso de 30 s; al verificar se acepta el paso anterior y el siguiente (relojes desfasados). */
export const STEP_SECONDS = 30;
const TOLERANCE_STEPS = 1;
/** Hasta cuánto atrás se reconoce un código auténtico pero viejo (para decir QR_EXPIRADO y no QR_INVALIDO). */
const EXPIRED_LOOKBACK_STEPS = 40;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FORMAT = new RegExp(`^BCD1\\.(${UUID})\\.(${UUID}|0)\\.([A-Za-z0-9_-]{22})$`);

export interface ParsedPass {
  userPublicId: string;
  /** public_id del restaurante para el que se emitió, o null si es un pase general. */
  restaurantPublicId: string | null;
  mac: string;
}

export const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);

function mac(secret: Buffer, user: string, restaurant: string, step: number): string {
  // 22 caracteres base64url = 132 bits del HMAC-SHA256: imposible de adivinar en la ventana de validez.
  return createHmac('sha256', secret).update(`v1|${user}|${restaurant}|${step}`).digest('base64url').slice(0, 22);
}

/** Código que muestra el comensal en su QR. */
export function issuePassCode(secret: Buffer, userPublicId: string, restaurantPublicId: string | null, nowMs: number): string {
  const rest = restaurantPublicId ?? '0';
  return `BCD1.${userPublicId}.${rest}.${mac(secret, userPublicId, rest, stepOf(nowMs))}`;
}

/** Solo comprueba la forma; no dice nada sobre la autenticidad. */
export function parsePassCode(code: string): ParsedPass | null {
  const m = FORMAT.exec(code);
  if (!m) return null;
  return { userPublicId: m[1]!, restaurantPublicId: m[2] === '0' ? null : m[2]!, mac: m[3]! };
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** VALIDO: firmado para el paso actual ±1. EXPIRADO: auténtico pero viejo. INVALIDO: no lo firmó este secreto. */
export function verifyPassCode(secret: Buffer, pass: ParsedPass, nowMs: number): 'VALIDO' | 'EXPIRADO' | 'INVALIDO' {
  const now = stepOf(nowMs);
  const rest = pass.restaurantPublicId ?? '0';
  let result: 'VALIDO' | 'EXPIRADO' | 'INVALIDO' = 'INVALIDO';
  // Se recorren siempre todos los pasos (sin salir antes) para no filtrar por tiempo cuál coincidió.
  for (let d = -EXPIRED_LOOKBACK_STEPS; d <= TOLERANCE_STEPS; d++) {
    if (same(mac(secret, pass.userPublicId, rest, now + d), pass.mac)) {
      result = Math.abs(d) <= TOLERANCE_STEPS ? 'VALIDO' : 'EXPIRADO';
    }
  }
  return result;
}
