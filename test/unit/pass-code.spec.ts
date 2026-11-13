import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STEP_SECONDS, issuePassCode, parsePassCode, verifyPassCode } from '../../src/checkout/pass-code';

const USER = '3f2b8c1e-5d4a-4b6f-9a1e-0c2d3e4f5a6b';
const REST = '05c11eab-1755-48ba-a8bc-1f153b4c8504';
const T0 = 1_800_000_000_000; // múltiplo exacto de 30 s
const secret = randomBytes(32);
const at = (code: string, ms: number, s = secret) => verifyPassCode(s, parsePassCode(code)!, ms);

describe('código del pase (HMAC rotativo cada 30 s)', () => {
  it('tiene el formato esperado y cambia en cada paso', () => {
    const a = issuePassCode(secret, USER, REST, T0);
    expect(a).toMatch(/^BCD1\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/);
    expect(issuePassCode(secret, USER, REST, T0 + 29_999)).toBe(a);
    expect(issuePassCode(secret, USER, REST, T0 + STEP_SECONDS * 1000)).not.toBe(a);
    expect(parsePassCode(a)).toMatchObject({ userPublicId: USER, restaurantPublicId: REST });
    expect(parsePassCode(issuePassCode(secret, USER, null, T0))!.restaurantPublicId).toBeNull();
  });

  it('vale en su paso y con un paso de tolerancia hacia cada lado; después está expirado', () => {
    const code = issuePassCode(secret, USER, REST, T0);
    expect(at(code, T0)).toBe('VALIDO');
    expect(at(code, T0 + 30_000)).toBe('VALIDO'); // el lector va un paso adelante
    expect(at(code, T0 + 59_999)).toBe('VALIDO');
    expect(at(code, T0 - 30_000)).toBe('VALIDO'); // el lector va un paso atrás
    expect(at(code, T0 + 60_000)).toBe('EXPIRADO');
    expect(at(code, T0 + 10 * 60_000)).toBe('EXPIRADO');
    expect(at(code, T0 + 60 * 60_000)).toBe('INVALIDO'); // demasiado viejo: ya ni se reconoce
    expect(at(code, T0 - 60_000)).toBe('INVALIDO'); // "del futuro"
  });

  it('no se puede falsificar: otro secreto, otro usuario, otro restaurante o un carácter cambiado', () => {
    const code = issuePassCode(secret, USER, REST, T0);
    expect(at(code, T0, randomBytes(32))).toBe('INVALIDO');
    const p = parsePassCode(code)!;
    expect(verifyPassCode(secret, { ...p, userPublicId: USER.replace('3f', '4f') }, T0)).toBe('INVALIDO');
    expect(verifyPassCode(secret, { ...p, restaurantPublicId: null }, T0)).toBe('INVALIDO'); // quitarle el restaurante no lo vuelve general
    expect(verifyPassCode(secret, { ...p, restaurantPublicId: USER }, T0)).toBe('INVALIDO');
    const flipped = p.mac.slice(0, -1) + (p.mac.endsWith('A') ? 'B' : 'A');
    expect(verifyPassCode(secret, { ...p, mac: flipped }, T0)).toBe('INVALIDO');
  });

  it('rechaza cualquier cosa que no tenga la forma exacta', () => {
    for (const bad of [
      '',
      'hola',
      'BCD1.x.y.z',
      `BCD2.${USER}.${REST}.${'a'.repeat(22)}`,
      `BCD1.${USER}.${REST}.${'a'.repeat(21)}`,
      `BCD1.${USER}.${REST}.${'a'.repeat(22)} `,
      `BCD1.${USER}.1.${'a'.repeat(22)}`,
    ]) {
      expect(parsePassCode(bad)).toBeNull();
    }
  });
});
