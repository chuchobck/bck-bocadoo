import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: opiniones del comensal', () => {
  const k = new DinerKit(probe!, 86);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const opine = (who: { token: string }, consumo: string, body: object, key = randomUUID()) =>
    k.as(who).post(`/v1/mis/consumos/${consumo}/opinion`, body, key);
  const dismiss = (who: { token: string }, consumo: string, key = randomUUID()) =>
    k.as(who).post(`/v1/mis/consumos/${consumo}/opinion/descartar`, {}, key);

  /** Comensal con un almuerzo validado hace `minutes` minutos. */
  async function lunchAgo(minutes: number) {
    const o = await k.owner('Opiniones Local');
    const d = await k.dinerWithPlan(o);
    const c = await k.lunch(o, d.clienteId);
    if (minutes) await k.backdateLunch(c, minutes);
    return { o, d, c };
  }

  it('la tarjeta aparece a los 25 minutos y caduca a las 24 horas', async () => {
    const { d, c } = await lunchAgo(0);
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    expect((await opine(d, c, { etiquetas: ['RICO'] })).json()).toMatchObject({ status: 409, code: 'OPINION_AUN_NO_DISPONIBLE' });
    await k.backdateLunch(c, 24);
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    await k.backdateLunch(c, 1); // 25 minutos
    const p = (await k.as(d).get('/v1/mis/opiniones/pendientes')).json();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ consumo: { id: c }, etiquetasDisponibles: expect.arrayContaining(['RICO', 'FRIO']) });
    expect(new Date(p[0].expiraEn).getTime() - new Date(p[0].consumo.fecha).getTime()).toBe(24 * 3_600_000);
    expectOnlyPublicIds(p);
    await k.backdateLunch(c, 24 * 60 - 25); // 24 horas justas
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    expect((await opine(d, c, { etiquetas: ['RICO'] })).json()).toMatchObject({ status: 409, code: 'OPINION_VENCIDA' });
    expect((await dismiss(d, c)).json()).toMatchObject({ status: 409, code: 'OPINION_VENCIDA' });
  });

  it('opinar: etiquetas cerradas y comentario privado, una sola vez por almuerzo (misma clave → la misma)', async () => {
    const { d, c } = await lunchAgo(30);
    const key = randomUUID();
    const r = await opine(d, c, { etiquetas: ['RICO', 'BUENA_PORCION'], comentario: '  La sopa, excelente.  ' }, key);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      consumo: { id: c },
      etiquetas: ['RICO', 'BUENA_PORCION'],
      comentario: 'La sopa, excelente.',
      descartada: false,
      respuesta: null,
    });
    expect((await opine(d, c, { etiquetas: ['RICO', 'BUENA_PORCION'] }, key)).json()).toEqual(r.json());
    expect((await opine(d, c, { etiquetas: ['FRIO'] })).json()).toMatchObject({ status: 409, code: 'OPINION_YA_ENVIADA' });
    expect((await dismiss(d, c)).json()).toMatchObject({ status: 409, code: 'OPINION_YA_ENVIADA' });
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    expect((await k.as(d).get('/v1/mis/opiniones')).json()).toEqual([r.json()]);
    const n = await probe!.sql(
      'SELECT count(*)::int AS n FROM opinion o JOIN consumo_almuerzo k USING (consumo_id) WHERE k.public_id = $1',
      [c],
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it('descartar cierra la tarjeta y cuenta como su única opinión; validación de entrada', async () => {
    const { d, c } = await lunchAgo(30);
    expect((await opine(d, c, {})).json()).toMatchObject({ status: 400, code: 'OPINION_VACIA' });
    expect((await opine(d, c, { etiquetas: ['DELICIOSO'] })).statusCode).toBe(400);
    expect((await opine(d, c, { etiquetas: ['RICO', 'RICO'] })).statusCode).toBe(400);
    expect((await opine(d, c, { etiquetas: ['RICO'], estrellas: 5 })).statusCode).toBe(400);
    expect((await opine(d, c, { comentario: 'x'.repeat(501) })).statusCode).toBe(400);
    const r = await dismiss(d, c);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ descartada: true, etiquetas: [], comentario: null });
    expect((await opine(d, c, { etiquetas: ['RICO'] })).json().code).toBe('OPINION_YA_ENVIADA');
    expect((await k.as(d).get('/v1/mis/opiniones')).json()).toEqual([]);
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
  });

  it('almuerzo revertido → 409 CONSUMO_REVERTIDO y no aparece como pendiente', async () => {
    const { o, d, c } = await lunchAgo(0);
    await k.as(o).post(`/v1/caja/consumos/${c}/deshacer`);
    await k.backdateLunch(c, 30);
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    expect((await opine(d, c, { etiquetas: ['RICO'] })).json()).toMatchObject({ status: 409, code: 'CONSUMO_REVERTIDO' });
  });

  it('solo sobre almuerzos propios: la API responde 404 y RLS rechaza la opinión sobre un almuerzo ajeno', async () => {
    const { o, d, c } = await lunchAgo(30);
    const otro = await k.dinerWithPlan(o);
    expect((await opine(otro, c, { etiquetas: ['FRIO'] })).json()).toMatchObject({ status: 404, code: 'CONSUMO_NO_ENCONTRADO' });
    expect((await dismiss(otro, c)).statusCode).toBe(404);
    await opine(d, c, { comentario: 'Todo bien' });
    expect((await k.as(otro).get('/v1/mis/opiniones')).json()).toEqual([]);

    expect(await k.rls({ userId: await k.internalUser(otro.usuarioId) }, 'SELECT opinion_id FROM opinion')).toEqual([]);
    // Con su propia ficha de cliente pero el almuerzo de otra persona → RLS (comensal_crea) lo rechaza.
    const second = await lunchAgo(30);
    const theirs = (await probe!.sql<{ consumo_id: string }>('SELECT consumo_id FROM consumo_almuerzo WHERE public_id = $1', [second.c]))
      .rows[0]!;
    const own = (
      await probe!.sql<{ restaurante_id: string; cliente_id: string; usuario_id: string }>(
        `SELECT c.restaurante_id, c.cliente_id, c.usuario_id FROM cliente_restaurante c JOIN usuario u USING (usuario_id) WHERE u.public_id = $1`,
        [second.d.usuarioId],
      )
    ).rows[0]!;
    const intruso = await k.dinerWithPlan(second.o);
    const intrusoIds = (
      await probe!.sql<{ cliente_id: string; usuario_id: string }>(
        `SELECT c.cliente_id, c.usuario_id FROM cliente_restaurante c JOIN usuario u USING (usuario_id) WHERE u.public_id = $1`,
        [intruso.usuarioId],
      )
    ).rows[0]!;
    await expect(
      k.rls(
        { userId: intrusoIds.usuario_id },
        'INSERT INTO opinion (restaurante_id, consumo_id, cliente_id, etiquetas) VALUES ($1, $2, $3, $4)',
        [own.restaurante_id, theirs.consumo_id, intrusoIds.cliente_id, ['FRIO']],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Ni puede escribir de antemano la respuesta del restaurante en su propia opinión.
    await expect(
      k.rls(
        { userId: own.usuario_id },
        `INSERT INTO opinion (restaurante_id, consumo_id, cliente_id, respuesta_restaurante, respondido_en) VALUES ($1, $2, $3, 'Gracias', CURRENT_TIMESTAMP)`,
        [own.restaurante_id, theirs.consumo_id, own.cliente_id],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
