import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Actor, Harness } from './harness';

const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe('Menú: catálogo de platos, menú del día, publicar, copiar y agotado', () => {
  const h = new Harness(72);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const api = (who: Actor) => ({
    get: (url: string) => h.call('GET', url, { token: who.token, restaurante: who.restaurante }),
    post: (url: string, payload?: object) => h.call('POST', url, { token: who.token, restaurante: who.restaurante, payload }),
    put: (url: string, payload?: object) => h.call('PUT', url, { token: who.token, restaurante: who.restaurante, payload }),
    patch: (url: string, payload?: object) => h.call('PATCH', url, { token: who.token, restaurante: who.restaurante, payload }),
  });
  async function dish(who: Actor, nombre: string, extra: object = {}) {
    const r = await api(who).post('/v1/menu/platos', { categoria: 'ALMUERZO', nombre, ...extra });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  it('catálogo: el dueño crea y edita; el cajero solo lista; los platos no se borran, se desactivan', async () => {
    const o = await h.owner('Local Platos');
    const c = await h.cashier(o.restaurante);
    const created = await api(o).post('/v1/menu/platos', {
      categoria: 'A_LA_CARTA',
      seccion: 'FUERTE',
      nombre: '  Encebollado ',
      precioCentavos: 450,
      etiquetas: ['mariscos'],
      fotoUrl: 'https://cdn.test/e.png',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ nombre: 'Encebollado', precioCentavos: 450, activo: true, etiquetas: ['mariscos'] });
    const id = created.json().id;
    expect((await api(o).patch(`/v1/menu/platos/${id}`, { precioCentavos: null, activo: false })).json()).toMatchObject({
      precioCentavos: null,
      activo: false,
    });
    expect((await api(o).get('/v1/menu/platos?soloActivos=true')).json()).toEqual([]);
    expect((await api(c).get('/v1/menu/platos')).json()).toHaveLength(1);
    expect((await api(c).post('/v1/menu/platos', { categoria: 'ALMUERZO', nombre: 'X' })).statusCode).toBe(403);
    expect((await api(c).patch(`/v1/menu/platos/${id}`, { activo: true })).statusCode).toBe(403);
    expect((await api(o).post('/v1/menu/platos', { categoria: 'POSTRES', nombre: 'X' })).statusCode).toBe(400);
    expect((await api(o).post('/v1/menu/platos', { categoria: 'EXTRA', nombre: 'X', precioCentavos: -5 })).statusCode).toBe(400);
    expect((await api(o).post('/v1/menu/platos', { categoria: 'EXTRA', nombre: 'X', fotoUrl: 'javascript:alert(1)' })).statusCode).toBe(
      400,
    );
    expect((await api(o).patch(`/v1/menu/platos/${id}`, {})).statusCode).toBe(400);
    expect((await api(o).patch('/v1/menu/platos/99999999', { activo: true })).statusCode).toBe(404);
    expect((await api(o).get('/v1/menu/platos?categoria=BEBIDA')).json()).toEqual([]);
  });

  it('el menú es libre: 5 sopas y 4 segundos, sin límites por sección, con precio del día y porciones', async () => {
    const o = await h.owner('Local Libre');
    const sopas = await Promise.all([1, 2, 3, 4, 5].map((i) => dish(o, `Sopa ${i}`)));
    const fuertes = await Promise.all([1, 2, 3, 4].map((i) => dish(o, `Fuerte ${i}`, { precioCentavos: 400 })));
    const items = [
      ...sopas.map((platoId) => ({ platoId, seccion: 'SOPA' })),
      ...fuertes.map((platoId, i) => ({
        platoId,
        seccion: 'FUERTE',
        precioCentavos: i === 0 ? 500 : null,
        porciones: i === 0 ? 10 : null,
      })),
    ];
    const res = await api(o).put('/v1/menu/hoy', { items });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(9);
    expect(res.json().publicado).toBe(false);
    const f = res.json().items.filter((i: { seccion: string }) => i.seccion === 'FUERTE');
    expect(f.find((i: { nombre: string }) => i.nombre === 'Fuerte 1')).toMatchObject({
      precioCentavos: 500,
      precioDelDiaCentavos: 500,
      porciones: 10,
    });
    expect(f.find((i: { nombre: string }) => i.nombre === 'Fuerte 2')).toMatchObject({ precioCentavos: 400, precioDelDiaCentavos: null });
    // Las secciones salen en el orden del almuerzo: SOPA antes que FUERTE.
    expect(res.json().items[0].seccion).toBe('SOPA');
  });

  it('validaciones del menú: duplicados, platos ajenos o inactivos, fechas inválidas, día pasado', async () => {
    const o = await h.owner('Local Valida');
    const other = await h.owner('Local Ajeno');
    const mine = await dish(o, 'Mío');
    const theirs = await dish(other, 'Ajeno');
    const inactive = await dish(o, 'Inactivo');
    await api(o).patch(`/v1/menu/platos/${inactive}`, { activo: false });
    const put = (items: object[], fecha = 'hoy') => api(o).put(`/v1/menu/${fecha}`, { items });
    expect(
      (
        await put([
          { platoId: mine, seccion: 'SOPA' },
          { platoId: mine, seccion: 'FUERTE' },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await put([{ platoId: theirs, seccion: 'SOPA' }])).statusCode).toBe(400);
    expect((await put([{ platoId: inactive, seccion: 'SOPA' }])).statusCode).toBe(400);
    expect((await put([{ platoId: mine, seccion: 'ENTRADA' }])).statusCode).toBe(400);
    expect((await put([{ platoId: mine, seccion: 'SOPA', porciones: -1 }])).statusCode).toBe(400);
    expect((await put([{ platoId: 'abc', seccion: 'SOPA' }])).statusCode).toBe(400);
    expect((await put([], '2026-02-31')).statusCode).toBe(400);
    expect((await api(o).get('/v1/menu/ayer')).statusCode).toBe(400);
    const today = (await api(o).get('/v1/menu/hoy')).json().fecha as string;
    const past = await put([{ platoId: mine, seccion: 'SOPA' }], addDays(today, -1));
    expect(past.statusCode).toBe(409);
    expect(past.json().detail).toContain('día pasado');
    expect((await api(o).get(`/v1/menu/${addDays(today, -1)}`)).statusCode).toBe(200); // verlo sí se puede
  });

  it('publicar exige platos; publicar y despublicar; re-definir conserva lo agotado de lo que se queda', async () => {
    const o = await h.owner('Local Publica');
    const a = await dish(o, 'Arroz');
    const b = await dish(o, 'Pollo');
    expect((await api(o).post('/v1/menu/hoy/publicar')).statusCode).toBe(409);
    await api(o).put('/v1/menu/hoy', {
      items: [
        { platoId: a, seccion: 'FUERTE' },
        { platoId: b, seccion: 'FUERTE' },
      ],
    });
    const pub = await api(o).post('/v1/menu/hoy/publicar');
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ publicado: true });
    const firstPublishedAt = pub.json().publicadoEn;
    expect((await api(o).post('/v1/menu/hoy/publicar')).json().publicadoEn).toBe(firstPublishedAt); // idempotente
    const pollo = pub.json().items.find((i: { nombre: string }) => i.nombre === 'Pollo');
    expect((await api(o).patch(`/v1/menu/hoy/items/${pollo.id}/agotado`, { agotado: true })).statusCode).toBe(200);
    // Vuelvo a definir el menú sin Arroz: Pollo se queda y sigue agotado.
    const again = await api(o).put('/v1/menu/hoy', { items: [{ platoId: b, seccion: 'FUERTE', porciones: 3 }] });
    expect(again.json().items).toHaveLength(1);
    expect(again.json().items[0]).toMatchObject({ nombre: 'Pollo', agotado: true, porciones: 3 });
    expect((await api(o).post('/v1/menu/hoy/despublicar')).json()).toMatchObject({ publicado: false, publicadoEn: null });
  });

  it('agotado guarda la hora, la conserva si se repite, se puede quitar y también lo hace el cajero', async () => {
    const o = await h.owner('Local Agotado');
    const c = await h.cashier(o.restaurante);
    const p = await dish(o, 'Seco');
    const menu = await api(o).put('/v1/menu/hoy', { items: [{ platoId: p, seccion: 'FUERTE' }] });
    const id = menu.json().items[0].id;
    const on = await api(c).patch(`/v1/menu/hoy/items/${id}/agotado`, { agotado: true });
    expect(on.statusCode).toBe(200);
    const at = on.json().items[0].agotadoEn;
    expect(at).toBeTruthy();
    expect((await api(o).patch(`/v1/menu/hoy/items/${id}/agotado`, { agotado: true })).json().items[0].agotadoEn).toBe(at);
    expect((await api(c).patch(`/v1/menu/hoy/items/${id}/agotado`, { agotado: false })).json().items[0]).toMatchObject({
      agotado: false,
      agotadoEn: null,
    });
    expect((await api(c).put('/v1/menu/hoy', { items: [] })).statusCode).toBe(403); // el cajero no edita el menú
    expect((await api(c).patch('/v1/menu/hoy/items/99999999/agotado', { agotado: true })).statusCode).toBe(404);
    expect((await api(o).patch(`/v1/menu/hoy/items/${id}/agotado`, { agotado: 'sí' })).statusCode).toBe(400);
  });

  it('un local no puede marcar agotado ni ver el menú de otro, aunque conozca el id del renglón', async () => {
    const a = await h.owner('Local Aislado A');
    const b = await h.owner('Local Aislado B');
    const p = await dish(a, 'Plato A');
    const menu = await api(a).put('/v1/menu/hoy', { items: [{ platoId: p, seccion: 'FUERTE' }] });
    const id = menu.json().items[0].id;
    expect((await api(b).patch(`/v1/menu/hoy/items/${id}/agotado`, { agotado: true })).statusCode).toBe(404);
    expect((await api(b).get('/v1/menu/hoy')).json().items).toEqual([]);
    expect((await api(b).get('/v1/menu/platos')).json()).toEqual([]);
    expect((await api(a).get('/v1/menu/hoy')).json().items[0].agotado).toBe(false);
  });

  it('copiar el menú anterior: por defecto el último con platos; sin agotados; conflicto si ya hay platos', async () => {
    const o = await h.owner('Local Copia');
    const p1 = await dish(o, 'Sopa A');
    const p2 = await dish(o, 'Fuerte A');
    const gone = await dish(o, 'Postre B');
    const today = (await api(o).get('/v1/menu/hoy')).json().fecha as string;
    const d1 = addDays(today, 1);
    const d2 = addDays(today, 3);
    const first = await api(o).put(`/v1/menu/${d1}`, {
      items: [
        { platoId: p1, seccion: 'SOPA' },
        { platoId: p2, seccion: 'FUERTE', precioCentavos: 600 },
        { platoId: gone, seccion: 'POSTRE' },
      ],
    });
    await api(o).patch(`/v1/menu/${d1}/items/${first.json().items[0].id}/agotado`, { agotado: true });
    await api(o).patch(`/v1/menu/platos/${gone}`, { activo: false }); // se desactiva después: no debe copiarse
    expect((await api(o).post(`/v1/menu/${d1}/copiar`, { desde: d1 })).statusCode).toBe(400);
    expect((await api(o).post(`/v1/menu/${addDays(today, 2)}/copiar`, { desde: '2020-01-01' })).statusCode).toBe(404);
    const copy = await api(o).post(`/v1/menu/${d2}/copiar`, {});
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ fecha: d2, publicado: false });
    expect(
      copy
        .json()
        .items.map((i: { nombre: string }) => i.nombre)
        .sort(),
    ).toEqual(['Fuerte A', 'Sopa A']);
    expect(copy.json().items.every((i: { agotado: boolean }) => i.agotado === false)).toBe(true);
    expect(copy.json().items.find((i: { nombre: string }) => i.nombre === 'Fuerte A').precioCentavos).toBe(600);
    expect((await api(o).post(`/v1/menu/${d2}/copiar`, {})).statusCode).toBe(409);
    expect((await api(o).post(`/v1/menu/${d2}/copiar`, { reemplazar: true })).statusCode).toBe(200);
    const none = await h.owner('Local Sin Menú');
    expect((await api(none).post(`/v1/menu/${d2}/copiar`, {})).statusCode).toBe(404);
  });

  it('"hoy" usa la zona horaria del restaurante, no la del servidor', async () => {
    const o = await h.owner('Local Zona');
    const gt = await h.db.service((q) =>
      q.query<{ hoy: string }>(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Guayaquil')::date::text AS hoy`),
    );
    expect((await api(o).get('/v1/menu/hoy')).json().fecha).toBe(gt.rows[0]!.hoy);
  });
});
