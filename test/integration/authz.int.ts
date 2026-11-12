import { Controller, Get } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { Public } from '../../src/authz/public.decorator';
import { Roles } from '../../src/authz/roles.decorator';
import { DbService } from '../../src/db/db.service';
import { RequestContextStore } from '../../src/tenancy/request-context';

// Endpoints de ensayo: solo existen en estas pruebas.
@Controller('test-authz')
class TestController {
  constructor(private readonly db: DbService) {}
  @Public() @Get('abierto') abierto() { return { ok: true }; }
  @Get('cualquiera-autenticado') cualquiera() { return { ok: true }; }
  @Roles('DUENO', 'CAJERO') @Get('personal') personal() { const c = RequestContextStore.get(); return { tenantId: c?.tenantId, role: c?.role }; }
  @Roles('DUENO') @Get('solo-dueno') soloDueno() { return { ok: true }; }
  @Roles('DUENO') @Get('clientes')
  async clientes() {
    return this.db.forRequest(async (q) => (await q.query<{ n: number }>('SELECT count(*)::int AS n FROM cliente_restaurante')).rows[0]);
  }
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = 'una-clave-larga-123';

describe('Autorización: guard JWT, roles y tenant', () => {
  let app: NestFastifyApplication;
  let db: DbService;
  let n = 0;
  beforeAll(async () => {
    app = await createApp({ controllers: [TestController] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DbService);
  });
  afterAll(() => app.close());

  const ip = () => `10.50.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
  const get = (url: string, token?: string, restaurante?: string) =>
    app.inject({ method: 'GET', url, remoteAddress: ip(), headers: { ...(token && { authorization: `Bearer ${token}` }), ...(restaurante && { 'x-restaurant-id': restaurante }) } });

  async function owner(nombreLocal: string) {
    const correo = `dueno_${unique()}@correo.com`;
    const r = await app.inject({ method: 'POST', url: '/v1/auth/register-owner', remoteAddress: ip(), payload: { nombre: 'Dueño Prueba', correo, password: PASSWORD, aceptaTerminos: true, restaurante: { nombre: nombreLocal, ciudadId: 1 } } });
    expect(r.statusCode).toBe(201);
    const l = await app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: ip(), payload: { identificador: correo, password: PASSWORD } });
    return { correo, token: l.json().accessToken as string, publicRestaurante: r.json().restaurante.id as string, usuarioPublicId: r.json().usuario.id as string };
  }
  /** Cajero del restaurante dado, creado directamente en base (la invitación de personal llega en la fase 5). */
  async function cashier(restaurantePublicId: string, activo = true) {
    const correo = `cajero_${unique()}@correo.com`;
    const r = await app.inject({ method: 'POST', url: '/v1/auth/register', remoteAddress: ip(), payload: { nombre: 'Cajero Prueba', correo, password: PASSWORD, aceptaTerminos: true } });
    await db.service((q) => q.query(
      `INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible, activo)
       SELECT r.restaurante_id, u.usuario_id, 'CAJERO', 'Cajero', $3 FROM restaurante r, usuario u WHERE r.public_id = $1 AND u.public_id = $2`,
      [restaurantePublicId, r.json().usuario.id, activo]));
    const l = await app.inject({ method: 'POST', url: '/v1/auth/login', remoteAddress: ip(), payload: { identificador: correo, password: PASSWORD } });
    return { token: l.json().accessToken as string, usuarioPublicId: r.json().usuario.id as string };
  }
  const denied = (usuarioPublicId: string, motivo: string) =>
    db.service((q) => q.query(`SELECT 1 FROM evento_seguridad e JOIN usuario u USING (usuario_id) WHERE e.tipo = 'ACCESO_DENEGADO' AND u.public_id = $1 AND e.detalle->>'motivo' = $2`, [usuarioPublicId, motivo]));

  it('guard global: sin token → 401; con @Public() entra; con token entra', async () => {
    const o = await owner('Local Guard');
    expect((await get('/test-authz/abierto')).statusCode).toBe(200);
    expect((await get('/test-authz/cualquiera-autenticado')).statusCode).toBe(401);
    expect((await get('/test-authz/cualquiera-autenticado', o.token)).statusCode).toBe(200);
    expect((await get('/health')).statusCode).toBe(200);
  });

  it('el dueño y el cajero pasan en su restaurante; el tenant sale de la pertenencia', async () => {
    const o = await owner('Local Uno');
    const c = await cashier(o.publicRestaurante);
    const mine = await get('/test-authz/personal', o.token, o.publicRestaurante);
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ role: 'DUENO', tenantId: expect.stringMatching(/^[1-9][0-9]*$/) });
    expect((await get('/test-authz/personal', c.token, o.publicRestaurante)).json().role).toBe('CAJERO');
  });

  it('el cajero no entra a rutas de dueño → 403 y queda en evento_seguridad', async () => {
    const o = await owner('Local Dos');
    const c = await cashier(o.publicRestaurante);
    const res = await get('/test-authz/solo-dueno', c.token, o.publicRestaurante);
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect((await denied(c.usuarioPublicId, 'ROL_INSUFICIENTE')).rowCount).toBe(1);
    expect((await get('/test-authz/solo-dueno', o.token, o.publicRestaurante)).statusCode).toBe(200);
  });

  it('el dueño de A no accede al restaurante B cambiando el encabezado → 403', async () => {
    const a = await owner('Local A');
    const b = await owner('Local B');
    const res = await get('/test-authz/solo-dueno', a.token, b.publicRestaurante);
    expect(res.statusCode).toBe(403);
    expect((await denied(a.usuarioPublicId, 'SIN_ACCESO_AL_RESTAURANTE')).rowCount).toBe(1);
  });

  it('personal desactivado pierde el acceso', async () => {
    const o = await owner('Local Tres');
    const c = await cashier(o.publicRestaurante, false);
    expect((await get('/test-authz/personal', c.token, o.publicRestaurante)).statusCode).toBe(403);
  });

  it('encabezado ausente, mal formado o sin token', async () => {
    const o = await owner('Local Cuatro');
    expect((await get('/test-authz/personal', o.token)).statusCode).toBe(400);
    expect((await get('/test-authz/personal', o.token, '1')).statusCode).toBe(400);
    expect((await get('/test-authz/personal', o.token, "1' OR '1'='1")).statusCode).toBe(400);
    expect((await get('/test-authz/personal', undefined, o.publicRestaurante)).statusCode).toBe(401);
  });

  it('cada restaurante ve solo sus clientes, también a través de la API', async () => {
    const a = await owner('Local Clientes A');
    const b = await owner('Local Clientes B');
    await db.service((q) => q.query(
      `INSERT INTO cliente_restaurante (restaurante_id, nombre) SELECT restaurante_id, 'Cliente de A' FROM restaurante WHERE public_id = $1`, [a.publicRestaurante]));
    expect((await get('/test-authz/clientes', a.token, a.publicRestaurante)).json()).toEqual({ n: 1 });
    expect((await get('/test-authz/clientes', b.token, b.publicRestaurante)).json()).toEqual({ n: 0 });
  });

  it('aunque el guard fallara, RLS bloquea por id: el tenant A no lee el cliente de B', async () => {
    const a = await owner('Local RLS A');
    const b = await owner('Local RLS B');
    const ids = await db.service((q) => q.query<{ cliente_id: string; restaurante_id: string }>(
      `WITH x AS (INSERT INTO cliente_restaurante (restaurante_id, nombre) SELECT restaurante_id, 'Cliente de B' FROM restaurante WHERE public_id = $1 RETURNING cliente_id)
       SELECT x.cliente_id, (SELECT restaurante_id FROM restaurante WHERE public_id = $2) AS restaurante_id FROM x`, [b.publicRestaurante, a.publicRestaurante]));
    const { cliente_id, restaurante_id } = ids.rows[0]!;
    const leak = await db.scope({ tenantId: String(restaurante_id) }, (q) => q.query('SELECT * FROM cliente_restaurante WHERE cliente_id = $1', [cliente_id]));
    expect(leak.rowCount).toBe(0);
    const edit = await db.scope({ tenantId: String(restaurante_id) }, (q) => q.query("UPDATE cliente_restaurante SET nombre = 'x' WHERE cliente_id = $1", [cliente_id]));
    expect(edit.rowCount).toBe(0);
  });
});
