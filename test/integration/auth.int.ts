import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, generateKeyPair } from 'jose';
import { createApp } from '../../src/app.factory';
import { TokenService } from '../../src/auth/token.service';
import { DbService } from '../../src/db/db.service';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = 'una-clave-larga-123';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Autenticación', () => {
  let app: NestFastifyApplication;
  let db: DbService;
  let tokens: TokenService;
  let n = 0;
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DbService);
    tokens = app.get(TokenService);
  });
  afterAll(() => app.close());

  // Cada prueba usa su propia IP para no compartir contadores de rate limit.
  const ip = () => `10.40.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
  const call = (method: 'GET' | 'POST', url: string, opts: { payload?: object; token?: string; ip?: string } = {}) =>
    app.inject({
      method,
      url,
      payload: opts.payload,
      remoteAddress: opts.ip ?? ip(),
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    });

  async function newUser() {
    const correo = `auth_${unique()}@correo.com`;
    const res = await call('POST', '/v1/auth/register', {
      payload: { nombre: 'Usuaria Prueba', correo, password: PASSWORD, aceptaTerminos: true },
    });
    expect(res.statusCode).toBe(201);
    return { correo, publicId: res.json().usuario.id as string };
  }
  async function login(correo: string, password = PASSWORD, ipAddr?: string) {
    return call('POST', '/v1/auth/login', { payload: { identificador: correo, password }, ip: ipAddr });
  }
  const events = (tipo: string, usuarioPublicId: string) =>
    db.service((q) =>
      q.query(`SELECT 1 FROM evento_seguridad e JOIN usuario u USING (usuario_id) WHERE e.tipo = $1 AND u.public_id = $2`, [
        tipo,
        usuarioPublicId,
      ]),
    );

  describe('login y /me', () => {
    it('login correcto devuelve access y refresh; /me responde con el usuario del token', async () => {
      const u = await newUser();
      const res = await login(u.correo);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, usuario: { id: u.publicId } });
      expect(body.refreshToken).toHaveLength(43);
      const me = await call('GET', '/v1/auth/me', { token: body.accessToken });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ usuario: { id: u.publicId, nombre: 'Usuaria Prueba' }, restaurantes: [] });
      expect((await events('LOGIN_OK', u.publicId)).rowCount).toBe(1);
    });

    it('el refresh token se guarda solo como hash', async () => {
      const u = await newUser();
      const { refreshToken } = (await login(u.correo)).json();
      const r = await db.service((q) =>
        q.query(`SELECT 1 FROM sesion_refresh WHERE token_hash = $1 OR token_hash = encode(sha256($2::bytea), 'hex')`, [
          refreshToken,
          refreshToken,
        ]),
      );
      expect(r.rowCount).toBe(1); // solo coincide el SHA-256, nunca el token en claro
      const plain = await db.service((q) =>
        q.query('SELECT 1 FROM sesion_refresh WHERE token_hash = $1', [refreshToken.padEnd(64, '0').slice(0, 64)]),
      );
      expect(plain.rowCount).toBe(0);
    });

    it('contraseña incorrecta y usuario inexistente responden exactamente igual', async () => {
      const u = await newUser();
      const wrong = await login(u.correo, 'otra-clave-larga-999');
      const ghost = await login(`no_existe_${unique()}@correo.com`);
      expect(wrong.statusCode).toBe(401);
      expect(ghost.statusCode).toBe(401);
      const strip = (r: { json: () => Record<string, unknown> }) => {
        const j = r.json();
        delete j.requestId;
        delete j.instance;
        return j;
      };
      expect(strip(wrong)).toEqual(strip(ghost));
      expect(strip(wrong).detail).toBe('Credenciales inválidas.');
      expect((await events('LOGIN_FALLIDO', u.publicId)).rowCount).toBe(1);
    });

    it('el tiempo de respuesta de un usuario inexistente es comparable al de uno real', async () => {
      const u = await newUser();
      const time = async (f: () => Promise<unknown>) => {
        const t = performance.now();
        await f();
        return performance.now() - t;
      };
      await login(u.correo, 'x'); // calienta argon2
      const real = Math.min(...(await Promise.all([1, 2, 3].map(() => time(() => login(u.correo, 'mala-clave-larga-1'))))));
      const ghost = Math.min(
        ...(await Promise.all([1, 2, 3].map(() => time(() => login(`fantasma_${unique()}@correo.com`, 'mala-clave-larga-1'))))),
      );
      expect(ghost).toBeGreaterThan(real * 0.5);
    });
  });

  describe('refresh con rotación', () => {
    it('cada uso rota el token; reutilizar uno viejo revoca toda la familia y queda registrado', async () => {
      const u = await newUser();
      const first = (await login(u.correo)).json();
      const second = await call('POST', '/v1/auth/refresh', { payload: { refreshToken: first.refreshToken } });
      expect(second.statusCode).toBe(200);
      const next = second.json();
      expect(next.refreshToken).not.toBe(first.refreshToken);
      expect((await call('GET', '/v1/auth/me', { token: next.accessToken })).statusCode).toBe(200);

      const replay = await call('POST', '/v1/auth/refresh', { payload: { refreshToken: first.refreshToken } });
      expect(replay.statusCode).toBe(401);
      // El token legítimo más reciente también quedó revocado.
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken: next.refreshToken } })).statusCode).toBe(401);
      expect((await events('REFRESH_REUSO', u.publicId)).rowCount).toBeGreaterThan(0);
    });

    it('dos rotaciones simultáneas del mismo token: solo una gana', async () => {
      const u = await newUser();
      const { refreshToken } = (await login(u.correo)).json();
      const [a, b] = await Promise.all([
        call('POST', '/v1/auth/refresh', { payload: { refreshToken } }),
        call('POST', '/v1/auth/refresh', { payload: { refreshToken } }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
    });

    it('token inventado, mal formado o vencido → 401', async () => {
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken: 'A'.repeat(43) } })).statusCode).toBe(401);
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken: 'corto' } })).statusCode).toBe(400);
      const u = await newUser();
      const { refreshToken } = (await login(u.correo)).json();
      await db.service((q) =>
        q.query(
          `UPDATE sesion_refresh SET expira_en = now() - interval '1 second', creado_en = now() - interval '1 day' WHERE usuario_id = (SELECT usuario_id FROM usuario WHERE public_id = $1)`,
          [u.publicId],
        ),
      );
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken } })).statusCode).toBe(401);
    });
  });

  describe('logout', () => {
    it('logout cierra la sesión del dispositivo y es idempotente', async () => {
      const u = await newUser();
      const { refreshToken } = (await login(u.correo)).json();
      expect((await call('POST', '/v1/auth/logout', { payload: { refreshToken } })).statusCode).toBe(204);
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken } })).statusCode).toBe(401);
      expect((await call('POST', '/v1/auth/logout', { payload: { refreshToken } })).statusCode).toBe(204);
      expect((await call('POST', '/v1/auth/logout', { payload: { refreshToken: 'B'.repeat(43) } })).statusCode).toBe(204);
    });

    it('logout-all revoca las sesiones de todos los dispositivos', async () => {
      const u = await newUser();
      const phone = (await login(u.correo)).json();
      const laptop = (await login(u.correo)).json();
      expect((await call('POST', '/v1/auth/logout-all', { token: phone.accessToken })).statusCode).toBe(204);
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken: phone.refreshToken } })).statusCode).toBe(401);
      expect((await call('POST', '/v1/auth/refresh', { payload: { refreshToken: laptop.refreshToken } })).statusCode).toBe(401);
      expect((await events('LOGOUT_TODOS', u.publicId)).rowCount).toBe(1);
    });

    it('logout-all sin token → 401', async () => {
      expect((await call('POST', '/v1/auth/logout-all')).statusCode).toBe(401);
    });
  });

  describe('abuso de JWT', () => {
    const claims = async () => {
      const u = await newUser();
      const id = (
        await db.service((q) => q.query<{ usuario_id: string }>('SELECT usuario_id FROM usuario WHERE public_id = $1', [u.publicId]))
      ).rows[0]!.usuario_id;
      return { sub: u.publicId, uid: String(id) };
    };

    it('sin cabecera, con esquema raro o con basura → 401 problem+json', async () => {
      for (const authorization of [undefined, 'Basic abc', 'Bearer', 'Bearer a b', 'Bearer ñ']) {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/auth/me',
          remoteAddress: ip(),
          headers: authorization ? { authorization } : {},
        });
        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).toContain('application/problem+json');
      }
    });

    it('alg: none → 401', async () => {
      const c = await claims();
      const now = Math.floor(Date.now() / 1000);
      const token = `${b64({ alg: 'none', typ: 'at+jwt', kid: 'k1' })}.${b64({ ...c, iss: 'bocadoo', aud: 'bocadoo-api', iat: now, exp: now + 900 })}.`;
      expect((await call('GET', '/v1/auth/me', { token })).statusCode).toBe(401);
    });

    it('firma alterada → 401', async () => {
      const c = await claims();
      const good = await tokens.signAccess(c);
      const [h, p, s] = good.split('.');
      const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), uid: '1' })).toString('base64url');
      expect((await call('GET', '/v1/auth/me', { token: good })).statusCode).toBe(200);
      expect((await call('GET', '/v1/auth/me', { token: `${h}.${evil}.${s}` })).statusCode).toBe(401);
    });

    it('kid desconocido y firmado con otra llave → 401', async () => {
      const c = await claims();
      const { privateKey } = await generateKeyPair('ES256');
      const now = Math.floor(Date.now() / 1000);
      const sign = (kid: string) =>
        new SignJWT({ uid: c.uid })
          .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
          .setSubject(c.sub)
          .setIssuer('bocadoo')
          .setAudience('bocadoo-api')
          .setIssuedAt(now)
          .setExpirationTime(now + 900)
          .sign(privateKey);
      expect((await call('GET', '/v1/auth/me', { token: await sign('otro-kid') })).statusCode).toBe(401);
      expect((await call('GET', '/v1/auth/me', { token: await sign('k1') })).statusCode).toBe(401); // kid conocido, llave ajena
    });

    it('token vencido y audiencia equivocada → 401', async () => {
      const c = await claims();
      expect((await call('GET', '/v1/auth/me', { token: await tokens.signAccess(c, -10) })).statusCode).toBe(401);
      const { privateKey } = await generateKeyPair('ES256');
      const now = Math.floor(Date.now() / 1000);
      const wrongAud = await new SignJWT({ uid: c.uid })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' })
        .setSubject(c.sub)
        .setIssuer('bocadoo')
        .setAudience('otra-api')
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(privateKey);
      expect((await call('GET', '/v1/auth/me', { token: wrongAud })).statusCode).toBe(401);
    });

    it('HS256 firmado con la llave pública como secreto (confusión de algoritmo) → 401', async () => {
      const c = await claims();
      const now = Math.floor(Date.now() / 1000);
      const hs = await new SignJWT({ uid: c.uid })
        .setProtectedHeader({ alg: 'HS256', kid: 'k1', typ: 'at+jwt' })
        .setSubject(c.sub)
        .setIssuer('bocadoo')
        .setAudience('bocadoo-api')
        .setIssuedAt(now)
        .setExpirationTime(now + 900)
        .sign(new TextEncoder().encode('cualquier-secreto'));
      expect((await call('GET', '/v1/auth/me', { token: hs })).statusCode).toBe(401);
    });
  });

  describe('contexto y aislamiento del usuario', () => {
    it('/me solo muestra los restaurantes del usuario del token (el contexto del request no se cruza)', async () => {
      const mk = async (nombre: string) => {
        const correo = `own_${unique()}@correo.com`;
        const r = await call('POST', '/v1/auth/register-owner', {
          payload: { nombre: 'Dueña', correo, password: PASSWORD, aceptaTerminos: true, restaurante: { nombre, ciudadId: 1 } },
        });
        expect(r.statusCode).toBe(201);
        return { correo, rid: r.json().restaurante.id as string };
      };
      const [a, b] = await Promise.all([mk('Local A'), mk('Local B')]);
      const [ta, tb] = await Promise.all([login(a.correo), login(b.correo)]);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => call('GET', '/v1/auth/me', { token: (i % 2 ? ta : tb).json().accessToken })),
      );
      results.forEach((r, i) => expect(r.json().restaurantes.map((x: { id: string }) => x.id)).toEqual([(i % 2 ? a : b).rid]));
    });
  });

  it('ninguna respuesta de auth contiene hashes ni secretos', async () => {
    const u = await newUser();
    const res = await login(u.correo);
    expect(res.body).not.toMatch(/argon2|password_hash|token_hash/i);
  });
});
