import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe.skipIf(!probe)('Fase 8: mesas compartidas por link', () => {
  const k = new DinerKit(probe!, 85);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const createTable = (who: { token: string }, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/mesas', body, key);
  const join = (who: { token: string }, id: string, body: object = {}) =>
    k.as(who).post(`/v1/mesas/invitacion/${id}/unirse`, body, randomUUID());

  it('el anfitrión crea la mesa (idempotente) y comparte el link; el invitado lo valida y se une una sola vez', async () => {
    const o = await k.activeOwner('Mesa Local');
    const host = await k.diner();
    const guest = await k.diner();
    const key = randomUUID();
    const r = await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(30), modo: 'CADA_UNO' }, key);
    expect(r.statusCode, r.body).toBe(201);
    const mesa = r.json();
    expect(mesa).toMatchObject({
      invitacion: mesa.id,
      restaurante: { id: o.restaurante },
      soyAnfitrion: true,
      modo: 'CADA_UNO',
      estado: 'ABIERTA',
      miembros: [{ nombre: 'Comensal Prueba', esAnfitrion: true, soyYo: true }],
    });
    expect((await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(30) }, key)).json().id).toBe(mesa.id);
    const o2 = await k.activeOwner();
    expect((await createTable(host, { restaurante: o2.restaurante, horaLlegada: inMinutes(30) }, key)).json().code).toBe(
      'IDEMPOTENCY_KEY_REUTILIZADA',
    );

    // Antes de unirse, el invitado no ve la mesa (RLS) pero sí puede validar el link.
    expect((await k.as(guest).get(`/v1/mis/mesas/${mesa.id}`)).json().code).toBe('MESA_NO_ENCONTRADA');
    const inv = (await k.as(guest).get(`/v1/mesas/invitacion/${mesa.invitacion}`)).json();
    expect(inv).toMatchObject({
      id: mesa.id,
      anfitrion: { nombre: 'Comensal Prueba' },
      personas: 1,
      capacidad: 12,
      puedeUnirse: true,
      motivo: null,
    });
    expectOnlyPublicIds(inv);

    const j = await join(guest, mesa.id, { paraLlevar: true });
    expect(j.statusCode, j.body).toBe(200);
    expect(j.json().soyAnfitrion).toBe(false);
    expect(j.json().miembros).toEqual([
      { nombre: 'Comensal Prueba', esAnfitrion: true, paraLlevar: false, soyYo: false },
      { nombre: 'Comensal Prueba', esAnfitrion: false, paraLlevar: true, soyYo: true },
    ]);
    expect((await join(guest, mesa.id)).json().miembros).toHaveLength(2);
    expect((await k.as(guest).get(`/v1/mesas/invitacion/${mesa.id}`)).json()).toMatchObject({
      puedeUnirse: false,
      motivo: 'YA_ERES_MIEMBRO',
    });
    // El anfitrión ve al invitado; ambos la tienen en "mis mesas".
    expect((await k.as(host).get(`/v1/mis/mesas/${mesa.id}`)).json().miembros).toHaveLength(2);
    expect((await k.as(guest).get('/v1/mis/mesas')).json().map((m: { id: string }) => m.id)).toEqual([mesa.id]);
    expectOnlyPublicIds((await k.as(host).get('/v1/mis/mesas')).json());
  });

  it('validar el link: inexistente, cancelada, vencida, llena o local pausado → no se une (códigos estables)', async () => {
    const o = await k.activeOwner();
    const host = await k.diner();
    const guest = await k.diner();
    const mk = async () => (await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(10) })).json().id as string;

    const ghost = randomUUID();
    expect((await k.as(guest).get(`/v1/mesas/invitacion/${ghost}`)).json()).toMatchObject({ status: 404, code: 'MESA_NO_ENCONTRADA' });
    expect((await join(guest, ghost)).json()).toMatchObject({ status: 404, code: 'MESA_NO_ENCONTRADA' });

    const cancelada = await mk();
    expect((await k.as(host).post(`/v1/mis/mesas/${cancelada}/cancelar`)).json().estado).toBe('CANCELADA');
    expect((await k.as(guest).get(`/v1/mesas/invitacion/${cancelada}`)).json()).toMatchObject({
      puedeUnirse: false,
      motivo: 'MESA_CERRADA',
    });
    expect((await join(guest, cancelada)).json()).toMatchObject({ status: 409, code: 'MESA_CERRADA' });

    const vencida = await mk();
    await probe!.sql(`UPDATE mesa_compartida SET hora_llegada = CURRENT_TIMESTAMP - interval '61 minutes' WHERE public_id = $1`, [vencida]);
    expect((await join(guest, vencida)).json()).toMatchObject({ status: 409, code: 'MESA_VENCIDA' });

    const llena = await mk();
    await probe!.sql(
      `INSERT INTO mesa_compartida_miembro (mesa_compartida_id, restaurante_id, nombre)
       SELECT m.mesa_compartida_id, m.restaurante_id, 'Invitado ' || g FROM mesa_compartida m, generate_series(1, 11) g WHERE m.public_id = $1`,
      [llena],
    );
    expect((await k.as(guest).get(`/v1/mesas/invitacion/${llena}`)).json()).toMatchObject({ personas: 12, motivo: 'MESA_LLENA' });
    expect((await join(guest, llena)).json()).toMatchObject({ status: 409, code: 'MESA_LLENA' });

    const pausada = await mk();
    expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
    expect((await join(guest, pausada)).json()).toMatchObject({ status: 409, code: 'RESTAURANTE_NO_DISPONIBLE' });
    expect((await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(10) })).json().code).toBe(
      'RESTAURANTE_NO_ENCONTRADO',
    );

    expect((await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(-60) })).json().code).toBe(
      'HORA_LLEGADA_INVALIDA',
    );
    expect((await createTable(host, { restaurante: o.restaurante, horaLlegada: 'mañana' })).statusCode).toBe(400);
    expect((await k.as(guest).post(`/v1/mesas/invitacion/${pausada}/unirse`, {})).json().code).toBe('IDEMPOTENCY_KEY_INVALIDA');
  });

  it('solo el anfitrión cancela, y no después de la caja; la caja valida la mesa creada desde la app', async () => {
    const o = await k.activeOwner();
    const host = await k.dinerWithPlan(o);
    const guest = await k.dinerWithPlan(o);
    const mesa = (await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(5) })).json();
    await join(guest, mesa.id);
    expect((await k.as(guest).post(`/v1/mis/mesas/${mesa.id}/cancelar`)).json()).toMatchObject({ status: 403, code: 'SOLO_ANFITRION' });

    const preview = (await k.as(o).get(`/v1/caja/mesas/${mesa.id}`)).json();
    expect(preview).toMatchObject({ modo: 'CADA_UNO', personas: 2, cubiertos: 2 });
    const v = (await k.as(o).post(`/v1/caja/mesas/${mesa.id}/validar`, {}, randomUUID())).json();
    expect(v).toMatchObject({ descontados: 2, porCobrar: 0 });
    expect((await k.as(guest).get(`/v1/mis/mesas/${mesa.id}`)).json()).toMatchObject({ estado: 'EN_MESA', validadaEn: expect.any(String) });
    expect((await k.as(host).post(`/v1/mis/mesas/${mesa.id}/cancelar`)).json()).toMatchObject({ status: 409, code: 'MESA_CERRADA' });
    expect((await k.as(guest).get('/v1/mis/consumos')).json().items[0]).toMatchObject({ canal: 'MESA' });

    // "Invito yo": paga el anfitrión los dos almuerzos.
    const h2 = await k.dinerWithPlan(o);
    const g2 = await k.diner();
    const m2 = (await createTable(h2, { restaurante: o.restaurante, horaLlegada: inMinutes(5), modo: 'INVITO_YO' })).json();
    await join(g2, m2.id);
    expect((await k.as(o).post(`/v1/caja/mesas/${m2.id}/validar`, {}, randomUUID())).json()).toMatchObject({ descontados: 2 });
    expect((await k.as(o).get(`/v1/clientes/${h2.clienteId}`)).json().almuerzosDisponibles).toBe(3);
  });

  it('quien no está en la mesa no la ve (API y RLS) y nadie se agrega ni la valida saltándose la API', async () => {
    const o = await k.activeOwner();
    const host = await k.diner();
    const otro = await k.diner();
    const mesa = (await createTable(host, { restaurante: o.restaurante, horaLlegada: inMinutes(5) })).json();
    expect((await k.as(otro).get(`/v1/mis/mesas/${mesa.id}`)).statusCode).toBe(404);
    expect((await k.as(otro).post(`/v1/mis/mesas/${mesa.id}/cancelar`)).statusCode).toBe(404);
    expect((await k.as(otro).get('/v1/mis/mesas')).json()).toEqual([]);

    const uid = await k.internalUser(otro.usuarioId);
    const hostId = await k.internalUser(host.usuarioId);
    expect(await k.rls({ userId: uid }, 'SELECT public_id FROM mesa_compartida')).toEqual([]);
    expect(await k.rls({ userId: uid }, 'SELECT nombre FROM mesa_compartida_miembro')).toEqual([]);
    const ids = (
      await probe!.sql<{ mesa_compartida_id: string; restaurante_id: string }>(
        'SELECT mesa_compartida_id, restaurante_id FROM mesa_compartida WHERE public_id = $1',
        [mesa.id],
      )
    ).rows[0]!;
    // Insertarse directo (sin fn_unirse_mesa, que valida el link) → RLS lo rechaza.
    await expect(
      k.rls(
        { userId: uid },
        `INSERT INTO mesa_compartida_miembro (mesa_compartida_id, restaurante_id, usuario_id, nombre) VALUES ($1, $2, app_user_id(), 'x')`,
        [ids.mesa_compartida_id, ids.restaurante_id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // El anfitrión no puede marcarla validada ni crearla ya en la mesa.
    await expect(
      k.rls({ userId: hostId }, `UPDATE mesa_compartida SET validada_en = CURRENT_TIMESTAMP, estado = 'EN_MESA' WHERE public_id = $1`, [
        mesa.id,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      k.rls(
        { userId: hostId },
        `INSERT INTO mesa_compartida (restaurante_id, anfitrion_usuario_id, hora_llegada, estado) VALUES ($1, app_user_id(), CURRENT_TIMESTAMP, 'EN_MESA')`,
        [ids.restaurante_id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
