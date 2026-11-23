import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe.skipIf(!probe)('Mesa compartida: selección de cada comensal', () => {
  const k = new DinerKit(probe!, 96);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Persona = { token: string; usuarioId: string };

  /** Plato de carta con public_id (el que ve el comensal en la vitrina). */
  async function carta(o: Local, categoria: 'A_LA_CARTA' | 'EXTRA' | 'BEBIDA', nombre: string, precioCentavos = 500) {
    const r = await k.as(o).post('/v1/menu/platos', { categoria, nombre, precioCentavos });
    expect(r.statusCode, r.body).toBe(201);
    const list = (await k.as({}).get(`/v1/restaurantes/${o.slug}/carta`)).json().items as { id: string; nombre: string }[];
    return { staffId: r.json().id as string, id: list.find((i) => i.nombre === nombre)!.id };
  }

  async function mesaConInvitado(o: Local) {
    const host = await k.diner();
    const guest = await k.diner();
    const mesa = (await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30) }, randomUUID())).json();
    expect((await k.as(guest).post(`/v1/mesas/invitacion/${mesa.id}/unirse`, {}, randomUUID())).statusCode).toBe(200);
    return { host, guest, id: mesa.id as string };
  }
  const put = (who: Persona, id: string, body: object) => k.as(who).put(`/v1/mis/mesas/${id}/seleccion`, body);
  const miembros = async (who: Persona, id: string) =>
    (await k.as(who).get(`/v1/mis/mesas/${id}`)).json().miembros as { esAnfitrion: boolean; soyYo: boolean; seleccion: unknown }[];

  it('guarda la selección completa (jugo, sopa, fuerte, postre, extras y carta con cantidad) y la reemplaza entera en cada PUT', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const ceviche = await carta(o, 'A_LA_CARTA', 'Ceviche', 700);
    const { guest, id } = await mesaConInvitado(o);

    const body = {
      almuerzo: { platos: [ids['Jugo de mora']!, ids['Sopa de quinua']!, ids['Seco de pollo']!] },
      extras: [
        { plato: ids['Huevo frito']!, cantidad: 2 },
        { plato: ceviche.id, cantidad: 1 },
      ],
    };
    const r = await put(guest, id, body);
    expect(r.statusCode, r.body).toBe(200);
    const yo = r.json().miembros.find((m: { soyYo: boolean }) => m.soyYo);
    expect(yo.seleccion).toEqual({
      almuerzo: {
        platos: [
          { id: ids['Jugo de mora'], nombre: 'Jugo de mora', seccion: 'JUGO' },
          { id: ids['Sopa de quinua'], nombre: 'Sopa de quinua', seccion: 'SOPA' },
          { id: ids['Seco de pollo'], nombre: 'Seco de pollo', seccion: 'FUERTE' },
        ],
        ofertaId: null,
      },
      extras: [
        { id: ids['Huevo frito'], nombre: 'Huevo frito', categoria: 'EXTRA', cantidad: 2 },
        { id: ceviche.id, nombre: 'Ceviche', categoria: 'A_LA_CARTA', cantidad: 1 },
      ],
      ofertas: [],
    });
    expectOnlyPublicIds(r.json());

    // Repetir la misma petición deja el mismo resultado.
    expect((await put(guest, id, body)).json().miembros).toEqual(r.json().miembros);

    // Un PUT reemplaza todo: ahora solo una bebida; el almuerzo desaparece.
    const solo = await put(guest, id, { extras: [{ plato: ids['Cola']!, cantidad: 3 }] });
    expect(solo.json().miembros.find((m: { soyYo: boolean }) => m.soyYo).seleccion).toEqual({
      almuerzo: null,
      extras: [{ id: ids['Cola'], nombre: 'Cola', categoria: 'BEBIDA', cantidad: 3 }],
      ofertas: [],
    });
    // Un cuerpo vacío la borra.
    expect((await put(guest, id, {})).json().miembros.find((m: { soyYo: boolean }) => m.soyYo).seleccion).toEqual({
      almuerzo: null,
      extras: [],
      ofertas: [],
    });
  });

  it('visibilidad: el anfitrión ve la selección de todos, el invitado solo la suya, la caja ve todas', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const { host, guest, id } = await mesaConInvitado(o);
    expect((await put(guest, id, { extras: [{ plato: ids['Cola']!, cantidad: 2 }] })).statusCode).toBe(200);
    expect((await put(host, id, { almuerzo: { platos: [ids['Seco de pollo']!] } })).statusCode).toBe(200);

    const vistoPorAnfitrion = await miembros(host, id);
    expect(vistoPorAnfitrion.every((m) => m.seleccion !== null)).toBe(true);
    expect(vistoPorAnfitrion.find((m) => !m.esAnfitrion)!.seleccion).toMatchObject({ extras: [{ nombre: 'Cola', cantidad: 2 }] });

    const vistoPorInvitado = await miembros(guest, id);
    expect(vistoPorInvitado.find((m) => m.esAnfitrion)!.seleccion).toBeNull();
    expect(vistoPorInvitado.find((m) => m.soyYo)!.seleccion).toMatchObject({ extras: [{ nombre: 'Cola' }] });
    // La lista "mis mesas" respeta la misma regla.
    const lista = (await k.as(guest).get('/v1/mis/mesas')).json()[0].miembros as { esAnfitrion: boolean; seleccion: unknown }[];
    expect(lista.find((m) => m.esAnfitrion)!.seleccion).toBeNull();

    const caja = await k.h.cashier(o.restaurante);
    const vista = await k.as(caja).get(`/v1/caja/mesas/${id}`);
    expect(vista.statusCode, vista.body).toBe(200);
    const porCaja = vista.json().miembros as { esAnfitrion: boolean; seleccion: { almuerzo: unknown; extras: unknown[] } }[];
    expect(porCaja.find((m) => m.esAnfitrion)!.seleccion.almuerzo).toMatchObject({
      platos: [{ nombre: 'Seco de pollo', seccion: 'FUERTE' }],
    });
    expect(porCaja.find((m) => !m.esAnfitrion)!.seleccion.extras).toMatchObject([{ nombre: 'Cola', cantidad: 2 }]);
    expect((await k.as(o).get(`/v1/caja/mesas/${id}`)).json().miembros).toHaveLength(2);
  });

  it('quién puede qué: un no miembro, otro local, un anónimo y un id mal formado no escriben ni leen', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const { id } = await mesaConInvitado(o);
    const extrano = await k.diner();
    const ajeno = await put(extrano, id, { extras: [{ plato: ids['Cola']!, cantidad: 1 }] });
    expect(ajeno.statusCode).toBe(404);
    expect(ajeno.json().code).toBe('MESA_NO_ENCONTRADA');
    expect((await put(extrano, randomUUID(), {})).json().code).toBe('MESA_NO_ENCONTRADA');
    expect((await put({ token: '', usuarioId: '' }, id, {})).statusCode).toBe(401);
    expect((await put(extrano, 'no-es-uuid', {})).statusCode).toBe(400);
    // El cajero de otro local ni siquiera ve la mesa.
    const otro = await k.activeOwner();
    const cajaAjena = await k.h.cashier(otro.restaurante);
    expect((await k.as(cajaAjena).get(`/v1/caja/mesas/${id}`)).statusCode).toBe(404);
  });

  it('validación: sección repetida, plato de otro local, plato fuera del menú, sin precio, cantidad inválida, repetidos', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const fuera = await k.as(o).post('/v1/menu/platos', { categoria: 'ALMUERZO', seccion: 'POSTRE', nombre: 'Flan' });
    expect(fuera.statusCode).toBe(201);
    const otro = await k.activeOwner();
    const deOtro = await carta(otro, 'BEBIDA', 'Bebida ajena');
    const { guest, id } = await mesaConInvitado(o);
    const code = async (body: object) => {
      const r = await put(guest, id, body);
      return [r.statusCode, r.json().code] as const;
    };

    expect(await code({ almuerzo: { platos: [ids['Seco de pollo']!, ids['Menestra con carne']!] } })).toEqual([400, 'ALMUERZO_INVALIDO']);
    expect(await code({ almuerzo: { platos: [ids['Huevo frito']!] } })).toEqual([400, 'ALMUERZO_INVALIDO']); // sección ADICIONAL
    expect(await code({ extras: [{ plato: deOtro.id, cantidad: 1 }] })).toEqual([422, 'PLATO_NO_DISPONIBLE']);
    expect(await code({ almuerzo: { platos: [deOtro.id] } })).toEqual([422, 'PLATO_NO_DISPONIBLE']);
    expect(await code({ extras: [{ plato: randomUUID(), cantidad: 1 }] })).toEqual([422, 'PLATO_NO_DISPONIBLE']);
    // Plato de ALMUERZO que existe pero no está en el menú de hoy.
    const publicos = (await k.as({}).get(`/v1/restaurantes/${o.slug}`)).json();
    expect(
      publicos.menuHoy.secciones.flatMap((s: { platos: { nombre: string }[] }) => s.platos).map((p: { nombre: string }) => p.nombre),
    ).not.toContain('Flan');
    const flanPublic = (await probe!.sql<{ public_id: string }>('SELECT public_id FROM plato WHERE plato_id = $1', [fuera.json().id]))
      .rows[0]!.public_id;
    expect(await code({ almuerzo: { platos: [flanPublic] } })).toEqual([422, 'PLATO_NO_DISPONIBLE']);
    expect(await code({ extras: [{ plato: flanPublic, cantidad: 1 }] })).toEqual([422, 'PLATO_NO_DISPONIBLE']);
    // Un plato que solo se sirve dentro del almuerzo no se pide suelto.
    expect(await code({ extras: [{ plato: ids['Seco de pollo']!, cantidad: 1 }] })).toEqual([422, 'PLATO_SIN_PRECIO']);
    // Un mismo plato en el almuerzo y suelto.
    expect(await code({ almuerzo: { platos: [ids['Seco de pollo']!] }, extras: [{ plato: ids['Seco de pollo']!, cantidad: 1 }] })).toEqual([
      400,
      'SELECCION_INVALIDA',
    ]);

    // Forma del cuerpo: todo esto lo frena la validación del DTO.
    const cola = ids['Cola']!;
    for (const bad of [
      { extras: [{ plato: cola, cantidad: 0 }] },
      { extras: [{ plato: cola, cantidad: 11 }] },
      { extras: [{ plato: cola, cantidad: 1.5 }] },
      { extras: [{ plato: cola, cantidad: '2' }] },
      { extras: [{ plato: cola }] },
      { extras: [{ cantidad: 1 }] },
      { extras: [{ plato: 'no-uuid', cantidad: 1 }] },
      {
        extras: [
          { plato: cola, cantidad: 1 },
          { plato: cola.toUpperCase(), cantidad: 2 },
        ],
      },
      { extras: Array.from({ length: 11 }, () => ({ plato: randomUUID(), cantidad: 1 })) },
      { almuerzo: { platos: [] } },
      { almuerzo: { platos: [ids['Seco de pollo']!, ids['Seco de pollo']!] } },
      { almuerzo: { platos: ['no-uuid'] } },
      { almuerzo: { platos: Array.from({ length: 5 }, () => randomUUID()) } },
      { extra: [] },
      { extras: [{ plato: cola, cantidad: 1, precioCentavos: 1 }] },
    ])
      expect((await put(guest, id, bad)).statusCode, JSON.stringify(bad)).toBe(400);

    // Nada de lo anterior dejó huella.
    expect((await miembros(guest, id)).find((m) => m.soyYo)!.seleccion).toEqual({ almuerzo: null, extras: [], ofertas: [] });
  });

  it('una selección rechazada no borra la anterior', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const { guest, id } = await mesaConInvitado(o);
    expect((await put(guest, id, { almuerzo: { platos: [ids['Seco de pollo']!] } })).statusCode).toBe(200);
    expect((await put(guest, id, { almuerzo: { platos: [ids['Seco de pollo']!, ids['Menestra con carne']!] } })).statusCode).toBe(400);
    expect((await miembros(guest, id)).find((m) => m.soyYo)!.seleccion).toMatchObject({
      almuerzo: { platos: [{ nombre: 'Seco de pollo' }] },
    });
  });

  it('agotados: del menú del día (almuerzo y extra) y de la carta fija; al quitar la marca vuelve a poder elegirse', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const bebida = await carta(o, 'BEBIDA', 'Limonada', 200);
    const { guest, id } = await mesaConInvitado(o);

    const menu = (await k.as(o).get('/v1/menu/hoy')).json().items as { id: string; nombre: string }[];
    const item = (n: string) => menu.find((i) => i.nombre === n)!.id;
    expect((await k.as(o).patch(`/v1/menu/hoy/items/${item('Seco de pollo')}/agotado`, { agotado: true })).statusCode).toBe(200);
    expect((await k.as(o).patch(`/v1/menu/hoy/items/${item('Cola')}/agotado`, { agotado: true })).statusCode).toBe(200);
    expect((await k.as(o).patch(`/v1/menu/platos/${bebida.staffId}/agotado`, { agotado: true })).statusCode).toBe(200);

    for (const body of [
      { almuerzo: { platos: [ids['Seco de pollo']!] } },
      { extras: [{ plato: ids['Cola']!, cantidad: 1 }] },
      { extras: [{ plato: bebida.id, cantidad: 1 }] },
    ]) {
      const r = await put(guest, id, body);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe('PLATO_AGOTADO');
    }
    // Lo que no está agotado sigue sirviendo.
    expect((await put(guest, id, { almuerzo: { platos: [ids['Menestra con carne']!] } })).statusCode).toBe(200);
    // El cajero también puede devolver el plato a la carta.
    const caja = await k.h.cashier(o.restaurante);
    expect((await k.as(caja).patch(`/v1/menu/platos/${bebida.staffId}/agotado`, { agotado: false })).statusCode).toBe(200);
    expect((await put(guest, id, { extras: [{ plato: bebida.id, cantidad: 1 }] })).statusCode).toBe(200);
  });

  it('menú sin publicar: el almuerzo (y un plato de almuerzo suelto) da MENU_NO_PUBLICADO; la carta fija no lo necesita', async () => {
    const o = await k.activeOwner();
    const bebida = await carta(o, 'BEBIDA', 'Limonada', 200);
    const almuerzo = await k.as(o).post('/v1/menu/platos', { categoria: 'ALMUERZO', seccion: 'FUERTE', nombre: 'Seco' });
    const secoPublico = (await probe!.sql<{ public_id: string }>('SELECT public_id FROM plato WHERE plato_id = $1', [almuerzo.json().id]))
      .rows[0]!.public_id;
    const { guest, id } = await mesaConInvitado(o);

    for (const body of [{ almuerzo: { platos: [secoPublico] } }, { extras: [{ plato: secoPublico, cantidad: 1 }] }]) {
      const r = await put(guest, id, body);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe('MENU_NO_PUBLICADO');
    }
    const ok = await put(guest, id, { extras: [{ plato: bebida.id, cantidad: 2 }] });
    expect(ok.statusCode, ok.body).toBe(200);

    // Un menú publicado de otro día (despublicado hoy) tampoco sirve.
    await k.h.publishMenu(o);
    expect((await k.as(o).post('/v1/menu/hoy/despublicar')).statusCode).toBe(200);
    expect((await put(guest, id, { almuerzo: { platos: [secoPublico] } })).json().code).toBe('MENU_NO_PUBLICADO');
  });

  it('local pausado → RESTAURANTE_PAUSADO; mesa cancelada o validada en caja → MESA_CERRADA', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const { host, guest, id } = await mesaConInvitado(o);
    const cola = { extras: [{ plato: ids['Cola']!, cantidad: 1 }] };

    expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
    expect((await put(guest, id, cola)).json()).toMatchObject({ status: 409, code: 'RESTAURANTE_PAUSADO' });
    expect((await k.as(o).post('/v1/restaurante/activar')).statusCode).toBe(200);
    expect((await put(guest, id, cola)).statusCode).toBe(200);

    // La caja valida la mesa: desde ahí la selección ya no cambia (ni por la API ni por RLS).
    const caja = await k.h.cashier(o.restaurante);
    const v = await k.as(caja).post(`/v1/caja/mesas/${id}/validar`, undefined, randomUUID());
    expect(v.statusCode, v.body).toBe(200);
    const cerrada = await put(guest, id, { extras: [{ plato: ids['Cola']!, cantidad: 5 }] });
    expect(cerrada.statusCode).toBe(409);
    expect(cerrada.json().code).toBe('MESA_CERRADA');
    expect((await miembros(host, id)).find((m) => !m.esAnfitrion)!.seleccion).toMatchObject({ extras: [{ cantidad: 1 }] });

    const otra = await mesaConInvitado(o);
    expect((await k.as(otra.host).post(`/v1/mis/mesas/${otra.id}/cancelar`)).statusCode).toBe(200);
    expect((await put(otra.guest, otra.id, cola)).json().code).toBe('MESA_CERRADA');
  });

  it('RLS directo: nadie escribe la selección de otro, el personal solo lee, y la mesa validada queda congelada', async () => {
    const o = await k.activeOwner();
    const ids = await k.menu(o);
    const { host, guest, id } = await mesaConInvitado(o);
    expect((await put(guest, id, { extras: [{ plato: ids['Cola']!, cantidad: 2 }] })).statusCode).toBe(200);
    const hostInterno = await k.internalUser(host.usuarioId);
    const guestInterno = await k.internalUser(guest.usuarioId);
    const extranoInterno = await k.internalUser((await k.diner()).usuarioId);
    const restauranteInterno = (
      await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [o.restaurante])
    ).rows[0]!.restaurante_id;

    // Lectura: el invitado ve solo lo suyo; el anfitrión, todo; un extraño, nada.
    const cuenta = (ctx: { userId?: string; tenantId?: string }) =>
      k.rls<{ n: number }>(ctx, 'SELECT count(*)::int AS n FROM mesa_compartida_miembro_item').then((r) => r[0]!.n);
    expect(await cuenta({ userId: guestInterno })).toBe(1);
    expect(await cuenta({ userId: hostInterno })).toBe(1);
    expect(await cuenta({ userId: extranoInterno })).toBe(0);
    expect(await cuenta({ userId: extranoInterno, tenantId: restauranteInterno })).toBe(1); // el personal del local lo ve

    const filas = (
      await probe!.sql<{ miembro_id: string; mesa_compartida_id: string; restaurante_id: string; plato_id: string }>(
        'SELECT miembro_id, mesa_compartida_id, restaurante_id, plato_id FROM mesa_compartida_miembro_item',
      )
    ).rows[0]!;
    const insertar = (ctx: { userId?: string; tenantId?: string }, miembro: string) =>
      k.rls(
        ctx,
        `INSERT INTO mesa_compartida_miembro_item (miembro_id, mesa_compartida_id, restaurante_id, plato_id, cantidad) VALUES ($1, $2, $3, $4, 1)`,
        [miembro, filas.mesa_compartida_id, filas.restaurante_id, filas.plato_id],
      );
    const anfitrionMiembro = (
      await probe!.sql<{ miembro_id: string }>(
        'SELECT miembro_id FROM mesa_compartida_miembro WHERE mesa_compartida_id = $1 AND es_anfitrion',
        [filas.mesa_compartida_id],
      )
    ).rows[0]!.miembro_id;
    await expect(insertar({ userId: guestInterno }, anfitrionMiembro)).rejects.toThrow(); // el de otro miembro
    await expect(insertar({ userId: extranoInterno }, filas.miembro_id)).rejects.toThrow();
    await expect(insertar({ userId: extranoInterno, tenantId: restauranteInterno }, filas.miembro_id)).rejects.toThrow(); // el personal no escribe
    await expect(
      k.rls({ userId: extranoInterno, tenantId: restauranteInterno }, 'DELETE FROM mesa_compartida_miembro_item'),
    ).resolves.toEqual([]);
    expect(await cuenta({ userId: guestInterno })).toBe(1); // el DELETE del personal no borró nada

    // Mesa validada: tampoco el dueño de la fila puede cambiarla por SQL.
    const caja = await k.h.cashier(o.restaurante);
    expect((await k.as(caja).post(`/v1/caja/mesas/${id}/validar`, undefined, randomUUID())).statusCode).toBe(200);
    await expect(insertar({ userId: hostInterno }, anfitrionMiembro)).rejects.toThrow();
    await k.rls({ userId: guestInterno }, 'DELETE FROM mesa_compartida_miembro_item');
    expect(await cuenta({ userId: guestInterno })).toBe(1);
  });
});
