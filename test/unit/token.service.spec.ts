import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { TokenService } from '../../src/auth/token.service';
import { loadEnv } from '../../src/config/env';

const base = { DATABASE_URL: 'postgresql://a:b@h/db', DATABASE_SERVICE_URL: 'postgresql://c:d@h/db' };
const pem = (kp = generateKeyPairSync('ec', { namedCurve: 'P-256' })) => kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const make = (extra: Record<string, string> = {}) => new TokenService(loadEnv({ ...base, ...extra } as NodeJS.ProcessEnv));
const claims = { sub: '3f2b8c1e-5d4a-4b6f-9a1e-0c2d3e4f5a6b', uid: '42' };

describe('TokenService', () => {
  it('firma y verifica un access token ES256', async () => {
    const t = make({ JWT_PRIVATE_KEY: pem(), JWT_KEY_ID: 'k1' });
    const token = await t.signAccess(claims);
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' });
    expect(await t.verifyAccess(token)).toEqual(claims);
  });

  it('acepta la llave con \n literales (como en variables de entorno)', async () => {
    const t = make({ JWT_PRIVATE_KEY: pem().trim().replaceAll('\n', '\n') });
    expect(await t.verifyAccess(await t.signAccess(claims))).toEqual(claims);
  });

  it('rotación: un token firmado con la llave anterior sigue valiendo si su pública está en JWT_PREVIOUS_PUBLIC_KEYS', async () => {
    const oldKp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const oldSigner = make({ JWT_PRIVATE_KEY: pem(oldKp), JWT_KEY_ID: 'k-viejo' });
    const oldToken = await oldSigner.signAccess(claims);
    const oldPublic = oldKp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const rotated = make({ JWT_PRIVATE_KEY: pem(), JWT_KEY_ID: 'k-nuevo', JWT_PREVIOUS_PUBLIC_KEYS: JSON.stringify({ 'k-viejo': oldPublic }) });
    expect(await rotated.verifyAccess(oldToken)).toEqual(claims);
    // Al retirar la llave anterior, sus tokens dejan de valer.
    const retired = make({ JWT_PRIVATE_KEY: pem(), JWT_KEY_ID: 'k-nuevo' });
    expect(await retired.verifyAccess(oldToken)).toBeNull();
  });

  it('rechaza llaves que no son EC P-256', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => make({ JWT_PRIVATE_KEY: rsa })).toThrow(/P-256/);
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => make({ JWT_PRIVATE_KEY: p384 })).toThrow(/P-256/);
  });

  it('JWT_PREVIOUS_PUBLIC_KEYS mal formado impide arrancar', () => {
    expect(() => make({ JWT_PREVIOUS_PUBLIC_KEYS: '["no"]' })).toThrow();
    expect(() => make({ JWT_PREVIOUS_PUBLIC_KEYS: '{"k":1}' })).toThrow(/JWT_PREVIOUS_PUBLIC_KEYS/);
  });

  it('verifyAccess nunca lanza: basura → null', async () => {
    const t = make();
    for (const junk of ['', 'a.b.c', 'x', '....', 'eyJhbGciOiJub25lIn0.e30.']) expect(await t.verifyAccess(junk)).toBeNull();
  });

  it('un token con sub o uid mal formados se rechaza', async () => {
    const t = make();
    expect(await t.verifyAccess(await t.signAccess({ sub: 'no-uuid', uid: '42' }))).toBeNull();
    expect(await t.verifyAccess(await t.signAccess({ sub: claims.sub, uid: '0; DROP' }))).toBeNull();
  });

  it('en producción la llave es obligatoria', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/JWT_PRIVATE_KEY/);
    expect(loadEnv({ ...base, NODE_ENV: 'production', JWT_PRIVATE_KEY: 'x' } as NodeJS.ProcessEnv).NODE_ENV).toBe('production');
  });
});
