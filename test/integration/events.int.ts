import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: ingesta de eventos de producto', () => {
  const k = new DinerKit(probe!, 98);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const ev = (extra: object = {}) => ({ tipo: 'menu.visto', propiedades: { seccion: 'sopas' }, ...extra });
  const send = (who: { token?: string }, body: object, key: string | null = randomUUID()) =>
    k.as(who).post('/v1/eventos', body, key ?? undefined);
  const rows = async (usuarioPublicId: string) =>
    (
      await probe!.sql<Record<string, unknown>>(
        `SELECT e.tipo, e.usuario_id::text, e.restaurante_id::text, e.sesion_id::text, e.plataforma, e.version_app, e.pais_codigo, e.ciudad_id::text,
                e.propiedades, e.ocurrido_en
           FROM evento_analitica e JOIN usuario u ON u.usuario_id = e.usuario_id WHERE u.public_id = $1 ORDER BY e.evento_id`,
        [usuarioPublicId],
      )
    ).rows;
  const consent = (publicId: string) => probe!.sql('UPDATE usuario SET consiente_analitica = true WHERE public_id = $1', [publicId]);
  const total = async () => Number((await probe!.sql<{ n: string }>('SELECT count(*) AS n FROM evento_analitica')).rows[0]!.n);

  it('con consentimiento: guarda cada evento con la sesión, la plataforma y el contexto del local', async () => {
    const d = await k.diner();
    const o = await k.activeOwner();
    await consent(d.usuarioId);
    const sesion = randomUUID();
    const r = await send(d, {
      sesionId: sesion,
      plataforma: 'ANDROID',
      versionApp: '1.4.2',
      eventos: [
        ev({ tipo: 'oferta.impresion', restauranteId: o.restaurante, propiedades: { posicion: 2 } }),
        ev({ ocurridoEn: new Date(Date.now() - 3600_000).toISOString(), usuarioId: d.usuarioId }),
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({ aceptados: 2, anonimizado: false });
    const got = await rows(d.usuarioId);
    expect(got).toHaveLength(2);
    const uid = await k.internalUser(d.usuarioId);
    expect(got[0]).toMatchObject({
      tipo: 'oferta.impresion',
      usuario_id: uid,
      sesion_id: sesion,
      plataforma: 'ANDROID',
      version_app: '1.4.2',
      propiedades: { posicion: 2 },
    });
    const rest = (
      await probe!.sql<{ restaurante_id: string; pais_codigo: string; ciudad_id: string }>(
        'SELECT restaurante_id::text, pais_codigo, ciudad_id::text FROM restaurante WHERE public_id = $1',
        [o.restaurante],
      )
    ).rows[0]!;
    expect(got[0]).toMatchObject({ restaurante_id: rest.restaurante_id, pais_codigo: rest.pais_codigo, ciudad_id: rest.ciudad_id });
    expect(got[1]).toMatchObject({ tipo: 'menu.visto', restaurante_id: null, propiedades: { seccion: 'sopas' } });
    expect(Date.now() - new Date(got[1]!.ocurrido_en as string).getTime()).toBeGreaterThan(3_500_000);
  });

  it('sin consentimiento de analítica los eventos entran anonimizados (sin usuario ni sesión)', async () => {
    const d = await k.diner();
    const r = await send(d, { sesionId: randomUUID(), plataforma: 'WEB', eventos: [ev(), ev({ tipo: 'menu.buscado' })] });
    expect(r.json()).toEqual({ aceptados: 2, anonimizado: true });
    expect(await rows(d.usuarioId)).toHaveLength(0);
    const anon = await probe!.sql<{ usuario_id: string | null; sesion_id: string | null; plataforma: string }>(
      `SELECT usuario_id, sesion_id, plataforma FROM evento_analitica WHERE usuario_id IS NULL AND tipo IN ('menu.visto', 'menu.buscado') AND plataforma = 'WEB'`,
    );
    expect(anon.rowCount).toBe(2);
    expect(anon.rows[0]).toMatchObject({ usuario_id: null, sesion_id: null });
    // Si luego da su consentimiento, los nuevos eventos ya llevan su identidad.
    await consent(d.usuarioId);
    expect((await send(d, { eventos: [ev()] })).json().anonimizado).toBe(false);
    expect(await rows(d.usuarioId)).toHaveLength(1);
  });

  it('Idempotency-Key: reintentar un lote no duplica eventos y devuelve lo mismo; sin llave → 400', async () => {
    const d = await k.diner();
    await consent(d.usuarioId);
    const key = randomUUID();
    const a = await send(d, { eventos: [ev(), ev()] }, key);
    const b = await send(d, { eventos: [ev(), ev()] }, key);
    const c = await send(d, { eventos: [ev({ tipo: 'otro.evento' })] }, key); // misma llave, otro contenido: manda el primer lote
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 201]);
    expect(b.json()).toEqual(a.json());
    expect(c.json()).toEqual(a.json());
    expect(await rows(d.usuarioId)).toHaveLength(2);
    expect((await send(d, { eventos: [ev()] }, null)).json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_INVALIDA' });
    // La llave es por usuario: otro usuario con la misma llave guarda su propio lote.
    const e = await k.diner();
    await consent(e.usuarioId);
    expect((await send(e, { eventos: [ev()] }, key)).statusCode).toBe(201);
    expect(await rows(e.usuarioId)).toHaveLength(1);
  });

  it('rechaza eventos a nombre de otro usuario: el lote entero queda sin guardar', async () => {
    const d = await k.diner();
    const otro = await k.diner();
    await consent(d.usuarioId);
    await consent(otro.usuarioId);
    const antes = await total();
    const r = await send(d, { eventos: [ev(), ev({ usuarioId: otro.usuarioId })] });
    expect(r.json()).toMatchObject({ status: 403, code: 'EVENTO_USUARIO_AJENO' });
    expect(await total()).toBe(antes);
    expect(await rows(otro.usuarioId)).toHaveLength(0);
    // El propio public_id (en mayúsculas o minúsculas) sí vale.
    expect((await send(d, { eventos: [ev({ usuarioId: d.usuarioId.toUpperCase() })] })).statusCode).toBe(201);
    // La base lo exige también: como bck_api con la sesión de d, insertar con el usuario de otro viola RLS.
    const uidD = await k.internalUser(d.usuarioId);
    const uidOtro = await k.internalUser(otro.usuarioId);
    await expect(
      k.h.db.scope({ userId: uidD }, (q) =>
        q.query(`INSERT INTO evento_analitica (tipo, usuario_id) VALUES ('menu.visto', $1)`, [uidOtro]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await k.h.db.scope({ userId: uidD }, (q) =>
          q.query(`INSERT INTO evento_analitica (tipo, usuario_id) VALUES ('menu.visto', $1)`, [uidD]),
        )
      ).rowCount,
    ).toBe(1);
  });

  it('límites de tamaño: 1–50 eventos, tipo válido, propiedades de 1 KB y 20 claves, fechas de 7 días atrás a 5 minutos adelante', async () => {
    const d = await k.diner();
    const antes = await total();
    const bad = async (body: object, status: number, code?: string) => {
      const r = await send(d, body);
      expect(r.statusCode, JSON.stringify(body).slice(0, 80) + ' → ' + r.body).toBe(status);
      if (code) expect(r.json().code).toBe(code);
    };
    await bad({ eventos: [] }, 400);
    await bad({ eventos: Array.from({ length: 51 }, () => ev()) }, 400);
    await bad({}, 400);
    await bad({ eventos: [ev({ tipo: 'Menu Visto' })] }, 400);
    await bad({ eventos: [ev({ tipo: 'ab' })] }, 400);
    await bad({ eventos: [ev({ propiedades: 'texto' })] }, 400);
    await bad({ eventos: [ev({ cantidad: 3 })] }, 400); // whitelist
    await bad({ eventos: [ev()], otro: 1 }, 400);
    await bad({ plataforma: 'PALM', eventos: [ev()] }, 400);
    await bad({ eventos: [ev({ ocurridoEn: 'ayer' })] }, 400);
    await bad({ eventos: [ev({ propiedades: { texto: 'x'.repeat(1100) } })] }, 422, 'EVENTO_MUY_GRANDE');
    await bad(
      { eventos: [ev({ propiedades: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })] },
      422,
      'EVENTO_MUY_GRANDE',
    );
    await bad({ eventos: [ev({ ocurridoEn: new Date(Date.now() - 8 * 86_400_000).toISOString() })] }, 422, 'EVENTO_FECHA_INVALIDA');
    await bad({ eventos: [ev({ ocurridoEn: new Date(Date.now() + 3600_000).toISOString() })] }, 422, 'EVENTO_FECHA_INVALIDA');
    await bad({ eventos: [ev({ restauranteId: randomUUID() })] }, 404, 'RESTAURANTE_NO_ENCONTRADO');
    expect(await total()).toBe(antes);
    // Justo en el borde: 50 eventos, 1 KB y 20 claves.
    const ok = ev({ propiedades: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(30)])) });
    expect(Buffer.byteLength(JSON.stringify(ok.propiedades))).toBeLessThan(1024);
    expect((await send(d, { eventos: Array.from({ length: 50 }, () => ok) })).json().aceptados).toBe(50);
    // Cuerpo enorme: 413 antes de tocar la base.
    const enorme = await send(d, {
      eventos: Array.from({ length: 50 }, () => ev({ propiedades: { texto: 'x'.repeat(1000) } })),
      relleno: 'x'.repeat(100_000),
    });
    expect(enorme.statusCode).toBe(413);
  });

  it('límite de tasa por usuario: 20 lotes o 500 eventos por minuto → 429 EVENTOS_LIMITE_TASA; otro usuario no se afecta', async () => {
    const a = await k.diner();
    const b = await k.diner();
    for (let i = 0; i < 20; i++) expect((await send(a, { eventos: [ev()] })).statusCode, `lote ${i}`).toBe(201);
    const r = await send(a, { eventos: [ev()] });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('EVENTOS_LIMITE_TASA');
    expect((await send(b, { eventos: [ev()] })).statusCode).toBe(201);
    // Por volumen: 10 lotes de 50 = 500 eventos; el siguiente, aunque sea de 1, ya no cabe.
    const c = await k.diner();
    for (let i = 0; i < 10; i++) expect((await send(c, { eventos: Array.from({ length: 50 }, () => ev()) })).statusCode).toBe(201);
    expect((await send(c, { eventos: [ev()] })).json().code).toBe('EVENTOS_LIMITE_TASA');
    // Repetir un lote ya aceptado (misma llave) no cuenta contra el límite ni falla.
    const key = randomUUID();
    const d = await k.diner();
    expect((await send(d, { eventos: [ev()] }, key)).statusCode).toBe(201);
    for (let i = 0; i < 19; i++) await send(d, { eventos: [ev()] });
    expect((await send(d, { eventos: [ev()] }, key)).statusCode).toBe(201);
  });

  it('por IP: más de 60 lotes por minuto desde la misma dirección → 429 con Retry-After, aunque no tenga sesión', async () => {
    const ip = '10.98.250.7';
    const hit = () => k.h.app.inject({ method: 'POST', url: '/v1/eventos', payload: { eventos: [ev()] }, remoteAddress: ip });
    for (let i = 0; i < 60; i++) expect((await hit()).statusCode).toBe(401);
    const r = await hit();
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('exige sesión: sin token → 401, y la ruta no es pública', async () => {
    expect((await send({}, { eventos: [ev()] })).statusCode).toBe(401);
  });
});
