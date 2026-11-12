import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { loadEnv } from '../../src/config/env';
import { DbService } from '../../src/db/db.service';

// Datos de la demo: restaurante 1 (La Cuchara de San Blas) tiene 16 clientes; el 2 (Verde Limón), 1.
const COUNT = 'SELECT count(*)::int AS n FROM cliente_restaurante';
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RLS y multi-tenant contra base real', () => {
  const env = loadEnv();
  let db: DbService;
  beforeAll(() => { db = new DbService(env); });
  afterAll(() => db.onModuleDestroy());

  it('la API conecta como un rol sin superusuario ni BYPASSRLS; el servicio sí tiene BYPASSRLS', async () => {
    const q = 'SELECT current_user AS u, r.rolbypassrls AS bypass, r.rolsuper AS su FROM pg_roles r WHERE r.rolname = current_user';
    const app = await db.scope({}, (c) => c.query<{ u: string; bypass: boolean; su: boolean }>(q));
    const svc = await db.service((c) => c.query<{ u: string; bypass: boolean; su: boolean }>(q));
    expect(app.rows[0]).toMatchObject({ bypass: false, su: false });
    expect(svc.rows[0]).toMatchObject({ bypass: true, su: false });
    expect(await db.ping()).toEqual({ app: app.rows[0]!.u, service: svc.rows[0]!.u });
  });

  it('sin tenant no se ve ningún dato privado', async () => {
    const r = await db.scope({}, (c) => c.query<{ n: number }>(COUNT));
    expect(r.rows[0]!.n).toBe(0);
    const p = await db.scope({}, (c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM transaccion_pago'));
    expect(p.rows[0]!.n).toBe(0);
  });

  it('cada tenant ve solo lo suyo', async () => {
    const a = await db.scope({ tenantId: '1' }, (c) => c.query<{ n: number }>(COUNT));
    const b = await db.scope({ tenantId: '2' }, (c) => c.query<{ n: number }>(COUNT));
    expect(a.rows[0]!.n).toBe(16);
    expect(b.rows[0]!.n).toBe(1);
  });

  it('el tenant B no puede modificar el restaurante de A aunque fuerce el id', async () => {
    const r = await db.scope({ tenantId: '2' }, (c) => c.query("UPDATE restaurante SET descripcion_corta = 'hackeado' WHERE restaurante_id = 1"));
    expect(r.rowCount).toBe(0);
    const check = await db.service((c) => c.query<{ d: string | null }>('SELECT descripcion_corta AS d FROM restaurante WHERE restaurante_id = 1'));
    expect(check.rows[0]!.d).not.toBe('hackeado');
  });

  it('el tenant B no puede insertar filas a nombre de A (WITH CHECK)', async () => {
    await expect(
      db.scope({ tenantId: '2' }, (c) =>
        c.query("INSERT INTO cliente_restaurante (restaurante_id, nombre) VALUES (1, 'Intruso')"),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('con un pool de UNA conexión, un scope sin tenant tras uno con tenant ve 0 filas', async () => {
    const single = new DbService({ ...env, DB_POOL_MAX: 1 });
    try {
      const first = await single.scope({ tenantId: '1' }, (c) => c.query<{ n: number }>(COUNT));
      expect(first.rows[0]!.n).toBe(16);
      const second = await single.scope({}, (c) => c.query<{ n: number }>(COUNT));
      expect(second.rows[0]!.n).toBe(0);
      const ctx = await single.scope({}, (c) => c.query<{ t: string | null }>("SELECT current_setting('app.current_tenant_id', true) AS t"));
      expect(ctx.rows[0]!.t ?? '').toBe('');
    } finally {
      await single.onModuleDestroy();
    }
  });

  it('40 requests concurrentes de dos tenants no mezclan datos', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const tenantId = i % 2 === 0 ? '1' : '2';
        const rows = await db.scope({ tenantId }, async (c) => {
          await tick(i % 5);
          return c.query<{ restaurante_id: string }>('SELECT DISTINCT restaurante_id FROM cliente_restaurante');
        });
        return { tenantId, seen: rows.rows.map((r) => String(r.restaurante_id)) };
      }),
    );
    for (const r of results) expect(r.seen).toEqual([r.tenantId]);
  });

  it('el modo readOnly rechaza escrituras (25006)', async () => {
    await expect(
      db.scope({ tenantId: '1', readOnly: true }, (c) => c.query("UPDATE restaurante SET descripcion_corta = 'x' WHERE restaurante_id = 1")),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('un id de scope malicioso nunca llega a la base', async () => {
    await expect(db.scope({ tenantId: '1; DROP TABLE restaurante' }, (c) => c.query('SELECT 1'))).rejects.toThrow(/inválido/);
  });

  it('bck_api no puede leer credenciales ni secretos del QR', async () => {
    await expect(db.scope({ tenantId: '1' }, (c) => c.query('SELECT 1 FROM usuario_identidad'))).rejects.toMatchObject({ code: '42501' });
  });

  it('el rol de servicio ve todo (se salta RLS): por eso nunca atiende endpoints de negocio', async () => {
    const r = await db.service((c) => c.query<{ n: number }>(COUNT));
    expect(r.rows[0]!.n).toBeGreaterThanOrEqual(17);
  });

  it('GUARDA: si la API usara un rol con BYPASSRLS, estas pruebas de aislamiento lo detectan', async () => {
    const wrong = new DbService({ ...env, DATABASE_URL: env.DATABASE_SERVICE_URL });
    try {
      const r = await wrong.scope({}, (c) => c.query<{ n: number }>(COUNT));
      expect(r.rows[0]!.n).not.toBe(0); // el aislamiento "sin tenant = 0 filas" se rompería
    } finally {
      await wrong.onModuleDestroy();
    }
  });
});

describe('Readiness por HTTP contra base real', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  it('GET /health/ready → 200 con ambos roles', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db).toMatchObject({ app: expect.any(String), service: expect.any(String) });
  });
});

describe('Auditoría con el actor real', () => {
  const env = loadEnv();
  let db: DbService;
  beforeAll(() => { db = new DbService(env); });
  afterAll(() => db.onModuleDestroy());

  const lastLog = (entidad: string, id: string) =>
    db.service((c) => c.query<{ ejecutado_por_usuario_id: string | null; tenant_restaurante_id: string | null; accion: string }>(
      `SELECT ejecutado_por_usuario_id, tenant_restaurante_id, accion FROM log_actividad WHERE entidad_afectada = $1 AND entidad_registro_id = $2 ORDER BY log_id DESC LIMIT 1`, [entidad, id]));

  it('un cambio hecho por la API (bck_api) queda con el usuario y el tenant de la sesión', async () => {
    await db.scope({ tenantId: '1', userId: '1' }, (c) => c.query("UPDATE restaurante SET descripcion_corta = 'auditado por la API' WHERE restaurante_id = 1"));
    expect((await lastLog('restaurante', '1')).rows[0]).toMatchObject({ ejecutado_por_usuario_id: '1', tenant_restaurante_id: '1', accion: 'EDITAR' });
  });

  it('un cambio hecho por el rol de servicio con actor explícito también registra al usuario real', async () => {
    await db.service((c) => c.query("UPDATE restaurante SET descripcion_corta = 'auditado por servicio' WHERE restaurante_id = 2"), { actorUserId: '3' });
    expect((await lastLog('restaurante', '2')).rows[0]).toMatchObject({ ejecutado_por_usuario_id: '3' });
  });

  it('sin actor, el cambio queda como proceso del sistema (NULL), no con un usuario inventado', async () => {
    await db.service((c) => c.query("UPDATE restaurante SET descripcion_corta = 'auditado sin actor' WHERE restaurante_id = 3"));
    expect((await lastLog('restaurante', '3')).rows[0]!.ejecutado_por_usuario_id).toBeNull();
  });

  it('un actorUserId inválido se rechaza', async () => {
    await expect(db.service((c) => c.query('SELECT 1'), { actorUserId: '1; DROP' })).rejects.toThrow(/inválido/);
  });
});
