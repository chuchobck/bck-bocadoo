import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: historial de almuerzos', () => {
  const k = new DinerKit(probe!, 82);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  it('lista mis almuerzos de todos los locales, del más reciente al más antiguo, con cursor', async () => {
    const a = await k.owner('Historial A');
    const b = await k.owner('Historial B');
    const d = await k.dinerWithPlan(a);
    const db = await k.dinerWithPlan(b, {}, d);
    const c1 = await k.lunch(a, d.clienteId);
    await k.backdateLunch(c1, 120); // fuera de la regla de doble escaneo (60 s)
    const c2 = await k.lunch(a, d.clienteId);
    await k.backdateLunch(c2, 60 * 24);
    await k.backdateLunch(c1, 60 * 24); // c1 sigue siendo el más antiguo
    const c3 = await k.lunch(b, db.clienteId);

    const all = (await k.as(d).get('/v1/mis/consumos')).json();
    expect(all.items.map((i: { id: string }) => i.id)).toEqual([c3, c2, c1]);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]).toMatchObject({
      restaurante: { id: b.restaurante, nombre: 'Historial B' },
      plan: { nombre: 'Semanal' },
      canal: 'MANUAL',
      paraLlevar: false,
      revertido: false,
      revertidoEn: null,
    });
    expectOnlyPublicIds(all);

    // De a uno: el cursor recorre todo sin repetir ni saltar.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await k.as(d).get(`/v1/mis/consumos?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...page.items.map((i: { id: string }) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([c3, c2, c1]);

    const soloA = (await k.as(d).get(`/v1/mis/consumos?restaurante=${a.restaurante}`)).json();
    expect(soloA.items.map((i: { id: string }) => i.id)).toEqual([c2, c1]);
    expect((await k.as(d).get(`/v1/mis/consumos/${c2}`)).json()).toMatchObject({ id: c2, fechaLocal: expect.any(String) });
  });

  it('un almuerzo deshecho en caja sale una sola vez, marcado como revertido', async () => {
    const a = await k.owner();
    const d = await k.dinerWithPlan(a);
    const c = await k.lunch(a, d.clienteId);
    expect((await k.as(a).post(`/v1/caja/consumos/${c}/deshacer`)).statusCode).toBe(200);
    const items = (await k.as(d).get('/v1/mis/consumos')).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: c, revertido: true, revertidoEn: expect.any(String) });
  });

  it('otro comensal no ve mis almuerzos: ni por la API (404) ni por RLS', async () => {
    const a = await k.owner();
    const d = await k.dinerWithPlan(a);
    const c = await k.lunch(a, d.clienteId);
    const otro = await k.dinerWithPlan(a);
    expect((await k.as(otro).get('/v1/mis/consumos')).json().items).toEqual([]);
    const nf = await k.as(otro).get(`/v1/mis/consumos/${c}`);
    expect(nf.statusCode).toBe(404);
    expect(nf.json().code).toBe('CONSUMO_NO_ENCONTRADO');
    const uid = await k.internalUser(otro.usuarioId);
    expect(await k.rls({ userId: uid }, 'SELECT public_id FROM consumo_almuerzo')).toEqual([]);
    expect(await k.rls({ userId: await k.internalUser(d.usuarioId) }, 'SELECT public_id FROM consumo_almuerzo')).toEqual([
      { public_id: c },
    ]);
  });

  it('validación de entrada: cursor alterado → 400 CURSOR_INVALIDO; limit fuera de rango → 400; sin token → 401', async () => {
    const d = await k.diner();
    expect((await k.as(d).get('/v1/mis/consumos?cursor=abc')).json()).toMatchObject({ status: 400, code: 'CURSOR_INVALIDO' });
    expect((await k.as(d).get('/v1/mis/consumos?limit=51')).statusCode).toBe(400);
    expect((await k.as(d).get('/v1/mis/consumos?extra=1')).statusCode).toBe(400);
    expect((await k.as(d).get(`/v1/mis/consumos/${randomUUID()}`)).statusCode).toBe(404);
    expect((await k.as({}).get('/v1/mis/consumos')).statusCode).toBe(401);
  });
});
