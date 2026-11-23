import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Carta fija: platos de carta, agotado por plato y lectura pública', () => {
  const k = new DinerKit(probe!, 95);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const dish = async (o: { token: string; restaurante: string }, body: object) => {
    const r = await k.as(o).post('/v1/menu/platos', body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { id: string; orden: number; agotado: boolean; agotadoEn: string | null };
  };
  const carta = async (slug: string) => (await k.as({}).get(`/v1/restaurantes/${slug}/carta`)).json();

  it('el dueño crea platos de carta con orden; salen con orden, agotado=false y agotadoEn=null', async () => {
    const o = await k.owner();
    const p = await dish(o, { categoria: 'A_LA_CARTA', nombre: 'Encebollado', precioCentavos: 450, orden: 3 });
    expect(p).toMatchObject({ orden: 3, agotado: false, agotadoEn: null });
    expect((await k.as(o).patch(`/v1/menu/platos/${p.id}`, { orden: 1 })).json()).toMatchObject({ orden: 1 });
    const sinOrden = await dish(o, { categoria: 'BEBIDA', nombre: 'Jugo', precioCentavos: 150 });
    expect(sinOrden.orden).toBe(0);
    expect((await k.as(o).post('/v1/menu/platos', { categoria: 'BEBIDA', nombre: 'X', orden: -1 })).statusCode).toBe(400);
    expect((await k.as(o).post('/v1/menu/platos', { categoria: 'BEBIDA', nombre: 'X', orden: 1001 })).statusCode).toBe(400);
    expect((await k.as(o).patch(`/v1/menu/platos/${p.id}`, { orden: 'uno' })).statusCode).toBe(400);
  });

  it('dueño y cajero marcan agotado; repetirlo conserva la hora; el cajero no edita precio ni crea platos', async () => {
    const o = await k.owner();
    const c = await k.h.cashier(o.restaurante);
    const p = await dish(o, { categoria: 'EXTRA', nombre: 'Huevo frito', precioCentavos: 75 });

    const a = await k.as(c).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ id: p.id, agotado: true, precioCentavos: 75 });
    expect(a.json().agotadoEn).toBeTruthy();
    // Repetir "agotado" no mueve la hora: se retrasa a mano la guardada y se comprueba que sigue igual.
    await probe!.sql(`UPDATE plato SET agotado_en = agotado_en - interval '1 minute' WHERE plato_id = $1`, [p.id]);
    const antes = (await k.as(o).get('/v1/menu/platos')).json()[0].agotadoEn as string;
    expect(antes).not.toBe(a.json().agotadoEn);
    const again = await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true });
    expect(again.json()).toMatchObject({ agotado: true, agotadoEn: antes });

    const back = await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: false });
    expect(back.json()).toMatchObject({ agotado: false, agotadoEn: null });

    // El cajero solo marca agotado.
    expect((await k.as(c).patch(`/v1/menu/platos/${p.id}`, { precioCentavos: 1 })).statusCode).toBe(403);
    expect((await k.as(c).post('/v1/menu/platos', { categoria: 'EXTRA', nombre: 'Nuevo' })).statusCode).toBe(403);
    // Un comensal o un anónimo no entran.
    const d = await k.diner();
    expect(
      (await k.as({ token: d.token, restaurante: o.restaurante }).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true })).statusCode,
    ).toBe(403);
    expect((await k.as({}).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true })).statusCode).toBe(401);
    // El precio no cambió.
    expect((await k.as(c).get('/v1/menu/platos')).json()[0]).toMatchObject({ precioCentavos: 75, agotado: false });
  });

  it('entradas inválidas: cuerpo sin agotado, campos de más, id mal formado; plato inexistente → 404; de almuerzo → 422', async () => {
    const o = await k.owner();
    const p = await dish(o, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });
    const almuerzo = await dish(o, { categoria: 'ALMUERZO', seccion: 'FUERTE', nombre: 'Seco' });
    expect((await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, {})).statusCode).toBe(400);
    expect((await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: 'si' })).statusCode).toBe(400);
    expect((await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true, precioCentavos: 1 })).statusCode).toBe(400);
    expect((await k.as(o).patch('/v1/menu/platos/abc/agotado', { agotado: true })).statusCode).toBe(400);
    const nope = await k.as(o).patch('/v1/menu/platos/99999999/agotado', { agotado: true });
    expect(nope.statusCode).toBe(404);
    expect(nope.json().code).toBe('PLATO_NO_ENCONTRADO');
    const no = await k.as(o).patch(`/v1/menu/platos/${almuerzo.id}/agotado`, { agotado: true });
    expect(no.statusCode).toBe(422);
    expect(no.json().code).toBe('PLATO_NO_ES_DE_CARTA');
  });

  it('un local no puede marcar agotado un plato de otro local (404), y no se lo toca', async () => {
    const a = await k.owner();
    const b = await k.owner();
    const p = await dish(a, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });
    const r = await k.as(b).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true });
    expect(r.statusCode).toBe(404);
    expect(r.json().code).toBe('PLATO_NO_ENCONTRADO');
    expect((await k.as(a).get('/v1/menu/platos')).json()[0].agotado).toBe(false);
    // Lo mismo con un cajero de B ante el plato de A.
    const cb = await k.h.cashier(b.restaurante);
    expect((await k.as(cb).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true })).statusCode).toBe(404);
  });

  it('agotado solo vale durante su fecha local: un agotado de ayer ya no cuenta', async () => {
    const o = await k.owner();
    const p = await dish(o, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });
    await k.as(o).patch(`/v1/menu/platos/${p.id}/agotado`, { agotado: true });
    await probe!.sql(`UPDATE plato SET agotado_en = agotado_en - interval '36 hours' WHERE plato_id = $1`, [p.id]);
    expect((await k.as(o).get('/v1/menu/platos')).json()[0]).toMatchObject({ agotado: false, agotadoEn: null });
  });

  it('lectura pública: solo A_LA_CARTA, EXTRA y BEBIDA activos con precio, ordenados, con public_id y sin menú del día', async () => {
    const o = await k.activeOwner('Carta Local');
    await dish(o, {
      categoria: 'A_LA_CARTA',
      nombre: 'Zarzuela',
      precioCentavos: 900,
      orden: 2,
      descripcion: 'Mixta',
      fotoUrl: 'https://cdn.test/z.png',
    });
    await dish(o, { categoria: 'A_LA_CARTA', nombre: 'Ceviche', precioCentavos: 700, orden: 1 });
    const cola = await dish(o, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });
    await dish(o, { categoria: 'EXTRA', nombre: 'Aguacate', precioCentavos: 50 });
    const inactivo = await dish(o, { categoria: 'EXTRA', nombre: 'Inactivo', precioCentavos: 50 });
    await k.as(o).patch(`/v1/menu/platos/${inactivo.id}`, { activo: false });
    await dish(o, { categoria: 'A_LA_CARTA', nombre: 'Sin precio' });
    await dish(o, { categoria: 'ALMUERZO', seccion: 'FUERTE', nombre: 'Seco', precioCentavos: 350 });
    await k.as(o).patch(`/v1/menu/platos/${cola.id}/agotado`, { agotado: true });

    const r = await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`); // público: sin token
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.monedaCodigo).toBe('USD');
    expect(body.items.map((i: { nombre: string }) => i.nombre)).toEqual(['Ceviche', 'Zarzuela', 'Aguacate', 'Cola']);
    expect(body.items[1]).toMatchObject({
      categoria: 'A_LA_CARTA',
      descripcion: 'Mixta',
      fotoUrl: 'https://cdn.test/z.png',
      precioCentavos: 900,
      agotado: false,
      orden: 2,
    });
    expect(body.items[3]).toMatchObject({ nombre: 'Cola', agotado: true });
    expectOnlyPublicIds(body);
    expect(JSON.stringify(body)).not.toMatch(/restaurante_id|plato_id|agotadoEn/);
  });

  it('solo locales ACTIVOS: borrador, pausado o inexistente → 404 RESTAURANTE_NO_ENCONTRADO; una carta vacía es 200', async () => {
    const borrador = await k.owner();
    const slugBorrador = ((await k.as(borrador).get('/v1/restaurante')).json() as { slug: string }).slug;
    await dish(borrador, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });
    expect((await k.as({}).get(`/v1/restaurantes/${slugBorrador}/carta`)).json().code).toBe('RESTAURANTE_NO_ENCONTRADO');

    const o = await k.activeOwner();
    expect((await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`)).json()).toEqual({ monedaCodigo: 'USD', items: [] });
    expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
    const pausado = await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`);
    expect(pausado.statusCode).toBe(404);
    expect(pausado.json().code).toBe('RESTAURANTE_NO_ENCONTRADO');
    expect((await k.as({}).get('/v1/restaurantes/no-existe/carta')).statusCode).toBe(404);
    expect((await k.as({}).get('/v1/restaurantes/Mal_Slug!/carta')).statusCode).toBe(404);
  });

  it('sin caché: Cache-Control no-store en 200 y 404, y un agotado se ve en la siguiente lectura', async () => {
    const NO_CACHE = 'no-store, no-cache, must-revalidate';
    const o = await k.activeOwner();
    const c = await k.h.cashier(o.restaurante);
    const cola = await dish(o, { categoria: 'BEBIDA', nombre: 'Cola', precioCentavos: 100 });

    const antes = await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`);
    expect(antes.statusCode, antes.body).toBe(200);
    // Un solo valor (nada más lo pisa ni lo duplica) y Helmet sigue poniendo las suyas.
    expect(antes.headers['cache-control']).toBe(NO_CACHE);
    expect(antes.headers['x-content-type-options']).toBe('nosniff');
    expect(antes.json().items).toEqual([expect.objectContaining({ nombre: 'Cola', agotado: false })]);

    expect((await k.as(c).patch(`/v1/menu/platos/${cola.id}/agotado`, { agotado: true })).statusCode).toBe(200);
    const despues = await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`);
    expect(despues.headers['cache-control']).toBe(NO_CACHE);
    expect(despues.json().items).toEqual([expect.objectContaining({ nombre: 'Cola', agotado: true })]);

    for (const slug of ['no-existe', 'Mal_Slug!']) {
      const nf = await k.as({}).get(`/v1/restaurantes/${slug}/carta`);
      expect(nf.statusCode).toBe(404);
      expect(nf.json().code).toBe('RESTAURANTE_NO_ENCONTRADO');
      expect(nf.headers['cache-control']).toBe(NO_CACHE);
    }
  });

  it('la carta de un local no incluye platos de otro', async () => {
    const a = await k.activeOwner();
    const b = await k.activeOwner();
    await dish(a, { categoria: 'BEBIDA', nombre: 'Solo de A', precioCentavos: 100 });
    await dish(b, { categoria: 'BEBIDA', nombre: 'Solo de B', precioCentavos: 100 });
    expect((await carta(a.slug)).items.map((i: { nombre: string }) => i.nombre)).toEqual(['Solo de A']);
    expect((await carta(b.slug)).items.map((i: { nombre: string }) => i.nombre)).toEqual(['Solo de B']);
  });
});
