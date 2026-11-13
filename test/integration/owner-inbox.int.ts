import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: bandeja de opiniones del dueño', () => {
  const k = new DinerKit(probe!, 87);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  /** Local con tres almuerzos de hace 30 min: dos opinados y uno descartado. */
  async function setup() {
    const o = await k.owner('Bandeja Local');
    const out: { d: Awaited<ReturnType<DinerKit['dinerWithPlan']>>; c: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await k.dinerWithPlan(o);
      const c = await k.lunch(o, d.clienteId);
      await k.backdateLunch(c, 30);
      out.push({ d, c });
    }
    const [a, b, x] = out as [(typeof out)[0], (typeof out)[0], (typeof out)[0]];
    await k.as(a.d).post(`/v1/mis/consumos/${a.c}/opinion`, { etiquetas: ['RICO', 'BUENA_PORCION'] }, randomUUID());
    await k
      .as(b.d)
      .post(`/v1/mis/consumos/${b.c}/opinion`, { etiquetas: ['FRIO', 'RICO'], comentario: 'La sopa llegó tibia' }, randomUUID());
    await k.as(x.d).post(`/v1/mis/consumos/${x.c}/opinion/descartar`, {}, randomUUID());
    return { o, a, b, x };
  }

  it('el dueño ve las opiniones (sin descartes) con resumen por etiqueta y paginación', async () => {
    const { o, a, b } = await setup();
    const r = await k.as(o).get('/v1/opiniones');
    expect(r.statusCode).toBe(200);
    const inbox = r.json();
    expect(inbox.items.map((i: { id: string }) => i.id).sort()).toEqual([a.c, b.c].sort());
    expect(inbox.items.find((i: { id: string }) => i.id === b.c)).toMatchObject({
      cliente: { nombre: expect.stringMatching(/^Cliente /) },
      plan: { nombre: 'Semanal' },
      etiquetas: ['FRIO', 'RICO'],
      comentario: 'La sopa llegó tibia',
      respuesta: null,
    });
    expect(inbox.resumen).toEqual({ total: 2, sinResponder: 2, conComentario: 1, etiquetas: { RICO: 2, FRIO: 1, BUENA_PORCION: 1 } });
    expectOnlyPublicIds(inbox);
    const p1 = (await k.as(o).get('/v1/opiniones?limit=1')).json();
    const p2 = (await k.as(o).get(`/v1/opiniones?limit=1&cursor=${p1.nextCursor}`)).json();
    expect([...p1.items, ...p2.items].map((i: { id: string }) => i.id).sort()).toEqual([a.c, b.c].sort());
    expect(p2.nextCursor).toBeNull();
  });

  it('responder: el comensal ve la respuesta; una por opinión; filtros SIN_RESPONDER / RESPONDIDAS', async () => {
    const { o, b, x } = await setup();
    const texto = 'Gracias por avisar, mañana sale bien caliente.';
    const r = await k.as(o).post(`/v1/opiniones/${b.c}/responder`, { respuesta: texto });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id: b.c, respuesta: { texto, respondidoEn: expect.any(String) } });
    expect((await k.as(o).post(`/v1/opiniones/${b.c}/responder`, { respuesta: texto })).statusCode).toBe(200);
    expect((await k.as(o).post(`/v1/opiniones/${b.c}/responder`, { respuesta: 'Otra' })).json()).toMatchObject({
      status: 409,
      code: 'OPINION_YA_RESPONDIDA',
    });
    expect((await k.as(b.d).get('/v1/mis/opiniones')).json()[0]).toMatchObject({ consumo: { id: b.c }, respuesta: { texto } });
    expect((await k.as(o).get('/v1/opiniones?estado=RESPONDIDAS')).json().items.map((i: { id: string }) => i.id)).toEqual([b.c]);
    expect((await k.as(o).get('/v1/opiniones?estado=SIN_RESPONDER')).json().items).toHaveLength(1);
    // Un descarte no se puede responder.
    expect((await k.as(o).post(`/v1/opiniones/${x.c}/responder`, { respuesta: 'Hola' })).json()).toMatchObject({
      status: 404,
      code: 'OPINION_NO_ENCONTRADA',
    });
    expect((await k.as(o).post(`/v1/opiniones/${b.c}/responder`, { respuesta: '' })).statusCode).toBe(400);
  });

  it('solo el dueño del local: cajero → 403, otro local → nada (guard + RLS); no puede editar lo que escribió el comensal', async () => {
    const { o, a } = await setup();
    const cashier = await k.h.cashier(o.restaurante);
    expect((await k.as(cashier).get('/v1/opiniones')).statusCode).toBe(403);
    expect((await k.as(cashier).post(`/v1/opiniones/${a.c}/responder`, { respuesta: 'x' })).statusCode).toBe(403);
    const otro = await k.owner();
    expect((await k.as(otro).get('/v1/opiniones')).json().items).toEqual([]);
    expect((await k.as(otro).post(`/v1/opiniones/${a.c}/responder`, { respuesta: 'x' })).statusCode).toBe(404);
    expect((await k.as(a.d).get('/v1/opiniones')).statusCode).toBe(400); // comensal sin x-restaurant-id

    const tid = String(
      (await probe!.sql('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [o.restaurante])).rows[0]!.restaurante_id,
    );
    const otherTid = String(
      (await probe!.sql('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [otro.restaurante])).rows[0]!.restaurante_id,
    );
    expect(await k.rls({ tenantId: otherTid }, 'SELECT opinion_id FROM opinion')).toEqual([]);
    await expect(k.rls({ tenantId: tid }, `UPDATE opinion SET etiquetas = '{RICO}', comentario_privado = NULL`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});
