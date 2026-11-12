import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { DbService } from '../../src/db/db.service';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe('Registro', () => {
  let app: NestFastifyApplication;
  let db: DbService;
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DbService);
  });
  afterAll(() => app.close());

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
  const body = (over: Record<string, unknown> = {}) => ({
    nombre: '  María  Guamán ', correo: `Reg_${unique()}@Correo.com`, password: 'una-clave-larga-123', aceptaTerminos: true, ...over,
  });

  it('registra un comensal: normaliza el correo, no devuelve hashes ni ids internos', async () => {
    const b = body();
    const res = await post('/v1/auth/register', b);
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.usuario).toMatchObject({ nombre: 'María  Guamán', correo: b.correo.toLowerCase() });
    expect(json.usuario.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(json)).not.toMatch(/password|hash|\$argon2/i);
    const stored = await db.service((q) => q.query<{ password_hash: string }>(
      `SELECT ui.password_hash FROM usuario_identidad ui JOIN usuario u USING (usuario_id) WHERE u.correo = $1`, [b.correo.toLowerCase()]));
    expect(stored.rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
    const ev = await db.service((q) => q.query(`SELECT 1 FROM evento_seguridad WHERE tipo = 'REGISTRO' AND detalle->>'dueno' = 'false' AND ocurrido_en > now() - interval '1 minute'`));
    expect(ev.rowCount).toBeGreaterThan(0);
  });

  it('registra un dueño con su restaurante en borrador y su fila DUENO', async () => {
    const b = body({ restaurante: { nombre: 'Café Ñandú', ciudadId: 1 } });
    const res = await post('/v1/auth/register-owner', b);
    expect(res.statusCode).toBe(201);
    expect(res.json().restaurante).toMatchObject({ nombre: 'Café Ñandú', estado: 'BORRADOR' });
    expect(res.json().restaurante.slug).toMatch(/^cafe-nandu-[0-9a-f]{6}$/);
    const r = await db.service((q) => q.query(
      `SELECT p.rol FROM personal_restaurante p JOIN usuario u USING (usuario_id) WHERE u.correo = $1`, [b.correo.toLowerCase()]));
    expect(r.rows[0]).toMatchObject({ rol: 'DUENO' });
  });

  it('correo repetido → 409 genérico', async () => {
    const b = body();
    expect((await post('/v1/auth/register', b)).statusCode).toBe(201);
    const dup = await post('/v1/auth/register', b);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().detail).toBe('No se pudo completar el registro con esos datos.');
  });

  it('ciudad inexistente → 400 y no queda el usuario a medias', async () => {
    const b = body({ restaurante: { nombre: 'Local', ciudadId: 999999 } });
    expect((await post('/v1/auth/register-owner', b)).statusCode).toBe(400);
    const left = await db.service((q) => q.query('SELECT 1 FROM usuario WHERE correo = $1', [b.correo.toLowerCase()]));
    expect(left.rowCount).toBe(0);
  });

  it('campos extra, contraseña corta o sin aceptar términos → 400', async () => {
    expect((await post('/v1/auth/register', body({ rol: 'DUENO' }))).statusCode).toBe(400);
    expect((await post('/v1/auth/register', body({ password: 'corta' }))).statusCode).toBe(400);
    expect((await post('/v1/auth/register', body({ aceptaTerminos: false }))).statusCode).toBe(400);
  });
});
