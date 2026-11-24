import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 8: preórdenes en la vista del personal', () => {
  const k = new DinerKit(probe!, 84);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  async function setup(withPlan = true) {
    const o = await k.activeOwner('Caja Pedidos');
    const m = await k.menu(o);
    const d = withPlan ? await k.dinerWithPlan(o) : await k.diner();
    const p = (
      await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: o.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] },
          extras: [{ plato: m.Cola, cantidad: 1 }],
        },
        randomUUID(),
      )
    ).json();
    return { o, m, d, p };
  }
  const saldo = async (o: { token: string; restaurante: string }, c: string) =>
    (await k.as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;

  it('el pedido del comensal aparece en la caja del dueño y del cajero, con quién pidió y su saldo', async () => {
    const { o, d, p } = await setup();
    const cashier = await k.h.cashier(o.restaurante);
    for (const who of [o, cashier]) {
      const list = await k.as(who).get('/v1/caja/pedidos');
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
      expect(list.json()[0]).toMatchObject({
        id: p.id,
        numero: 1,
        estado: 'EN_CAMINO',
        comensal: { nombre: 'Comensal Prueba' },
        cliente: { almuerzosDisponibles: 5 },
        almuerzo: { cubiertoPorPlan: true },
        extras: [{ nombre: 'Cola', subtotalCentavos: 100 }],
        totalCentavos: 125,
      });
      expectOnlyPublicIds(list.json());
    }
    // Escanear el QR = GET por public_id.
    expect((await k.as(cashier).get(`/v1/caja/pedidos/${p.qr}`)).json()).toMatchObject({ id: p.id, estado: 'EN_CAMINO' });
    expect(d.clienteId).toBeTruthy();
  });

  it('canjear descuenta el almuerzo del plan (canal PREORDEN) una sola vez y cobra aparte extras y recargo', async () => {
    const { o, d, p } = await setup();
    const key = randomUUID();
    const r = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, key);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      yaCanjeado: false,
      almuerzo: { resultado: 'OK', descontado: true, consumoId: expect.any(String) },
      porCobrarCentavos: 100 + 25,
      pedido: { estado: 'CANJEADA', canjeadoEn: expect.any(String) },
    });
    expect(await saldo(o, d.clienteId)).toBe(4);
    // Misma clave u otra: no vuelve a descontar.
    for (const again of [key, randomUUID()]) {
      const x = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, again)).json();
      expect(x).toMatchObject({ yaCanjeado: true, almuerzo: { descontado: true, consumoId: r.json().almuerzo.consumoId } });
    }
    expect(await saldo(o, d.clienteId)).toBe(4);
    // El comensal lo ve canjeado y el almuerzo en su historial con canal PREORDEN.
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('CANJEADA');
    expect((await k.as(d).get('/v1/mis/consumos')).json().items[0]).toMatchObject({ id: r.json().almuerzo.consumoId, canal: 'PREORDEN' });
    const orden = await probe!.sql('SELECT k.orden_id IS NOT NULL AS con_orden FROM consumo_almuerzo k WHERE k.public_id = $1', [
      r.json().almuerzo.consumoId,
    ]);
    expect(orden.rows[0]!.con_orden).toBe(true);
    // Después se sirve; servir dos veces no falla.
    expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/servir`)).json().estado).toBe('SERVIDA');
    expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/servir`)).json().estado).toBe('SERVIDA');
    expect((await k.as(o).get('/v1/caja/pedidos?estado=SERVIDA')).json()).toHaveLength(1);
    expect((await k.as(o).get('/v1/caja/pedidos')).json()).toHaveLength(0);
  });

  describe('PR 10: validar cierra la preorden del cliente (preórdenes huérfanas)', () => {
    it('D1-D3: un solo escaneo descuenta el plan una vez, cierra la preorden y cobra extras+recargo en una cuenta; sin 409 pese al total viejo', async () => {
      const { o, d, p } = await setup();
      const key = randomUUID();
      const r = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, key);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'OK',
        descontado: true,
        consumo: { id: expect.any(String) },
        cuenta: { estado: 'ABIERTA', saldoCentavos: 100 + 25 },
      });
      expect(await saldo(o, d.clienteId)).toBe(4); // un solo almuerzo descontado, no dos
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().estado).toBe('CANJEADA');
      // Canal real del escaneo (MANUAL: se mandó clienteId sin QR), pero con orden_id: en movimientos sale como PEDIDO.
      const fila = await probe!.sql<{ canal: string; con_orden: boolean }>(
        `SELECT canal::text, orden_id IS NOT NULL AS con_orden FROM consumo_almuerzo WHERE public_id = $1`,
        [r.json().consumo.id],
      );
      expect(fila.rows[0]).toMatchObject({ canal: 'MANUAL', con_orden: true });
      // El canje por su propio QR, después, es un reintento idempotente de lo que ya cerró validar (mismo camino).
      const otraVez = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
      expect(otraVez.statusCode, otraVez.body).toBe(200);
      expect(otraVez.json()).toMatchObject({ yaCanjeado: true, almuerzo: { descontado: true } });
      expect(await saldo(o, d.clienteId)).toBe(4);
    });

    it('D5: una preorden de solo carta/extras (sin almuerzo) se deja sola; validar hace su canje directo aparte', async () => {
      const o = await k.activeOwner('Caja Preorden Carta');
      const m = await k.menu(o);
      const d = await k.dinerWithPlan(o);
      const soloCarta = (
        await k.as(d).post('/v1/mis/pedidos', { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] }, randomUUID())
      ).json();
      const r = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, randomUUID());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ resultado: 'OK', descontado: true });
      // La preorden de carta sigue EN_CAMINO: no la tocó.
      expect((await k.as(o).get(`/v1/caja/pedidos/${soloCarta.id}`)).json().estado).toBe('EN_CAMINO');
      const canje = await k.as(o).post(`/v1/caja/pedidos/${soloCarta.id}/canjear`, {}, randomUUID());
      expect(canje.statusCode, canje.body).toBe(200);
      expect(canje.json()).toMatchObject({ yaCanjeado: false, almuerzo: null, porCobrarCentavos: 100 });
    });

    it('D8: los items de la caja en validar entran a la MISMA cuenta de la preorden (una sola cuenta)', async () => {
      const { o, m, d } = await setup();
      const key = randomUUID();
      const r = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId, items: [{ plato: m.Cola, cantidad: 2 }] }, key);
      expect(r.statusCode, r.body).toBe(200);
      // Cola (de la preorden) + Cola x2 (de validar) + recargo para llevar: una sola cuenta con todo.
      expect(r.json().cuenta.saldoCentavos).toBe(100 + 200 + 25);
      expect(r.json().cuenta.cotizacion.lineas.filter((i: { nombre: string }) => i.nombre === 'Cola')).toHaveLength(2);
    });

    it('D6: paraLlevar de validar que no coincide con el de la preorden se ignora para el cobro (gana el congelado) y solo avisa', async () => {
      const { o, d } = await setup(); // la preorden pidió paraLlevar: true
      const r = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId, paraLlevar: false }, randomUUID());
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().cuenta.saldoCentavos).toBe(100 + 25); // el recargo se sigue cobrando: no cambia por el paraLlevar de validar
      expect(r.json().avisos).toEqual(expect.arrayContaining([{ codigo: 'PARA_LLEVAR_DE_LA_ORDEN', lineaRef: 'almuerzo' }]));
    });

    it('D1 (con cobro explícito): si la caja igual manda saldoEsperadoCentavos y no coincide, SALDO_CAMBIO sigue aplicando', async () => {
      const { o, d } = await setup();
      const r = await k
        .as(o)
        .post(
          '/v1/caja/validar',
          { clienteId: d.clienteId, cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 999999 } },
          randomUUID(),
        );
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().code).toBe('SALDO_CAMBIO');
      expect(r.json().saldoCentavos).toBe(100 + 25);
      // No descontó nada: todo se deshizo con el 409.
      expect(await saldo(o, d.clienteId)).toBe(5);
    });
  });

  it('sin plan: no descuenta y el almuerzo queda por cobrar; una clave de otra validación → 409', async () => {
    const { o, p } = await setup(false);
    const r = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).json();
    expect(r).toMatchObject({ almuerzo: { resultado: 'SIN_PLAN', descontado: false }, porCobrarCentavos: 350 + 25 + 100 });

    const { o: o2, p: p2 } = await setup();
    const key = randomUUID();
    const d2 = await k.dinerWithPlan(o2);
    await k.as(o2).post('/v1/caja/validar', { clienteId: d2.clienteId }, key);
    expect((await k.as(o2).post(`/v1/caja/pedidos/${p2.id}/canjear`, {}, key)).json()).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUTILIZADA',
    });
  });

  it('con horaLlegada: vence 30 min después de llegar; EN_CAMINO y canjeable hasta ahí, luego EXPIRADA', async () => {
    const o = await k.activeOwner('Caja Llegada');
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const hora = new Date(Date.now() + 120 * 60_000).toISOString();
    const crear = async (extra: object = {}) =>
      (
        await k
          .as(d)
          .post(
            '/v1/mis/pedidos',
            { restaurante: o.restaurante, horaLlegada: hora, almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] }, ...extra },
            randomUUID(),
          )
      ).json();
    const p = await crear();
    const fila = await probe!.sql<{ d: number }>(
      `SELECT extract(epoch FROM vence_en - hora_llegada)::int AS d FROM orden_cabecera WHERE public_id = $1`,
      [p.id],
    );
    expect(fila.rows[0]!.d).toBe(30 * 60);
    expect(new Date(p.venceEn).getTime()).toBe(new Date(hora).getTime() + 30 * 60_000);
    // Se corre el reloj de la fila hacia atrás: `minutos` después de creado el pedido.
    const avanzar = (minutos: number) =>
      probe!.sql(
        `UPDATE orden_cabecera SET creada_en = creada_en - make_interval(mins => $2), vence_en = vence_en - make_interval(mins => $2),
                                   hora_llegada = hora_llegada - make_interval(mins => $2) WHERE public_id = $1`,
        [p.id, minutos],
      );

    // 10 min después de la hora de llegada (130 min tras crearlo): sigue vivo en todos lados.
    await avanzar(130);
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
    expect((await k.as(o).get('/v1/caja/pedidos')).json().map((x: { id: string }) => x.id)).toContain(p.id);
    expect(
      (
        await k.as(d).post('/v1/mis/pedidos', { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] }, randomUUID())
      ).json(),
    ).toMatchObject({
      status: 409,
      code: 'PEDIDO_ACTIVO',
    });
    const canje = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
    expect(canje.statusCode, canje.body).toBe(200);

    // Otro pedido (otro comensal): pasada la hora + 30 min, EXPIRADA, no canjeable, no cancelable, fuera de ACTIVOS.
    const d2 = await k.dinerWithPlan(o);
    const p2 = (
      await k
        .as(d2)
        .post(
          '/v1/mis/pedidos',
          { restaurante: o.restaurante, horaLlegada: hora, almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] } },
          randomUUID(),
        )
    ).json();
    await probe!.sql(
      `UPDATE orden_cabecera SET creada_en = creada_en - interval '151 minutes', vence_en = vence_en - interval '151 minutes',
                                 hora_llegada = hora_llegada - interval '151 minutes' WHERE public_id = $1`,
      [p2.id],
    );
    expect((await k.as(d2).get(`/v1/mis/pedidos/${p2.id}`)).json().estado).toBe('EXPIRADA');
    expect((await k.as(o).post(`/v1/caja/pedidos/${p2.id}/canjear`, {}, randomUUID())).json()).toMatchObject({
      status: 409,
      code: 'PEDIDO_EXPIRADO',
    });
    expect((await k.as(d2).post(`/v1/mis/pedidos/${p2.id}/cancelar`)).json()).toMatchObject({ status: 409, code: 'PEDIDO_EXPIRADO' });
    expect((await k.as(o).get('/v1/caja/pedidos?estado=EXPIRADA')).json().map((x: { id: string }) => x.id)).toEqual([p2.id]);
    // La guardia PEDIDO_ACTIVO se libera: el comensal puede pedir de nuevo.
    expect(
      (await k.as(d2).post('/v1/mis/pedidos', { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] }, randomUUID()))
        .statusCode,
    ).toBe(201);
  });

  it('hora de llegada pasada (dentro de 5 min) o ausente: vence 30 min después de crearlo', async () => {
    const o = await k.activeOwner('Caja Llegada 2');
    const m = await k.menu(o);
    for (const hora of [undefined, new Date(Date.now() - 3 * 60_000).toISOString()]) {
      const d = await k.diner();
      const p = (
        await k
          .as(d)
          .post(
            '/v1/mis/pedidos',
            { restaurante: o.restaurante, horaLlegada: hora, extras: [{ plato: m.Cola, cantidad: 1 }] },
            randomUUID(),
          )
      ).json();
      const fila = await probe!.sql<{ d: number }>(
        `SELECT extract(epoch FROM vence_en - creada_en)::int AS d FROM orden_cabecera WHERE public_id = $1`,
        [p.id],
      );
      expect(fila.rows[0]!.d).toBe(30 * 60);
    }
  });

  it('vencido, cancelado o sin canjear: códigos de negocio estables', async () => {
    const { o, d, p } = await setup();
    expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/servir`)).json()).toMatchObject({ status: 409, code: 'PEDIDO_NO_CANJEADO' });
    await probe!.sql(
      `UPDATE orden_cabecera SET creada_en = creada_en - interval '31 minutes', vence_en = vence_en - interval '31 minutes' WHERE public_id = $1`,
      [p.id],
    );
    expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).json()).toMatchObject({
      status: 409,
      code: 'PEDIDO_EXPIRADO',
    });
    expect((await k.as(o).get('/v1/caja/pedidos?estado=EXPIRADA')).json()).toHaveLength(1);
    expect(await saldo(o, d.clienteId)).toBe(5);

    const { o: o2, d: d2, p: p2 } = await setup();
    await k.as(d2).post(`/v1/mis/pedidos/${p2.id}/cancelar`);
    expect((await k.as(o2).post(`/v1/caja/pedidos/${p2.id}/canjear`, {}, randomUUID())).json()).toMatchObject({
      status: 409,
      code: 'PEDIDO_CANCELADO',
    });
    expect((await k.as(o2).post(`/v1/caja/pedidos/${randomUUID()}/canjear`, {}, randomUUID())).json()).toMatchObject({
      status: 404,
      code: 'PEDIDO_NO_ENCONTRADO',
    });
  });

  it('otro local no ve ni canjea el pedido (guard + RLS); el comensal no entra a la caja', async () => {
    const { o, d, p } = await setup();
    const otro = await k.owner();
    expect((await k.as(otro).get('/v1/caja/pedidos')).json()).toEqual([]);
    expect((await k.as(otro).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(404);
    expect((await k.as(otro).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).statusCode).toBe(404);
    // Con el x-restaurant-id del local donde no trabaja → 403 (TenantGuard); sin encabezado → 400.
    expect((await k.as({ token: otro.token, restaurante: o.restaurante }).get('/v1/caja/pedidos')).statusCode).toBe(403);
    expect((await k.as({ token: d.token, restaurante: o.restaurante }).get('/v1/caja/pedidos')).statusCode).toBe(403);
    expect((await k.as(d).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).statusCode).toBe(400);
    expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
    // RLS: con el tenant del otro local no aparece ninguna fila del pedido.
    const tid = String(
      (await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [otro.restaurante]))
        .rows[0]!.restaurante_id,
    );
    expect(await k.rls({ tenantId: tid }, 'SELECT public_id FROM orden_cabecera')).toEqual([]);
    expect(await k.rls({ tenantId: tid }, 'SELECT orden_detalle_id FROM orden_detalle')).toEqual([]);
  });
});
