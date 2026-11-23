import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: preórdenes del comensal', () => {
  const k = new DinerKit(probe!, 83);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const order = (who: { token: string }, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/pedidos', body, key);

  it('con plan: el almuerzo sale cubierto (0), los extras con precio del servidor, recargo para llevar y vence en 30 min', async () => {
    const o = await k.activeOwner('Pedidos Local');
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const r = await order(d, {
      restaurante: o.restaurante,
      paraLlevar: true,
      almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo'], m['Jugo de mora']] },
      extras: [{ plato: m['Huevo frito'], cantidad: 2 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json();
    expect(p).toMatchObject({
      numero: 1,
      estado: 'EN_CAMINO',
      paraLlevar: true,
      restaurante: { id: o.restaurante },
      almuerzo: { precioCentavos: 0, cubiertoPorPlan: true },
      extras: [{ id: m['Huevo frito'], nombre: 'Huevo frito', cantidad: 2, precioUnitarioCentavos: 75, subtotalCentavos: 150 }],
      recargoLlevarCentavos: 25,
      totalCentavos: 175,
      canjeadoEn: null,
    });
    expect(p.qr).toBe(p.id);
    expect(p.almuerzo.platos.map((x: { seccion: string }) => x.seccion).sort()).toEqual(['FUERTE', 'JUGO', 'SOPA']);
    expect(new Date(p.venceEn).getTime() - new Date(p.creadoEn).getTime()).toBe(30 * 60_000);
    expectOnlyPublicIds(p);
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json()).toEqual(p);
    expect((await k.as(d).get('/v1/mis/pedidos')).json().items).toEqual([p]);
  });

  it('sin plan: el almuerzo cuesta el precio suelto del local; la numeración del día es por local', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const a = await k.diner();
    const b = await k.diner();
    const pa = (await order(a, { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } })).json();
    expect(pa).toMatchObject({
      numero: 1,
      almuerzo: { precioCentavos: 350, cubiertoPorPlan: false },
      recargoLlevarCentavos: 0,
      totalCentavos: 350,
    });
    const pb = (await order(b, { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] })).json();
    expect(pb).toMatchObject({ numero: 2, almuerzo: null, totalCentavos: 100 });
  });

  it('Idempotency-Key: misma clave → el mismo pedido; con otro local → 409; sin clave → 400; un pedido en camino por local', async () => {
    const o = await k.activeOwner();
    const o2 = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.diner();
    const body = { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } };
    const key = randomUUID();
    const [r1, r2] = await Promise.all([order(d, body, key), order(d, body, key)]);
    expect(r1.json().id).toBe(r2.json().id);
    expect((await order(d, body, key)).json().id).toBe(r1.json().id);
    expect((await order(d, { ...body, restaurante: o2.restaurante }, key)).json()).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUTILIZADA',
    });
    const noKey = await k.as(d).post('/v1/mis/pedidos', body);
    expect(noKey.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_INVALIDA' });
    expect((await order(d, body)).json()).toMatchObject({ status: 409, code: 'PEDIDO_ACTIVO' });
    const n = await probe!.sql('SELECT count(*)::int AS n FROM orden_cabecera o JOIN usuario u USING (usuario_id) WHERE u.public_id = $1', [
      d.usuarioId,
    ]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('reglas del menú: vacío, dos fuertes, plato sin precio como extra, plato ajeno, agotado, menú sin publicar, local inactivo, campos extra', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.diner();
    const R = o.restaurante;
    const code = async (body: object) => (await order(d, body)).json();
    expect(await code({ restaurante: R })).toMatchObject({ status: 400, code: 'PEDIDO_VACIO' });
    expect(await code({ restaurante: R, almuerzo: { platos: [m['Seco de pollo'], m['Menestra con carne']] } })).toMatchObject({
      status: 400,
      code: 'ALMUERZO_INVALIDO',
    });
    expect(await code({ restaurante: R, almuerzo: { platos: [m['Huevo frito']] } })).toMatchObject({ code: 'ALMUERZO_INVALIDO' });
    expect(await code({ restaurante: R, extras: [{ plato: m['Sopa de quinua'], cantidad: 1 }] })).toMatchObject({
      status: 422,
      code: 'PLATO_SIN_PRECIO',
    });
    expect(await code({ restaurante: R, extras: [{ plato: randomUUID(), cantidad: 1 }] })).toMatchObject({
      status: 422,
      code: 'PLATO_NO_DISPONIBLE',
    });
    expect(await code({ restaurante: R, extras: [{ plato: m.Cola, cantidad: 11 }] })).toMatchObject({ status: 400 });
    expect(await code({ restaurante: R, extras: [{ plato: m.Cola, cantidad: 1 }], precio: 1 })).toMatchObject({ status: 400 });
    expect(await code({ restaurante: R, extras: [{ plato: m.Cola, cantidad: 1, precioUnitarioCentavos: 1 }] })).toMatchObject({
      status: 400,
    });

    const items = (await k.as(o).get('/v1/menu/hoy')).json().items;
    const seco = items.find((i: { nombre: string }) => i.nombre === 'Seco de pollo');
    await k.as(o).patch(`/v1/menu/hoy/items/${seco.id}/agotado`, { agotado: true });
    expect(await code({ restaurante: R, almuerzo: { platos: [m['Seco de pollo']] } })).toMatchObject({
      status: 409,
      code: 'PLATO_AGOTADO',
    });

    // Plato de otro local: no está en este menú.
    const o2 = await k.activeOwner();
    const m2 = await k.menu(o2);
    expect(await code({ restaurante: R, extras: [{ plato: m2.Cola, cantidad: 1 }] })).toMatchObject({ code: 'PLATO_NO_DISPONIBLE' });
    await k.as(o2).post('/v1/menu/hoy/despublicar');
    expect(await code({ restaurante: o2.restaurante, extras: [{ plato: m2.Cola, cantidad: 1 }] })).toMatchObject({
      status: 409,
      code: 'MENU_NO_PUBLICADO',
    });
    const borrador = await k.owner();
    expect(await code({ restaurante: borrador.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] })).toMatchObject({
      status: 404,
      code: 'RESTAURANTE_NO_ENCONTRADO',
    });
  });

  it('expira a los 30 minutos: queda EXPIRADA, no se cancela y libera el pedido en camino; cancelar en camino sí', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.diner();
    const body = { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] };
    const p = (await order(d, body)).json();
    await probe!.sql(
      `UPDATE orden_cabecera SET creada_en = creada_en - interval '31 minutes', vence_en = vence_en - interval '31 minutes' WHERE public_id = $1`,
      [p.id],
    );
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('EXPIRADA');
    expect((await k.as(d).post(`/v1/mis/pedidos/${p.id}/cancelar`)).json()).toMatchObject({ status: 409, code: 'PEDIDO_EXPIRADO' });

    const p2 = (await order(d, body)).json();
    expect(p2.estado).toBe('EN_CAMINO');
    const c = await k.as(d).post(`/v1/mis/pedidos/${p2.id}/cancelar`);
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ estado: 'CANCELADA', canceladoEn: expect.any(String) });
    expect((await k.as(d).post(`/v1/mis/pedidos/${p2.id}/cancelar`)).json().estado).toBe('CANCELADA');
  });

  describe('horaLlegada (opcional, misma ventana que las mesas)', () => {
    const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

    it('válida: se persiste y se devuelve al crear, en el detalle, en el listado, al cancelar y en la caja (cajero y dueño)', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      const cashier = await k.h.cashier(o.restaurante);
      const hora = inMinutes(45);
      const r = await order(d, { restaurante: o.restaurante, horaLlegada: hora, extras: [{ plato: m.Cola, cantidad: 1 }] });
      expect(r.statusCode, r.body).toBe(201);
      const p = r.json();
      expect(p.horaLlegada).toBe(hora);
      const db = await probe!.sql<{ hora_llegada: Date }>('SELECT hora_llegada FROM orden_cabecera WHERE public_id = $1', [p.id]);
      expect(db.rows[0]!.hora_llegada.toISOString()).toBe(hora);
      expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().horaLlegada).toBe(hora);
      expect((await k.as(d).get('/v1/mis/pedidos')).json().items[0].horaLlegada).toBe(hora);
      for (const staff of [o, cashier]) {
        expect((await k.as(staff).get(`/v1/caja/pedidos/${p.id}`)).json().horaLlegada).toBe(hora);
        expect((await k.as(staff).get('/v1/caja/pedidos')).json()[0].horaLlegada).toBe(hora);
      }
      const canje = (await k.as(cashier).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).json();
      expect(canje.pedido.horaLlegada).toBe(hora);
      expect((await k.as(cashier).post(`/v1/caja/pedidos/${p.id}/servir`)).json().horaLlegada).toBe(hora);

      // Dentro de los 5 minutos hacia atrás también vale; cancelar la devuelve igual.
      const o2 = await k.activeOwner();
      const m2 = await k.menu(o2);
      const atras = inMinutes(-3);
      const p2 = (await order(d, { restaurante: o2.restaurante, horaLlegada: atras, extras: [{ plato: m2.Cola, cantidad: 1 }] })).json();
      expect(p2.horaLlegada).toBe(atras);
      expect((await k.as(d).post(`/v1/mis/pedidos/${p2.id}/cancelar`)).json().horaLlegada).toBe(atras);
    });

    it('ausente: null en la base y en todas las respuestas', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      const p = (await order(d, { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] })).json();
      expect(p).toHaveProperty('horaLlegada', null);
      const db = await probe!.sql('SELECT hora_llegada FROM orden_cabecera WHERE public_id = $1', [p.id]);
      expect(db.rows[0]!.hora_llegada).toBeNull();
      expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json()).toHaveProperty('horaLlegada', null);
      expect((await k.as(d).get('/v1/mis/pedidos')).json().items[0]).toHaveProperty('horaLlegada', null);
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json()).toHaveProperty('horaLlegada', null);
    });

    it('fuera de ventana (más de 5 min atrás o más de 12 h adelante) → 400 HORA_LLEGADA_INVALIDA; formato inválido → 400; nada se crea', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      const body = (horaLlegada: unknown) => ({ restaurante: o.restaurante, horaLlegada, extras: [{ plato: m.Cola, cantidad: 1 }] });
      for (const h of [inMinutes(-10), inMinutes(12 * 60 + 5)]) {
        expect((await order(d, body(h))).json()).toMatchObject({ status: 400, code: 'HORA_LLEGADA_INVALIDA' });
        // cotizar comparte cuerpo y validaciones.
        expect((await k.as(d).post('/v1/mis/pedidos/cotizar', body(h))).json()).toMatchObject({
          status: 400,
          code: 'HORA_LLEGADA_INVALIDA',
        });
      }
      for (const h of ['mañana', '2026-13-45T25:00:00Z', 1700000000000, '']) {
        const r = await order(d, body(h));
        expect(r.statusCode, String(h)).toBe(400);
        expect(r.json().code).toBe('BAD_REQUEST');
      }
      const n = await probe!.sql(
        'SELECT count(*)::int AS n FROM orden_cabecera o JOIN usuario u USING (usuario_id) WHERE u.public_id = $1',
        [d.usuarioId],
      );
      expect(n.rows[0]!.n).toBe(0);
    });

    it('no se filtra entre restaurantes: la caja de otro local no ve el pedido ni su hora (API y RLS)', async () => {
      const o = await k.activeOwner();
      const otro = await k.activeOwner();
      const m = await k.menu(o);
      const d = await k.diner();
      const p = (
        await order(d, { restaurante: o.restaurante, horaLlegada: inMinutes(30), extras: [{ plato: m.Cola, cantidad: 1 }] })
      ).json();
      expect((await k.as(otro).get(`/v1/caja/pedidos/${p.id}`)).json()).toMatchObject({ status: 404, code: 'PEDIDO_NO_ENCONTRADO' });
      expect((await k.as(otro).get('/v1/caja/pedidos?estado=TODOS')).json()).toEqual([]);
      const tenant = (
        await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [otro.restaurante])
      ).rows[0]!.restaurante_id;
      expect(await k.rls({ tenantId: String(tenant) }, 'SELECT hora_llegada FROM orden_cabecera WHERE hora_llegada IS NOT NULL')).toEqual(
        [],
      );
    });
  });

  it('un comensal solo ve y cancela sus pedidos: la API responde 404 y RLS no deja ver ni crear a nombre de otro', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const otro = await k.diner();
    const p = (await order(d, { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } })).json();
    expect((await k.as(otro).get(`/v1/mis/pedidos/${p.id}`)).json()).toMatchObject({ status: 404, code: 'PEDIDO_NO_ENCONTRADO' });
    expect((await k.as(otro).post(`/v1/mis/pedidos/${p.id}/cancelar`)).statusCode).toBe(404);
    expect((await k.as(otro).get('/v1/mis/pedidos')).json().items).toEqual([]);
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');

    const uid = await k.internalUser(otro.usuarioId);
    expect(await k.rls({ userId: uid }, 'SELECT public_id FROM orden_cabecera')).toEqual([]);
    expect(await k.rls({ userId: uid }, 'SELECT orden_detalle_id FROM orden_detalle')).toEqual([]);
    // RLS: no puede crear un pedido con la ficha de cliente de otra persona (la caja descontaría su almuerzo)…
    const ids = (
      await probe!.sql<{ restaurante_id: string; cliente_id: string }>(
        `SELECT c.restaurante_id, c.cliente_id FROM cliente_restaurante c JOIN usuario u USING (usuario_id) WHERE u.public_id = $1`,
        [d.usuarioId],
      )
    ).rows[0]!;
    const insert = (clienteId: string | null, estado: string) =>
      k.rls(
        { userId: uid },
        `INSERT INTO orden_cabecera (restaurante_id, usuario_id, cliente_id, numero_dia, fecha_local, subtotal_centavos, total_centavos, moneda_codigo, vence_en, estado)
         VALUES ($1, app_user_id(), $2, 99, CURRENT_DATE, 0, 0, 'USD', CURRENT_TIMESTAMP + interval '1 minute', $3)`,
        [ids.restaurante_id, clienteId, estado],
      );
    await expect(insert(ids.cliente_id, 'EN_CAMINO')).rejects.toMatchObject({ code: '42501' });
    // …ni crearlo ya canjeado.
    await expect(insert(null, 'CANJEADA')).rejects.toMatchObject({ code: '42501' });
  });
});
