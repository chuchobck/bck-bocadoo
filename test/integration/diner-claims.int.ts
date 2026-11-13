import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: reclamos del comensal', () => {
  const k = new DinerKit(probe!, 88);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const claim = (who: { token: string }, consumo: string, mensaje = 'Me descontaron y ese día no almorcé.', key = randomUUID()) =>
    k.as(who).post(`/v1/mis/consumos/${consumo}/reclamo`, { mensaje }, key);

  async function setup() {
    const o = await k.owner('Reclamos Local');
    const d = await k.dinerWithPlan(o);
    const c = await k.lunch(o, d.clienteId);
    return { o, d, c };
  }

  it('el comensal reclama, el dueño lo ve en su lista y al aceptarlo el almuerzo vuelve al plan', async () => {
    const { o, d, c } = await setup();
    const r = await claim(d, c);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ consumo: { id: c }, estado: 'PENDIENTE', respuesta: null, resueltoEn: null });
    expectOnlyPublicIds(r.json());

    const staff = (await k.as(o).get('/v1/reclamos')).json();
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ estado: 'PENDIENTE', mensaje: 'Me descontaron y ese día no almorcé.', consumo: { id: c } });
    const before = (await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles;
    expect((await k.as(o).post(`/v1/reclamos/${staff[0].id}/devolver`, { respuesta: 'Tienes razón.' })).statusCode).toBe(200);
    expect((await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles).toBe(before + 1);

    expect((await k.as(d).get('/v1/mis/reclamos')).json()).toEqual([
      expect.objectContaining({ consumo: expect.objectContaining({ id: c }), estado: 'DEVUELTO', respuesta: 'Tienes razón.' }),
    ]);
    expect((await k.as(d).get(`/v1/mis/consumos/${c}`)).json().revertido).toBe(true);
    // Ya resuelto: no se reclama otra vez (y el almuerzo ya está revertido).
    expect((await claim(d, c)).json()).toMatchObject({ status: 409 });
  });

  it('uno por almuerzo: misma clave → el mismo reclamo; otra clave → 409; también tras un rechazo', async () => {
    const { o, d, c } = await setup();
    const key = randomUUID();
    const [a, b] = await Promise.all([claim(d, c, undefined, key), claim(d, c, undefined, key)]);
    expect(a.json()).toEqual(b.json());
    expect((await claim(d, c)).json()).toMatchObject({ status: 409, code: 'RECLAMO_YA_EXISTE' });
    const id = (await k.as(o).get('/v1/reclamos')).json()[0].id;
    await k.as(o).post(`/v1/reclamos/${id}/rechazar`, { respuesta: 'Sí almorzaste ese día.' });
    expect((await claim(d, c)).json()).toMatchObject({ status: 409, code: 'RECLAMO_YA_EXISTE' });
    expect((await k.as(d).get('/v1/mis/reclamos')).json()[0]).toMatchObject({ estado: 'RECHAZADO', respuesta: 'Sí almorzaste ese día.' });
  });

  it('almuerzo deshecho → CONSUMO_REVERTIDO; de hace más de 7 días → RECLAMO_VENCIDO; mensaje corto o campos extra → 400', async () => {
    const { o, d, c } = await setup();
    await k.as(o).post(`/v1/caja/consumos/${c}/deshacer`);
    expect((await claim(d, c)).json()).toMatchObject({ status: 409, code: 'CONSUMO_REVERTIDO' });

    const s2 = await setup();
    await k.backdateLunch(s2.c, 7 * 24 * 60 + 1);
    expect((await claim(s2.d, s2.c)).json()).toMatchObject({ status: 409, code: 'RECLAMO_VENCIDO' });
    const s3 = await setup();
    expect((await claim(s3.d, s3.c, 'corto')).statusCode).toBe(400);
    expect(
      (await k.as(s3.d).post(`/v1/mis/consumos/${s3.c}/reclamo`, { mensaje: 'Un mensaje largo', estado: 'DEVUELTO' }, randomUUID()))
        .statusCode,
    ).toBe(400);
    expect((await k.as(s3.d).post(`/v1/mis/consumos/${s3.c}/reclamo`, { mensaje: 'Un mensaje largo' })).json().code).toBe(
      'IDEMPOTENCY_KEY_INVALIDA',
    );
  });

  it('solo sobre almuerzos propios: API 404 y RLS rechaza reclamar por el almuerzo de otro o crearlo ya resuelto', async () => {
    const { o, d, c } = await setup();
    const otro = await k.dinerWithPlan(o);
    expect((await claim(otro, c)).json()).toMatchObject({ status: 404, code: 'CONSUMO_NO_ENCONTRADO' });
    await claim(d, c);
    expect((await k.as(otro).get('/v1/mis/reclamos')).json()).toEqual([]);

    const ids = (
      await probe!.sql<{ restaurante_id: string; consumo_id: string; cliente_id: string; usuario_id: string; mio: string }>(
        `SELECT k.restaurante_id, k.consumo_id, c2.cliente_id, c2.usuario_id,
                (SELECT c1.cliente_id FROM cliente_restaurante c1 JOIN usuario u1 USING (usuario_id) WHERE u1.public_id = $3) AS mio
           FROM consumo_almuerzo k
           JOIN cliente_restaurante c2 ON c2.restaurante_id = k.restaurante_id
           JOIN usuario u2 ON u2.usuario_id = c2.usuario_id
          WHERE k.public_id = $1 AND u2.public_id = $2`,
        [c, otro.usuarioId, d.usuarioId],
      )
    ).rows[0]!;
    expect(await k.rls({ userId: ids.usuario_id }, 'SELECT reclamo_id FROM reclamo')).toEqual([]);
    const insert = (userId: string, clienteId: string, estado: string) =>
      k.rls(
        { userId },
        `INSERT INTO reclamo (restaurante_id, consumo_id, cliente_id, mensaje, estado, resuelto_en)
         VALUES ($1, $2, $3, 'Reclamo directo', $4::estado_reclamo_enum, CASE WHEN $4 = 'PENDIENTE' THEN NULL ELSE CURRENT_TIMESTAMP END)`,
        [ids.restaurante_id, ids.consumo_id, clienteId, estado],
      );
    await expect(insert(ids.usuario_id, ids.cliente_id, 'PENDIENTE')).rejects.toMatchObject({ code: '42501' });
    const yo = await k.internalUser(d.usuarioId);
    await expect(insert(yo, ids.mio, 'DEVUELTO')).rejects.toMatchObject({ code: '42501' });
  });
});
