import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { offer } from './offers-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe.skipIf(!probe)('Estados públicos: PAUSADO, LLENO y menuAgotado', () => {
  const k = new DinerKit(probe!, 132);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  const vitrina = async (slug: string) => (await k.as({}).get(`/v1/restaurantes/${slug}`)).json();
  const pause = async (o: Local) => expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
  const lleno = async (o: Local, nivel = 'LLENO') => expect((await k.as(o).post('/v1/restaurante/lleno', { nivel })).statusCode).toBe(200);
  const order = (who: { token: string }, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/pedidos', body, key);
  const table = (who: { token: string }, restaurante: string, key = randomUUID()) =>
    k.as(who).post('/v1/mis/mesas', { restaurante, horaLlegada: inMinutes(30) }, key);

  /** Marca agotado un plato del menú de hoy por su nombre. */
  async function soldOut(o: Local, nombres: string[], agotado = true) {
    const hoy = (await k.as(o).get('/v1/menu/hoy')).json();
    for (const it of hoy.items.filter((i: { nombre: string }) => nombres.includes(i.nombre))) {
      const r = await k.as(o).patch(`/v1/menu/hoy/items/${it.id}/agotado`, { agotado });
      expect(r.statusCode, r.body).toBe(200);
    }
  }

  describe('1) vitrina: PAUSADO visible con estado', () => {
    it('lista y detalle traen estado; PAUSADO tiene abiertoAhora=false; BORRADOR y BAJA siguen ocultos', async () => {
      const activo = await k.activeOwner('Est Activo');
      const pausado = await k.activeOwner('Est Pausado');
      await pause(pausado);
      const borrador = await k.owner('Est Borrador');
      const baja = await k.activeOwner('Est Baja');
      await probe!.sql(`UPDATE restaurante SET estado = 'BAJA' WHERE public_id = $1`, [baja.restaurante]);
      const slugBorrador = (await k.as(borrador).get('/v1/restaurante')).json().slug;

      const list = (await k.as({}).get('/v1/restaurantes?q=Est%20&limit=50')).json().items as {
        id: string;
        estado: string;
        abiertoAhora: boolean;
      }[];
      const mine = (id: string) => list.find((i) => i.id === id);
      expect(mine(activo.restaurante)).toMatchObject({ estado: 'ACTIVO', abiertoAhora: true });
      expect(mine(pausado.restaurante)).toMatchObject({ estado: 'PAUSADO', abiertoAhora: false });
      expect(mine(borrador.restaurante)).toBeUndefined();
      expect(mine(baja.restaurante)).toBeUndefined();

      expect(await vitrina(activo.slug)).toMatchObject({ estado: 'ACTIVO', abiertoAhora: true });
      expect(await vitrina(pausado.slug)).toMatchObject({ estado: 'PAUSADO', abiertoAhora: false });
      expect((await k.as({}).get(`/v1/restaurantes/${slugBorrador}`)).statusCode).toBe(404);
      const slugBaja = (await k.as(baja).get('/v1/restaurante')).json().slug;
      expect((await k.as({}).get(`/v1/restaurantes/${slugBaja}`)).statusCode).toBe(404);
    });

    it('reactivar el local vuelve a ACTIVO y abiertoAhora', async () => {
      const o = await k.activeOwner();
      await pause(o);
      expect((await k.as(o).post('/v1/restaurante/activar')).statusCode).toBe(200);
      expect(await vitrina(o.slug)).toMatchObject({ estado: 'ACTIVO', abiertoAhora: true });
    });
  });

  describe('2) PAUSADO no admite órdenes nuevas', () => {
    it('preorden, mesa compartida nueva y canje de oferta → 409 RESTAURANTE_PAUSADO; BORRADOR sigue en 404', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      const ofertaId = (await k.as(o).post('/v1/ofertas', offer(), randomUUID())).json().id as string;
      await pause(o);

      const p = await order(d, { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } });
      expect(p.statusCode).toBe(409);
      expect(p.json().code).toBe('RESTAURANTE_PAUSADO');
      const t = await table(d, o.restaurante);
      expect(t.statusCode).toBe(409);
      expect(t.json().code).toBe('RESTAURANTE_PAUSADO');
      const c = await k.as(o).post(`/v1/ofertas/${ofertaId}/canjear`, { metodoPago: 'EFECTIVO' }, randomUUID());
      expect(c.statusCode).toBe(409);
      expect(c.json().code).toBe('RESTAURANTE_PAUSADO');
      expect((await k.as(o).get('/v1/ofertas')).json().items[0].stockRestante).toBe(5);

      const borrador = await k.owner();
      expect((await table(d, borrador.restaurante)).json().code).toBe('RESTAURANTE_NO_ENCONTRADO');
    });

    it('lo ya creado no se toca y la caja del personal sigue funcionando (canjear pedido, validar, reintento idempotente)', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.dinerWithPlan(o);
      const key = randomUUID();
      const pedido = (await order(d, { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } }, key)).json();
      const mesa = (await table(d, o.restaurante)).json();
      await pause(o);

      // Lo existente: se ve, se puede reintentar con la misma llave y la caja lo canjea.
      expect((await k.as(d).get(`/v1/mis/pedidos/${pedido.id}`)).json().estado).toBe('EN_CAMINO');
      expect((await order(d, { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } }, key)).json().id).toBe(pedido.id);
      expect((await k.as(d).get(`/v1/mis/mesas/${mesa.id}`)).statusCode).toBe(200);
      const canje = await k.as(o).post(`/v1/caja/pedidos/${pedido.id}/canjear`, {}, randomUUID());
      expect(canje.statusCode, canje.body).toBe(200);
      const v = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, randomUUID());
      expect(v.statusCode, v.body).toBe(200);
    });

    it('aislamiento: pausar un local no afecta a otro', async () => {
      const a = await k.activeOwner('Aislado A');
      const b = await k.activeOwner('Aislado B');
      const mb = await k.menu(b);
      const d = await k.diner();
      await pause(a);
      const r = await order(d, { restaurante: b.restaurante, almuerzo: { platos: [mb['Seco de pollo']] } });
      expect(r.statusCode, r.body).toBe(201);
      expect((await table(d, b.restaurante)).statusCode).toBe(201);
      expect(await vitrina(b.slug)).toMatchObject({ estado: 'ACTIVO' });
    });
  });

  describe('3) LLENO: solo para llevar', () => {
    it('manual: AQUI → 409 LOCAL_LLENO_SOLO_LLEVAR; LLEVAR pasa sin cambiar precios ni recargo', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      await lleno(o);
      const body = { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } };
      const aqui = await order(d, body);
      expect(aqui.statusCode).toBe(409);
      expect(aqui.json().code).toBe('LOCAL_LLENO_SOLO_LLEVAR');
      const extrasAqui = await order(d, { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] });
      expect(extrasAqui.json().code).toBe('LOCAL_LLENO_SOLO_LLEVAR');
      const llevar = await order(d, { ...body, paraLlevar: true });
      expect(llevar.statusCode, llevar.body).toBe(201);
      expect(llevar.json()).toMatchObject({ paraLlevar: true, recargoLlevarCentavos: 25, totalCentavos: 375 });
    });

    it('por aforo (≥90%) se comporta igual que el manual; CONCURRIDO (MODERADO) admite AQUI', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      await probe!.sql(`UPDATE restaurante SET puestos = 10 WHERE public_id = $1`, [o.restaurante]);
      const body = { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } };
      await lleno(o, 'CONCURRIDO');
      expect((await vitrina(o.slug)).ocupacion.nivel).toBe('MODERADO');
      expect((await order(d, body)).statusCode).toBe(201);

      for (let t = 1; t <= 9; t++)
        await probe!.sql(
          `INSERT INTO venta_pos_cabecera (restaurante_id, fecha_local, ticket, total_centavos, moneda_codigo, personal_id, clave_idempotencia, creado_en)
           SELECT r.restaurante_id, CURRENT_DATE, $2, 350, 'USD', p.personal_id, $3, now()
             FROM restaurante r JOIN personal_restaurante p ON p.restaurante_id = r.restaurante_id WHERE r.public_id = $1`,
          [o.restaurante, t, randomUUID()],
        );
      expect((await vitrina(o.slug)).ocupacion).toMatchObject({ nivel: 'LLENO', porcentaje: 90 });
      const d2 = await k.diner();
      const aqui = await order(d2, body);
      expect(aqui.statusCode).toBe(409);
      expect(aqui.json().code).toBe('LOCAL_LLENO_SOLO_LLEVAR');
      expect((await order(d2, { ...body, paraLlevar: true })).statusCode).toBe(201);
    });

    it('no afecta a caja, QR/validar ni planes; el LLENO de otro local no cuenta', async () => {
      const a = await k.activeOwner('Lleno A');
      const b = await k.activeOwner('Lleno B');
      const mb = await k.menu(b);
      await k.menu(a);
      const d = await k.dinerWithPlan(a);
      await lleno(a);
      const v = await k.as(a).post('/v1/caja/validar', { clienteId: d.clienteId }, randomUUID());
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json().descontado).toBe(true);
      await k.plan(a, { nombre: 'Otro plan' });
      expect((await k.as(a).get('/v1/planes')).statusCode).toBe(200);
      const x = await k.diner();
      expect((await order(x, { restaurante: b.restaurante, almuerzo: { platos: [mb['Seco de pollo']] } })).statusCode).toBe(201);
    });
  });

  describe('4) menuAgotado', () => {
    it('false sin menú publicado; false con platos disponibles; true solo con TODAS las sopas y segundos agotados', async () => {
      const o = await k.activeOwner();
      expect((await vitrina(o.slug)).menuAgotado).toBe(false);
      expect((await k.as(o).get('/v1/restaurante')).json().menuAgotado).toBe(false);

      await k.menu(o); // 1 sopa, 2 fuertes, jugo y extras
      const all = async () => [
        (await vitrina(o.slug)).menuAgotado,
        (await k.as({}).get('/v1/restaurantes?q=' + encodeURIComponent((await k.as(o).get('/v1/restaurante')).json().nombre))).json()
          .items[0].menuAgotado,
        (await k.as(o).get('/v1/restaurante')).json().menuAgotado,
      ];
      expect(await all()).toEqual([false, false, false]);

      await soldOut(o, ['Sopa de quinua', 'Seco de pollo']);
      expect(await all()).toEqual([false, false, false]); // falta un segundo
      await soldOut(o, ['Menestra con carne']);
      expect(await all()).toEqual([true, true, true]);
      await soldOut(o, ['Menestra con carne'], false);
      expect(await all()).toEqual([false, false, false]);
    });

    it('jugo, postre y extras agotados no cuentan; despublicar el menú vuelve a false; aislamiento entre locales', async () => {
      const o = await k.activeOwner('Agotado A');
      const otro = await k.activeOwner('Agotado B');
      await k.menu(o);
      await k.menu(otro);
      await soldOut(o, ['Jugo de mora', 'Cola', 'Huevo frito']);
      expect((await vitrina(o.slug)).menuAgotado).toBe(false);
      await soldOut(o, ['Sopa de quinua', 'Seco de pollo', 'Menestra con carne']);
      expect((await vitrina(o.slug)).menuAgotado).toBe(true);
      expect((await vitrina(otro.slug)).menuAgotado).toBe(false);
      expect((await k.as(otro).get('/v1/restaurante')).json().menuAgotado).toBe(false);
      expect((await k.as(o).post('/v1/menu/hoy/despublicar')).statusCode).toBe(200);
      expect((await vitrina(o.slug)).menuAgotado).toBe(false);
    });
  });
});
