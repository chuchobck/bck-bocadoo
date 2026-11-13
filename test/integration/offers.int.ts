import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { offer } from './offers-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: ofertas flash (publicar, listar, cerrar)', () => {
  const k = new DinerKit(probe!, 91);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  it('el dueño publica con Idempotency-Key: nace VIGENTE con el stock completo y la misma llave devuelve la misma oferta', async () => {
    const o = await k.activeOwner();
    const key = randomUUID();
    const a = await k.as(o).post('/v1/ofertas', offer(), key);
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({
      titulo: 'Churrasco a mitad de tarde',
      precioCentavos: 450,
      precioOriginalCentavos: 650,
      descuentoPorcentaje: 31,
      moneda: 'USD',
      stockTotal: 5,
      stockRestante: 5,
      canjeadas: 0,
      estado: 'VIGENTE',
      plato: null,
    });
    const b = await k.as(o).post('/v1/ofertas', offer({ titulo: 'otra cosa' }), key);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().titulo).toBe('Churrasco a mitad de tarde');
    const rows = await probe!.sql(`SELECT 1 FROM oferta_flash o JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1`, [
      o.restaurante,
    ]);
    expect(rows.rowCount).toBe(1);
    expectOnlyPublicIds(a.json());
  });

  it('exige Idempotency-Key, valida precios y rechaza campos de más', async () => {
    const o = await k.activeOwner();
    const sinLlave = await k.as(o).post('/v1/ofertas', offer());
    expect(sinLlave.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_INVALIDA' });
    const caro = await k.as(o).post('/v1/ofertas', offer({ precioCentavos: 650 }), randomUUID());
    expect(caro.json()).toMatchObject({ status: 422, code: 'OFERTA_PRECIO_INVALIDO' });
    for (const mala of [{ stock: 0 }, { stock: 1001 }, { duracionMinutos: 1 }, { titulo: '   ' }, { precioCentavos: -1 }]) {
      expect((await k.as(o).post('/v1/ofertas', offer(mala), randomUUID())).statusCode, JSON.stringify(mala)).toBe(400);
    }
    // whitelist: un campo de más es un error, y no existe ningún campo de comisión.
    const extra = await k.as(o).post('/v1/ofertas', offer({ comisionPorcentaje: 7, stockRestante: 999 }), randomUUID());
    expect(extra.statusCode).toBe(400);
  });

  it('puede ligarse a un plato del catálogo (public_id); uno ajeno o inexistente → 404', async () => {
    const o = await k.activeOwner();
    const otro = await k.activeOwner();
    const menu = await k.menu(o);
    const menuOtro = await k.menu(otro);
    const ok = await k.as(o).post('/v1/ofertas', offer({ platoId: menu['Seco de pollo'] }), randomUUID());
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().plato).toEqual({ id: menu['Seco de pollo'], nombre: 'Seco de pollo' });
    const ajeno = await k.as(o).post('/v1/ofertas', offer({ platoId: menuOtro['Seco de pollo'] }), randomUUID());
    expect(ajeno.json()).toMatchObject({ status: 404, code: 'PLATO_NO_ENCONTRADO' });
    expect((await k.as(o).post('/v1/ofertas', offer({ platoId: randomUUID() }), randomUUID())).json().code).toBe('PLATO_NO_ENCONTRADO');
  });

  it('el cajero lista pero no publica ni cierra; un comensal o un anónimo no entran', async () => {
    const o = await k.activeOwner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    const id = (await k.as(o).post('/v1/ofertas', offer(), randomUUID())).json().id;
    expect((await k.as(cajero).post('/v1/ofertas', offer(), randomUUID())).statusCode).toBe(403);
    expect((await k.as(cajero).post(`/v1/ofertas/${id}/cerrar`)).statusCode).toBe(403);
    expect((await k.as(cajero).get('/v1/ofertas')).statusCode).toBe(200);
    expect((await k.as({ token: d.token, restaurante: o.restaurante }).get('/v1/ofertas')).statusCode).toBe(403);
    expect((await k.as({}).get('/v1/ofertas')).statusCode).toBe(401);
  });

  it('lista con cursor y filtra por estado; cerrar es repetible y la oferta cerrada sale de la vitrina', async () => {
    const o = await k.activeOwner();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await k.as(o).post('/v1/ofertas', offer({ titulo: `Oferta ${i}` }), randomUUID());
      ids.push(r.json().id);
      // CURRENT_TIMESTAMP queda fijo en el probe: separamos las fechas para que el orden sea determinista.
      await probe!.sql(`UPDATE oferta_flash SET creada_en = creada_en - make_interval(mins => $2) WHERE public_id = $1`, [
        r.json().id,
        10 * (3 - i),
      ]);
    }
    const p1 = (await k.as(o).get('/v1/ofertas?limit=2')).json();
    expect(p1.items.map((x: { id: string }) => x.id)).toEqual([ids[2], ids[1]]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await k.as(o).get(`/v1/ofertas?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();

    const slug = o.slug;
    expect((await k.as({}).get(`/v1/restaurantes/${slug}/ofertas`)).json().items).toHaveLength(3);
    const cerrar = await k.as(o).post(`/v1/ofertas/${ids[0]}/cerrar`);
    expect(cerrar.statusCode, cerrar.body).toBe(200);
    expect(cerrar.json().estado).toBe('CERRADA');
    expect((await k.as(o).post(`/v1/ofertas/${ids[0]}/cerrar`)).json().estado).toBe('CERRADA');
    expect((await k.as(o).get('/v1/ofertas?estado=CERRADA')).json().items.map((x: { id: string }) => x.id)).toEqual([ids[0]]);
    expect((await k.as(o).get('/v1/ofertas?estado=VIGENTE')).json().items).toHaveLength(2);
    expect((await k.as(o).get('/v1/ofertas?estado=RARA')).statusCode).toBe(400);
    const publica = (await k.as({}).get(`/v1/restaurantes/${slug}/ofertas`)).json();
    expect(publica.items.map((x: { id: string }) => x.id).sort()).toEqual([ids[1], ids[2]].sort());
    expectOnlyPublicIds(publica);
  });

  it('estados derivados: EXPIRADA, AGOTADA y PROGRAMADA; la vitrina solo muestra las vigentes', async () => {
    const o = await k.activeOwner();
    const mk = async (titulo: string) => (await k.as(o).post('/v1/ofertas', offer({ titulo }), randomUUID())).json().id as string;
    const vigente = await mk('vigente');
    const vencida = await mk('vencida');
    const agotada = await mk('agotada');
    const futura = await mk('futura');
    await probe!.sql(
      `UPDATE oferta_flash SET inicia_en = inicia_en - interval '3 hours', expira_en = expira_en - interval '3 hours' WHERE public_id = $1`,
      [vencida],
    );
    await probe!.sql(`UPDATE oferta_flash SET stock_restante = 0 WHERE public_id = $1`, [agotada]);
    await probe!.sql(
      `UPDATE oferta_flash SET inicia_en = inicia_en + interval '1 hour', expira_en = expira_en + interval '2 hours' WHERE public_id = $1`,
      [futura],
    );
    const estado = async (e: string) => (await k.as(o).get(`/v1/ofertas?estado=${e}`)).json().items.map((x: { id: string }) => x.id);
    expect(await estado('VIGENTE')).toEqual([vigente]);
    expect(await estado('EXPIRADA')).toEqual([vencida]);
    expect(await estado('AGOTADA')).toEqual([agotada]);
    expect(await estado('PROGRAMADA')).toEqual([futura]);
    expect((await k.as({}).get(`/v1/restaurantes/${o.slug}/ofertas`)).json().items.map((x: { id: string }) => x.id)).toEqual([vigente]);
  });

  it('un local no ve ni cierra las ofertas de otro (404) y la vitrina de un local inexistente da 404', async () => {
    const a = await k.activeOwner();
    const b = await k.activeOwner();
    const id = (await k.as(a).post('/v1/ofertas', offer(), randomUUID())).json().id;
    expect((await k.as(b).get('/v1/ofertas')).json().items).toEqual([]);
    expect((await k.as(b).post(`/v1/ofertas/${id}/cerrar`)).json()).toMatchObject({ status: 404, code: 'OFERTA_NO_ENCONTRADA' });
    expect((await k.as(a).get('/v1/ofertas')).json().items).toHaveLength(1);
    expect((await k.as({}).get('/v1/restaurantes/no-existe-este-local/ofertas')).json()).toMatchObject({
      status: 404,
      code: 'RESTAURANTE_NO_ENCONTRADO',
    });
    // Directo en SQL como bck_api con el contexto del otro local: RLS no deja tocar la oferta.
    const bId = (
      await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [b.restaurante])
    ).rows[0]!.restaurante_id;
    const tocadas = await k.h.db.scope(
      { tenantId: String(bId) },
      async (q) => (await q.query('UPDATE oferta_flash SET activa = false WHERE public_id = $1', [id])).rowCount,
    );
    expect(tocadas).toBe(0);
  });

  it('la API no puede cambiar precio ni vigencia de una oferta ya publicada (solo estado y stock)', async () => {
    const o = await k.activeOwner();
    const id = (await k.as(o).post('/v1/ofertas', offer(), randomUUID())).json().id;
    const rid = (
      await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [o.restaurante])
    ).rows[0]!.restaurante_id;
    await expect(
      k.h.db.scope({ tenantId: String(rid) }, (q) => q.query('UPDATE oferta_flash SET precio_centavos = 1 WHERE public_id = $1', [id])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
