import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: pase del comensal', () => {
  const k = new DinerKit(probe!, 81);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  it('probe: lo escrito en una prueba no queda en la base', async () => {
    const d = await k.diner();
    expect((await probe!.sql('SELECT 1 FROM usuario WHERE public_id = $1', [d.usuarioId])).rowCount).toBe(1);
    await probe!.rollback();
    await probe!.begin();
    expect((await probe!.sql('SELECT 1 FROM usuario WHERE public_id = $1', [d.usuarioId])).rowCount).toBe(0);
  });

  it('probe: cada transacción toma el rol real de su pool', async () => {
    const roles = await Promise.all([
      k.h.db.scope({}, async (q) => (await q.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u),
      k.h.db.service(async (q) => (await q.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u),
    ]);
    expect(roles).toEqual(['bck_api', 'bck_servicio']);
    // Solo lectura de verdad: escribir falla con 25006.
    await expect(k.h.db.scope({ readOnly: true }, (q) => q.query(`INSERT INTO lead_landing (nombre) VALUES ('x')`))).rejects.toMatchObject({
      code: '25006',
    });
  });

  it('GET /v1/pase: código rotativo y planes vigentes por local, en orden FIFO', async () => {
    const a = await k.owner('Pase A');
    const b = await k.owner('Pase B');
    const d = await k.dinerWithPlan(a);
    await k.dinerWithPlan(b, { nombre: 'Quincenal', almuerzos: 10, vigenciaDias: 15 }, d);
    // Segundo plan en A: vence después, así que va segundo.
    const c = d.clienteId;
    await k
      .as(a)
      .post(
        `/v1/clientes/${c}/planes`,
        { planId: await k.plan(a, { nombre: 'Mensual', almuerzos: 20, vigenciaDias: 30 }), metodoPago: 'EFECTIVO' },
        randomUUID(),
      );
    await k.lunch(a, c);

    const r = await k.as(d).get('/v1/pase');
    expect(r.statusCode).toBe(200);
    const pase = r.json();
    expect(pase.usuario).toEqual({ id: d.usuarioId, nombre: 'Comensal Prueba' });
    expect(pase.codigo).toMatchObject({ validoSegundos: 30 });
    expect(pase.codigo.codigo).toMatch(new RegExp(`^BCD1\\.${d.usuarioId}\\.0\\.`));
    expect(new Date(pase.codigo.expiraEn).getTime()).toBeGreaterThan(Date.now());
    expect(pase.locales).toHaveLength(2);
    const la = pase.locales.find((l: { restaurante: { id: string } }) => l.restaurante.id === a.restaurante);
    expect(la.almuerzosDisponibles).toBe(4 + 20);
    expect(la.planes.map((p: { nombre: string }) => p.nombre)).toEqual(['Semanal', 'Mensual']);
    expect(la.planes[0]).toMatchObject({ almuerzosRestantes: 4, almuerzosTotales: 5, diasParaVencer: 6, valeHoy: true });
    // Nunca ids internos: los planes salen con public_id (UUID) y no hay cliente_id.
    expectOnlyPublicIds(pase);

    // El código del pase sirve en caja (en B: en A acaba de almorzar y sería DUPLICADO).
    const v = await k.as(b).post('/v1/caja/validar', { codigoQr: pase.codigo.codigo }, randomUUID());
    expect(v.json()).toMatchObject({ resultado: 'OK', almuerzosRestantes: 9 });
  });

  it('con ?restaurante el código solo vale ahí; restaurante inexistente → 404 RESTAURANTE_NO_ENCONTRADO', async () => {
    const a = await k.owner();
    const b = await k.owner();
    const d = await k.dinerWithPlan(a);
    const pase = (await k.as(d).get(`/v1/pase?restaurante=${a.restaurante}`)).json();
    expect(pase.codigo.codigo).toContain(`.${a.restaurante}.`);
    expect((await k.as(b).post('/v1/caja/validar', { codigoQr: pase.codigo.codigo }, randomUUID())).json().resultado).toBe('OTRO_LOCAL');

    const nf = await k.as(d).get(`/v1/pase?restaurante=${randomUUID()}`);
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['content-type']).toContain('application/problem+json');
    expect(nf.json()).toMatchObject({ status: 404, code: 'RESTAURANTE_NO_ENCONTRADO' });
    expect((await k.as(d).get('/v1/pase?restaurante=no-uuid')).json()).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  });

  it('sin token → 401; otro comensal no ve los planes ajenos (API y RLS)', async () => {
    const a = await k.owner();
    const d = await k.dinerWithPlan(a);
    const otro = await k.diner();
    expect((await k.as({}).get('/v1/pase')).statusCode).toBe(401);
    expect((await k.as(otro).get('/v1/pase')).json().locales).toEqual([]);
    // RLS: como el otro comensal, sin filtros de la API, no aparece ningún plan ni ficha de cliente ajena.
    const uid = await k.internalUser(otro.usuarioId);
    expect(await k.rls({ userId: uid }, 'SELECT * FROM suscripcion_plan')).toEqual([]);
    expect(await k.rls({ userId: uid }, 'SELECT * FROM cliente_restaurante')).toEqual([]);
    const own = await k.rls({ userId: await k.internalUser(d.usuarioId) }, 'SELECT estado FROM suscripcion_plan');
    expect(own).toHaveLength(1);
  });
});
