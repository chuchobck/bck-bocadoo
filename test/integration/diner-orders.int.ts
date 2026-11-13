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
