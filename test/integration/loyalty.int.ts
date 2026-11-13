import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: tarjeta de sellos', () => {
  const k = new DinerKit(probe!, 89);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const config = (o: { token: string; restaurante: string }, body: object = {}) =>
    k.as(o).put('/v1/sellos/config', { activa: true, meta: 3, premio: 'Un almuerzo gratis', nombre: 'Tarjeta', ...body });
  /** N almuerzos seguidos (cada uno movido 2 minutos atrás para no caer en la regla de doble escaneo). */
  async function lunches(o: Parameters<DinerKit['lunch']>[0], clienteId: string, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = await k.lunch(o, clienteId);
      await k.backdateLunch(c, 2 * (n - i));
      ids.push(c);
    }
    return ids;
  }
  const card = (o: { token: string; restaurante: string }, c: string) => k.as(o).get(`/v1/clientes/${c}/sellos`);

  it('el dueño configura la tarjeta; cada almuerzo validado suma un sello y al llegar a la meta se gana un premio', async () => {
    const o = await k.owner('Sellos Local');
    expect((await k.as(o).get('/v1/sellos/config')).json()).toMatchObject({ status: 404, code: 'TARJETA_NO_CONFIGURADA' });
    const cfg = await config(o);
    expect(cfg.statusCode, cfg.body).toBe(200);
    expect(cfg.json()).toEqual({ activa: true, meta: 3, premio: 'Un almuerzo gratis', nombre: 'Tarjeta', cuenta: 'ALMUERZO' });
    const d = await k.dinerWithPlan(o);
    expect((await k.as(d).get('/v1/mis/sellos')).json()).toEqual([
      expect.objectContaining({ restaurante: expect.objectContaining({ id: o.restaurante }), sellos: 0, faltan: 3, premiosDisponibles: 0 }),
    ]);
    await lunches(o, d.clienteId, 2);
    expect((await card(o, d.clienteId)).json()).toMatchObject({ sellos: 2, faltan: 1, premiosDisponibles: 0 });
    await lunches(o, d.clienteId, 2);
    expect((await card(o, d.clienteId)).json()).toMatchObject({
      sellos: 1,
      faltan: 2,
      premiosDisponibles: 1,
      premio: 'Un almuerzo gratis',
    });
    const mine = (await k.as(d).get('/v1/mis/sellos')).json();
    expect(mine[0]).toMatchObject({ sellos: 1, premiosDisponibles: 1, activa: true });
    expectOnlyPublicIds(mine);
    // El libro: un GANADO por almuerzo.
    const mov = await probe!.sql<{ tipo: string; n: number }>(
      `SELECT m.tipo, count(*)::int AS n FROM movimiento_sello m JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1 GROUP BY 1`,
      [o.restaurante],
    );
    expect(mov.rows).toEqual([{ tipo: 'GANADO', n: 4 }]);
  });

  it('un almuerzo devuelto quita su sello (y deshace el premio que había completado); reintentos no suman dos veces', async () => {
    const o = await k.owner();
    await config(o);
    const d = await k.dinerWithPlan(o);
    const [, , third] = await lunches(o, d.clienteId, 3);
    expect((await card(o, d.clienteId)).json()).toMatchObject({ sellos: 0, premiosDisponibles: 1 });
    // El tercero completó el premio; al deshacerlo vuelve a 2 sellos y 0 premios.
    const reclamo = await k.as(d).post(`/v1/mis/consumos/${third}/reclamo`, { mensaje: 'Este no lo consumí, fue un error.' }, randomUUID());
    expect(reclamo.statusCode).toBe(201);
    const id = (await k.as(o).get('/v1/reclamos')).json()[0].id;
    await k.as(o).post(`/v1/reclamos/${id}/devolver`, {});
    expect((await card(o, d.clienteId)).json()).toMatchObject({ sellos: 2, premiosDisponibles: 0 });

    // Misma Idempotency-Key en caja → mismo consumo → un solo sello.
    const key = randomUUID();
    const a = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, key);
    const b = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, key);
    expect(a.json().consumo.id).toBe(b.json().consumo.id);
    expect((await card(o, d.clienteId)).json()).toMatchObject({ sellos: 0, premiosDisponibles: 1 });
  });

  it('canjear un premio en caja: una vez por clave, sin premios → 409; tarjeta apagada no suma pero deja canjear lo ganado', async () => {
    const o = await k.owner();
    await config(o, { meta: 2 });
    const d = await k.dinerWithPlan(o);
    const cashier = await k.h.cashier(o.restaurante);
    await lunches(o, d.clienteId, 2);
    const key = randomUUID();
    const r = await k.as(cashier).post(`/v1/clientes/${d.clienteId}/sellos/canjear`, {}, key);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ premiosDisponibles: 0, yaCanjeado: false });
    expect((await k.as(cashier).post(`/v1/clientes/${d.clienteId}/sellos/canjear`, {}, key)).json()).toMatchObject({ yaCanjeado: true });
    expect((await k.as(cashier).post(`/v1/clientes/${d.clienteId}/sellos/canjear`, {}, randomUUID())).json()).toMatchObject({
      status: 409,
      code: 'SIN_PREMIOS',
    });

    await lunches(o, d.clienteId, 2);
    await config(o, { meta: 2, activa: false });
    await lunches(o, d.clienteId, 1);
    expect((await card(o, d.clienteId)).json()).toMatchObject({ sellos: 0, premiosDisponibles: 1, activa: false });
    expect((await k.as(d).get('/v1/mis/sellos')).json()).toHaveLength(1); // apagada pero con premio
    expect((await k.as(o).post(`/v1/clientes/${d.clienteId}/sellos/canjear`, {}, randomUUID())).json().premiosDisponibles).toBe(0);
    expect((await k.as(d).get('/v1/mis/sellos')).json()).toEqual([]);
  });

  it('permisos y aislamiento: el cajero no configura; otro local no ve la tarjeta; otro comensal no ve mis sellos (API y RLS)', async () => {
    const o = await k.owner();
    await config(o);
    const d = await k.dinerWithPlan(o);
    await lunches(o, d.clienteId, 1);
    const cashier = await k.h.cashier(o.restaurante);
    expect((await config(cashier)).statusCode).toBe(403);
    expect((await k.as(cashier).get('/v1/sellos/config')).statusCode).toBe(200);
    expect((await config(o, { meta: 1 })).statusCode).toBe(400);
    expect((await config(o, { cuenta: 'PLATO' })).statusCode).toBe(400);
    const otro = await k.owner();
    expect((await card(otro, d.clienteId)).json()).toMatchObject({ status: 404, code: 'CLIENTE_NO_ENCONTRADO' });
    expect((await k.as(otro).post(`/v1/clientes/${d.clienteId}/sellos/canjear`, {}, randomUUID())).statusCode).toBe(404);
    const ajeno = await k.diner();
    expect((await k.as(ajeno).get('/v1/mis/sellos')).json()).toEqual([]);
    const uid = await k.internalUser(ajeno.usuarioId);
    expect(await k.rls({ userId: uid }, 'SELECT sellos FROM tarjeta_sellos_cliente')).toEqual([]);
    expect(await k.rls({ userId: uid }, 'SELECT movimiento_sello_id FROM movimiento_sello')).toEqual([]);
    expect(await k.rls({ userId: await k.internalUser(d.usuarioId) }, 'SELECT sellos FROM tarjeta_sellos_cliente')).toEqual([
      { sellos: 1 },
    ]);
  });
});
