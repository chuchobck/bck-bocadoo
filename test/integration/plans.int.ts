import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Actor, Harness, unique } from './harness';

const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe('Fase 6: plantillas, clientes, venta de planes, pagos, solicitudes y deshacer', () => {
  const h = new Harness(74);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const as = (who: Actor) => ({
    get: (url: string) => h.call('GET', url, { token: who.token, restaurante: who.restaurante }),
    post: (url: string, payload?: object, key?: string) =>
      h.app.inject({
        method: 'POST',
        url,
        payload,
        remoteAddress: h.ip(),
        headers: { authorization: `Bearer ${who.token}`, 'x-restaurant-id': who.restaurante, ...(key && { 'idempotency-key': key }) },
      }),
    patch: (url: string, payload?: object) => h.call('PATCH', url, { token: who.token, restaurante: who.restaurante, payload }),
    put: (url: string, payload?: object) => h.call('PUT', url, { token: who.token, restaurante: who.restaurante, payload }),
  });
  async function plan(o: Actor, extra: object = {}) {
    const r = await as(o).post('/v1/planes', {
      tipo: 'SEMANAL',
      nombre: 'Semanal',
      almuerzos: 5,
      precioCentavos: 1500,
      vigenciaDias: 7,
      ...extra,
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }
  async function customer(o: Actor, extra: object = {}) {
    const r = await as(o).post('/v1/clientes', { nombre: `Cliente ${unique()}`, ...extra });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }
  const sell = (o: Actor, clienteId: string, planId: string, key = randomUUID(), metodoPago = 'EFECTIVO', extra: object = {}) =>
    as(o).post(`/v1/clientes/${clienteId}/planes`, { planId, metodoPago, ...extra }, key);
  const hoy = async (o: Actor) => (await as(o).get('/v1/menu/hoy')).json().fecha as string;
  const payments = (subPublicId: string) =>
    h.db.service((q) =>
      q.query<{ monto_centavos: string; estado: string; revierte: boolean }>(
        `SELECT p.monto_centavos, p.estado, p.revierte_a_pago_id IS NOT NULL AS revierte FROM transaccion_pago p
           JOIN suscripcion_plan s ON s.suscripcion_id = p.suscripcion_id WHERE s.public_id = $1 ORDER BY p.pago_id`,
        [subPublicId],
      ),
    );

  describe('plantillas', () => {
    it('el dueño crea y edita; el cajero solo ve; validaciones', async () => {
      const o = await h.owner('Planes Plantillas');
      const c = await h.cashier(o.restaurante);
      const created = await as(o).post('/v1/planes', {
        tipo: 'MENSUAL',
        nombre: 'Mensual',
        almuerzos: 20,
        precioCentavos: 5500,
        vigenciaDias: 30,
        cupos: 10,
        diasValidos: [1, 2, 3, 4, 5, 6],
        incluye: ['sopa', 'segundo'],
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        almuerzos: 20,
        precioCentavos: 5500,
        cupos: 10,
        cuposDisponibles: 10,
        vendidosActivos: 0,
        diasValidos: [1, 2, 3, 4, 5, 6],
        activo: true,
        visibleEnMarketplace: false,
      });
      const id = created.json().id;
      expect((await as(o).patch(`/v1/planes/${id}`, { cupos: null, visibleEnMarketplace: true })).json()).toMatchObject({
        cupos: null,
        cuposDisponibles: null,
        visibleEnMarketplace: true,
      });
      expect((await as(c).get('/v1/planes')).json()).toHaveLength(1);
      expect(
        (await as(c).post('/v1/planes', { tipo: 'SEMANAL', nombre: 'X', almuerzos: 5, precioCentavos: 1, vigenciaDias: 7 })).statusCode,
      ).toBe(403);
      for (const bad of [
        { almuerzos: 0 },
        { precioCentavos: 0 },
        { vigenciaDias: 0 },
        { tipo: 'ANUAL' },
        { diasValidos: [8] },
        { diasValidos: [1, 1] },
        { diasValidos: [] },
      ]) {
        expect(
          (await as(o).post('/v1/planes', { tipo: 'SEMANAL', nombre: 'Malo', almuerzos: 5, precioCentavos: 100, vigenciaDias: 7, ...bad }))
            .statusCode,
        ).toBe(400);
      }
      expect((await as(o).patch('/v1/planes/99999999', { activo: false })).statusCode).toBe(404);
    });
  });

  describe('clientes', () => {
    it('teléfono E.164 y único por restaurante (409 claro); en otro local puede repetirse', async () => {
      const a = await h.owner('Clientes A');
      const b = await h.owner('Clientes B');
      const tel = `+5939${String(Date.now()).slice(-8)}`;
      expect((await as(a).post('/v1/clientes', { nombre: 'Ana', telefono: tel })).statusCode).toBe(201);
      const dup = await as(a).post('/v1/clientes', { nombre: 'Otra Ana', telefono: tel });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().detail).toBe('Ya existe un cliente con ese teléfono en este restaurante.');
      expect((await as(b).post('/v1/clientes', { nombre: 'Ana en B', telefono: tel })).statusCode).toBe(201);
      for (const telefono of ['0991234567', '+0991234567', '+59399', 'abc'])
        expect((await as(a).post('/v1/clientes', { nombre: 'X', telefono })).statusCode).toBe(400);
      // Editar a un teléfono que ya usa otro cliente también da 409.
      const other = await customer(a);
      expect((await as(a).patch(`/v1/clientes/${other}`, { telefono: tel })).statusCode).toBe(409);
    });

    it('buscar por nombre o teléfono, con cursor; editar; aislado por local', async () => {
      const a = await h.owner('Buscar A');
      const b = await h.owner('Buscar B');
      const tag = unique();
      const tel = `+5938${String(Date.now()).slice(-8)}`;
      for (const n of [1, 2, 3]) await as(a).post('/v1/clientes', { nombre: `Busca ${tag} ${n}`, ...(n === 2 && { telefono: tel }) });
      const p1 = (await as(a).get(`/v1/clientes?q=${tag}&limit=2`)).json();
      expect(p1.items).toHaveLength(2);
      const p2 = (await as(a).get(`/v1/clientes?q=${tag}&limit=2&cursor=${p1.nextCursor}`)).json();
      expect([...p1.items, ...p2.items].map((c: { nombre: string }) => c.nombre)).toEqual([1, 2, 3].map((n) => `Busca ${tag} ${n}`));
      expect(p2.nextCursor).toBeNull();
      expect(
        (await as(a).get(`/v1/clientes?q=${encodeURIComponent(tel.slice(-6))}`)).json().items.map((c: { nombre: string }) => c.nombre),
      ).toEqual([`Busca ${tag} 2`]);
      expect((await as(b).get(`/v1/clientes?q=${tag}`)).json().items).toEqual([]);
      const id = p1.items[0].id;
      expect((await as(a).patch(`/v1/clientes/${id}`, { nota: 'Sin cebolla' })).json().nota).toBe('Sin cebolla');
      expect((await as(b).patch(`/v1/clientes/${id}`, { nota: 'x' })).statusCode).toBe(404);
      expect((await as(b).get(`/v1/clientes/${id}`)).statusCode).toBe(404);
      expect((await as(a).get('/v1/clientes?cursor=basura')).statusCode).toBe(400);
      expect((await as(a).get('/v1/clientes?limit=51')).statusCode).toBe(400);
    });

    it('migrar una cartulina de papel crea un plan MIGRADA sin cobro', async () => {
      const o = await h.owner('Cartulina');
      const c = await h.cashier(o.restaurante);
      const id = await customer(o);
      const venceEl = addDays(await hoy(o), 20);
      const res = await as(o).post(`/v1/clientes/${id}/migrar-cartulina`, { almuerzosRestantes: 7, venceEl, precioUnitarioCentavos: 300 });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ almuerzosDisponibles: 7, proximoVencimiento: venceEl });
      expect(res.json().planes[0]).toMatchObject({
        origen: 'MIGRADA',
        almuerzosTotales: 7,
        almuerzosRestantes: 7,
        precioPagadoCentavos: 2100,
        precioUnitarioCentavos: 300,
        venceEl,
        estado: 'ACTIVA',
        pago: null,
      });
      expect(
        (
          await as(o).post(`/v1/clientes/${id}/migrar-cartulina`, {
            almuerzosRestantes: 1,
            venceEl: addDays(await hoy(o), -1),
            precioUnitarioCentavos: 300,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await as(o).post(`/v1/clientes/${id}/migrar-cartulina`, {
            almuerzosRestantes: 1,
            venceEl: '2026-02-31',
            precioUnitarioCentavos: 300,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await as(c).post(`/v1/clientes/${id}/migrar-cartulina`, { almuerzosRestantes: 1, venceEl, precioUnitarioCentavos: 300 }))
          .statusCode,
      ).toBe(403);
    });

    it('vincular con la cuenta de la app por correo; una cuenta solo a un cliente por local', async () => {
      const o = await h.owner('Vincular');
      const d = await h.diner();
      const c1 = await customer(o);
      const c2 = await customer(o);
      const linked = await as(o).post(`/v1/clientes/${c1}/vincular`, { correo: d.correo });
      expect(linked.statusCode).toBe(200);
      expect(linked.json().vinculadoApp).toBe(true);
      expect(linked.body).not.toContain(d.correo); // la ficha no expone el correo de la cuenta
      const dup = await as(o).post(`/v1/clientes/${c2}/vincular`, { correo: d.correo });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().detail).toContain('ya está vinculada');
      expect((await as(o).post(`/v1/clientes/${c1}/vincular`, { correo: `nadie_${unique()}@correo.com` })).statusCode).toBe(404);
      expect((await as(o).post(`/v1/clientes/${c1}/desvincular`)).json().vinculadoApp).toBe(false);
      expect((await as(o).post(`/v1/clientes/${c2}/vincular`, { correo: d.correo })).statusCode).toBe(200);
    });
  });

  describe('venta de planes', () => {
    it('vender crea plan + pago en una sola respuesta; efectivo queda confirmado', async () => {
      const o = await h.owner('Venta Básica');
      const p = await plan(o, { almuerzos: 4, precioCentavos: 1300 });
      const c = await customer(o);
      const res = await sell(o, c, p);
      expect(res.statusCode).toBe(201);
      const today = await hoy(o);
      expect(res.json()).toMatchObject({
        origen: 'VENTA',
        nombrePlan: 'Semanal',
        almuerzosTotales: 4,
        almuerzosRestantes: 4,
        precioPagadoCentavos: 1300,
        precioUnitarioCentavos: 325,
        estado: 'ACTIVA',
        venceEl: addDays(today, 6),
        diasValidos: [1, 2, 3, 4, 5],
        pago: { estado: 'CONFIRMADO', metodo: 'EFECTIVO', montoCentavos: 1300, fecha: today, reverso: null },
      });
      expect((await as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles).toBe(4);
    });

    it('si el pago no se puede guardar, tampoco queda el plan (una sola transacción)', async () => {
      const o = await h.owner('Venta Atómica');
      const p = await plan(o);
      const c = await customer(o);
      // Se ocupa una clave con un pago inverso (deshacer): al vender con esa clave, el plan se inserta y el pago choca.
      const first = (await sell(o, c, p)).json();
      const usedKey = randomUUID();
      expect((await as(o).post(`/v1/planes-vendidos/${first.id}/deshacer`, {}, usedKey)).statusCode).toBe(200);
      const before = (await as(o).get(`/v1/clientes/${c}`)).json().planes.length;
      const res = await sell(o, c, p, usedKey);
      expect(res.statusCode).toBe(409);
      expect((await as(o).get(`/v1/clientes/${c}`)).json().planes.length).toBe(before);
    });

    it('la misma Idempotency-Key devuelve la misma venta, también en paralelo; con otra venta → 409', async () => {
      const o = await h.owner('Idempotencia');
      const p = await plan(o);
      const p2 = await plan(o, { nombre: 'Otro' });
      const c = await customer(o);
      const key = randomUUID();
      const a = await sell(o, c, p, key);
      const b = await sell(o, c, p, key);
      expect(b.statusCode).toBe(201);
      expect(b.json()).toEqual(a.json());
      const k2 = randomUUID();
      const burst = await Promise.all(Array.from({ length: 6 }, () => sell(o, c, p, k2)));
      expect(new Set(burst.map((r) => r.statusCode))).toEqual(new Set([201]));
      expect(new Set(burst.map((r) => r.json().id)).size).toBe(1);
      expect((await as(o).get(`/v1/clientes/${c}`)).json().planes).toHaveLength(2); // dos claves → dos ventas, no ocho
      expect((await sell(o, c, p2, key)).statusCode).toBe(409);
      expect((await as(o).post(`/v1/clientes/${c}/planes`, { planId: p, metodoPago: 'EFECTIVO' })).statusCode).toBe(400);
      expect((await sell(o, c, p, 'no-es-uuid')).statusCode).toBe(400);
    });

    it('editar la plantilla no cambia lo ya vendido', async () => {
      const o = await h.owner('Plantilla Fija');
      const p = await plan(o, { almuerzos: 5, precioCentavos: 1500, vigenciaDias: 7 });
      const c = await customer(o);
      const sold = (await sell(o, c, p)).json();
      await as(o).patch(`/v1/planes/${p}`, {
        nombre: 'Semanal caro',
        almuerzos: 10,
        precioCentavos: 9999,
        vigenciaDias: 30,
        diasValidos: [6, 7],
      });
      const after = (await as(o).get(`/v1/clientes/${c}`)).json().planes[0];
      expect(after).toMatchObject({
        id: sold.id,
        nombrePlan: 'Semanal',
        almuerzosTotales: 5,
        precioPagadoCentavos: 1500,
        venceEl: sold.venceEl,
        diasValidos: [1, 2, 3, 4, 5],
      });
    });

    it('se respetan los cupos, también con ventas simultáneas; deshacer libera el cupo', async () => {
      const o = await h.owner('Cupos');
      const p = await plan(o, { cupos: 2 });
      const [c1, c2, c3] = [await customer(o), await customer(o), await customer(o)];
      const s1 = await sell(o, c1, p);
      expect(s1.statusCode).toBe(201);
      expect((await sell(o, c2, p)).statusCode).toBe(201);
      const full = await sell(o, c3, p);
      expect(full.statusCode).toBe(409);
      expect(full.json().detail).toContain('cupos');
      expect((await as(o).get('/v1/planes')).json()[0]).toMatchObject({ cuposDisponibles: 0, vendidosActivos: 2 });
      await as(o).post(`/v1/planes-vendidos/${s1.json().id}/deshacer`, {}, randomUUID());
      expect((await sell(o, c3, p)).statusCode).toBe(201);

      const one = await plan(o, { cupos: 1, nombre: 'Último cupo' });
      const buyers = await Promise.all(Array.from({ length: 5 }, () => customer(o)));
      const race = await Promise.all(buyers.map((c) => sell(o, c, one)));
      expect(race.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(race.filter((r) => r.statusCode === 409)).toHaveLength(4);
    });

    it('dos planes del mismo cliente no suman vencimientos: cada uno vence por su cuenta', async () => {
      const o = await h.owner('Dos Planes');
      const semanal = await plan(o, { vigenciaDias: 7 });
      const mensual = await plan(o, { nombre: 'Mensual', almuerzos: 20, precioCentavos: 5000, vigenciaDias: 30 });
      const c = await customer(o);
      const today = await hoy(o);
      const a = (await sell(o, c, semanal)).json();
      const b = (await sell(o, c, mensual)).json();
      const a2 = (await sell(o, c, semanal)).json();
      expect(a.venceEl).toBe(addDays(today, 6));
      expect(b.venceEl).toBe(addDays(today, 29));
      expect(a2.venceEl).toBe(addDays(today, 6)); // no se encadena detrás del primero
      const ficha = (await as(o).get(`/v1/clientes/${c}`)).json();
      expect(ficha).toMatchObject({ almuerzosDisponibles: 30, proximoVencimiento: addDays(today, 6) });
      expect(ficha.planes).toHaveLength(3);
    });

    it('plan desactivado, cliente inactivo o de otro local, método inválido', async () => {
      const a = await h.owner('Venta Reglas A');
      const b = await h.owner('Venta Reglas B');
      const p = await plan(a);
      const c = await customer(a);
      const cb = await customer(b);
      expect((await sell(a, c, p, randomUUID(), 'BITCOIN')).statusCode).toBe(400);
      expect((await sell(a, c, p, randomUUID(), 'BOCADOO_CASH')).statusCode).toBe(400);
      expect((await sell(a, cb, p)).statusCode).toBe(404); // cliente de otro local
      expect((await sell(b, cb, p)).statusCode).toBe(404); // plan de otro local
      await as(a).patch(`/v1/planes/${p}`, { activo: false });
      expect((await sell(a, c, p)).statusCode).toBe(409);
      const p2 = await plan(a);
      await as(a).patch(`/v1/clientes/${c}`, { activo: false });
      expect((await sell(a, c, p2)).statusCode).toBe(404);
    });
  });

  describe('pagos pendientes', () => {
    it('transferencia queda pendiente; el dueño confirma o rechaza; repetir es idempotente', async () => {
      const o = await h.owner('Transferencias');
      const cashier = await h.cashier(o.restaurante);
      const p = await plan(o);
      const c = await customer(o);
      const ref = `TRX-${unique()}`;
      const tr = await sell(cashier, c, p, randomUUID(), 'TRANSFERENCIA', {
        comprobanteUrl: 'https://cdn.test/comp.jpg',
        referenciaExterna: ref,
      });
      expect(tr.statusCode, tr.body).toBe(201);
      const t = tr.json();
      expect(t.pago).toMatchObject({ estado: 'PENDIENTE', metodo: 'TRANSFERENCIA', comprobanteUrl: 'https://cdn.test/comp.jpg' });
      expect(t.estado).toBe('ACTIVA');
      // El mismo depósito no puede pagar dos planes.
      const twice = await sell(o, c, p, randomUUID(), 'TRANSFERENCIA', { referenciaExterna: ref });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().detail).toContain('mismo depósito');
      expect((await as(o).get('/v1/pagos/pendientes')).json().map((x: { id: string }) => x.id)).toEqual([t.id]);
      expect((await as(cashier).post(`/v1/pagos/${t.pago.id}/confirmar`)).statusCode).toBe(403);
      const ok = await as(o).post(`/v1/pagos/${t.pago.id}/confirmar`);
      expect(ok.json().pago.estado).toBe('CONFIRMADO');
      expect((await as(o).post(`/v1/pagos/${t.pago.id}/confirmar`)).statusCode).toBe(200);
      expect((await as(o).post(`/v1/pagos/${t.pago.id}/rechazar`)).statusCode).toBe(409);
      expect((await as(o).get('/v1/pagos/pendientes')).json()).toEqual([]);

      const r = (await sell(o, c, p, randomUUID(), 'DEUNA')).json();
      const rej = await as(o).post(`/v1/pagos/${r.pago.id}/rechazar`);
      expect(rej.json()).toMatchObject({ estado: 'ANULADA', pago: { estado: 'RECHAZADO' } });
      const pre = (await sell(o, c, p, randomUUID(), 'TRANSFERENCIA', { pagoConfirmado: true })).json();
      expect(pre.pago.estado).toBe('CONFIRMADO');
      expect((await as(o).post(`/v1/pagos/${randomUUID()}/confirmar`)).statusCode).toBe(404);
    });
  });

  describe('deshacer', () => {
    it('deshacer genera un pago inverso y anula el plan; nunca borra; repetir no duplica', async () => {
      const o = await h.owner('Deshacer');
      const p = await plan(o);
      const c = await customer(o);
      const s = (await sell(o, c, p)).json();
      const key = randomUUID();
      const u = await as(o).post(`/v1/planes-vendidos/${s.id}/deshacer`, { motivo: 'Cliente equivocado' }, key);
      expect(u.statusCode).toBe(200);
      expect(u.json()).toMatchObject({
        estado: 'ANULADA',
        anotacion: 'Cliente equivocado',
        pago: { estado: 'CONFIRMADO', montoCentavos: 1500, reverso: { montoCentavos: -1500 } },
      });
      expect((await as(o).post(`/v1/planes-vendidos/${s.id}/deshacer`, {}, randomUUID())).json().pago.reverso.id).toBe(
        u.json().pago.reverso.id,
      );
      const rows = (await payments(s.id)).rows;
      expect(rows.map((r) => [Number(r.monto_centavos), r.revierte])).toEqual([
        [1500, false],
        [-1500, true],
      ]);
      expect((await as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles).toBe(0);
    });

    it('con almuerzos consumidos no se puede deshacer; un pendiente se rechaza en vez de revertirse; una cartulina se anula', async () => {
      const o = await h.owner('Deshacer Reglas');
      const p = await plan(o);
      const c = await customer(o);
      const s = (await sell(o, c, p)).json();
      await h.db.service((q) =>
        q.query('UPDATE suscripcion_plan SET almuerzos_restantes = almuerzos_restantes - 1 WHERE public_id = $1', [s.id]),
      );
      const blocked = await as(o).post(`/v1/planes-vendidos/${s.id}/deshacer`, {}, randomUUID());
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().detail).toContain('consumieron');

      const t = (await sell(o, c, p, randomUUID(), 'TRANSFERENCIA')).json();
      const ut = (await as(o).post(`/v1/planes-vendidos/${t.id}/deshacer`, {}, randomUUID())).json();
      expect(ut).toMatchObject({ estado: 'ANULADA', pago: { estado: 'RECHAZADO', reverso: null } });

      const venceEl = addDays(await hoy(o), 10);
      const mig = (
        await as(o).post(`/v1/clientes/${c}/migrar-cartulina`, { almuerzosRestantes: 3, venceEl, precioUnitarioCentavos: 300 })
      ).json();
      const migId = mig.planes.find((x: { origen: string }) => x.origen === 'MIGRADA').id;
      expect((await as(o).post(`/v1/planes-vendidos/${migId}/deshacer`, {}, randomUUID())).json()).toMatchObject({
        estado: 'ANULADA',
        pago: null,
      });
      expect((await as(o).post(`/v1/planes-vendidos/${randomUUID()}/deshacer`, {}, randomUUID())).statusCode).toBe(404);
      expect((await as(o).post(`/v1/planes-vendidos/${s.id}/deshacer`, {})).statusCode).toBe(400); // sin Idempotency-Key
    });

    it('el cajero deshace ventas del día, pero no de días anteriores; el dueño sí', async () => {
      const o = await h.owner('Deshacer Cajero');
      const cashier = await h.cashier(o.restaurante);
      const p = await plan(o);
      const c = await customer(o);
      const today = (await sell(cashier, c, p)).json();
      expect((await as(cashier).post(`/v1/planes-vendidos/${today.id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);
      // Una venta de ayer (cargada directo en base: los pagos no se pueden editar).
      const ayer = await h.db.service(async (q) => {
        const s = await q.query<{ public_id: string; suscripcion_id: string; restaurante_id: string }>(
          `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, plantilla_plan_id, nombre_plan, almuerzos_totales, almuerzos_restantes, precio_pagado_centavos,
              precio_unitario_centavos, moneda_codigo, vence_el)
           SELECT r.restaurante_id, $2, $3, 'Semanal', 5, 5, 1500, 300, 'USD', CURRENT_DATE + 5 FROM restaurante r WHERE r.public_id = $1
           RETURNING public_id, suscripcion_id, restaurante_id`,
          [o.restaurante, c, p],
        );
        const row = s.rows[0]!;
        await q.query(
          `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, suscripcion_id, cobrado_por_personal_id, fecha_local, clave_idempotencia)
           SELECT $1, 1, 1500, 'USD', $2, personal_id, (now() AT TIME ZONE 'America/Guayaquil')::date - 1, $3 FROM personal_restaurante WHERE restaurante_id = $1 AND rol = 'DUENO'`,
          [row.restaurante_id, row.suscripcion_id, randomUUID()],
        );
        return row.public_id;
      });
      expect((await as(cashier).post(`/v1/planes-vendidos/${ayer}/deshacer`, {}, randomUUID())).statusCode).toBe(403);
      expect((await as(o).post(`/v1/planes-vendidos/${ayer}/deshacer`, {}, randomUUID())).statusCode).toBe(200);
    });

    it('los pagos son libro de solo inserción: la API no puede borrarlos ni editarlos', async () => {
      await expect(h.db.scope({ tenantId: '1' }, (q) => q.query('DELETE FROM transaccion_pago WHERE false'))).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        h.db.service((q) =>
          q.query(
            "UPDATE transaccion_pago SET monto_centavos = 1 WHERE pago_id = (SELECT min(pago_id) FROM transaccion_pago WHERE estado = 'CONFIRMADO')",
          ),
        ),
      ).rejects.toThrow(/solo se puede confirmar o rechazar/);
    });
  });

  describe('solicitudes de comensales', () => {
    async function activeWithPlan() {
      const o = await h.owner(`Solicitudes ${unique()}`);
      await as(o).patch('/v1/restaurante', { precioSueltoCentavos: 300 });
      await as(o).put('/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '12:00', cierra: '15:00' }] });
      const slug = (await as(o).post('/v1/restaurante/activar')).json().slug as string;
      const visible = await plan(o, { visibleEnMarketplace: true });
      const hidden = await plan(o, { nombre: 'Oculto' });
      return { o, slug, visible, hidden };
    }

    it('el comensal pide un plan visible; se crea su ficha; el local la cobra con idempotencia', async () => {
      const { o, slug, visible, hidden } = await activeWithPlan();
      const d = await h.diner();
      const ask = (planId: string, token = d.token) =>
        h.app.inject({
          method: 'POST',
          url: `/v1/restaurantes/${slug}/solicitudes-plan`,
          remoteAddress: h.ip(),
          headers: { authorization: `Bearer ${token}` },
          payload: { planId },
        });
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: `/v1/restaurantes/${slug}/solicitudes-plan`,
            remoteAddress: h.ip(),
            payload: { planId: visible },
          })
        ).statusCode,
      ).toBe(401);
      expect((await ask(hidden)).statusCode).toBe(404);
      const r = await ask(visible);
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ estado: 'PENDIENTE', plan: 'Semanal' });
      expect((await ask(visible)).statusCode).toBe(409);
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: '/v1/restaurantes/no-existe/solicitudes-plan',
            remoteAddress: h.ip(),
            headers: { authorization: `Bearer ${d.token}` },
            payload: { planId: visible },
          })
        ).statusCode,
      ).toBe(404);

      const list = (await as(o).get('/v1/solicitudes-plan')).json();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ cliente: { nombre: 'Comensal Prueba' }, plan: { id: visible, precioCentavos: 1500 } });
      const key = randomUUID();
      const charged = await as(o).post(`/v1/solicitudes-plan/${list[0].id}/cobrar`, { metodoPago: 'EFECTIVO' }, key);
      expect(charged.statusCode).toBe(200);
      expect(charged.json()).toMatchObject({ estado: 'ACTIVA', pago: { estado: 'CONFIRMADO' }, cliente: { id: list[0].cliente.id } });
      expect((await as(o).post(`/v1/solicitudes-plan/${list[0].id}/cobrar`, { metodoPago: 'EFECTIVO' }, key)).json().id).toBe(
        charged.json().id,
      );
      expect((await as(o).post(`/v1/solicitudes-plan/${list[0].id}/cobrar`, { metodoPago: 'EFECTIVO' }, randomUUID())).json().id).toBe(
        charged.json().id,
      );
      expect((await as(o).post(`/v1/solicitudes-plan/${list[0].id}/rechazar`)).statusCode).toBe(409);
      expect((await as(o).get('/v1/solicitudes-plan')).json()).toEqual([]);
      // La ficha quedó vinculada a la cuenta del comensal.
      expect((await as(o).get(`/v1/clientes/${list[0].cliente.id}`)).json()).toMatchObject({ vinculadoApp: true, almuerzosDisponibles: 5 });
      // Una segunda solicitud reutiliza la misma ficha.
      expect((await ask(visible)).statusCode).toBe(201);
      expect((await as(o).get('/v1/solicitudes-plan')).json()[0].cliente.id).toBe(list[0].cliente.id);
    });

    it('rechazar una solicitud; otro local no la ve ni la cobra', async () => {
      const { o, slug, visible } = await activeWithPlan();
      const other = await h.owner('Solicitudes Otro');
      const d = await h.diner();
      await h.app.inject({
        method: 'POST',
        url: `/v1/restaurantes/${slug}/solicitudes-plan`,
        remoteAddress: h.ip(),
        headers: { authorization: `Bearer ${d.token}` },
        payload: { planId: visible },
      });
      const id = (await as(o).get('/v1/solicitudes-plan')).json()[0].id;
      expect((await as(other).get('/v1/solicitudes-plan')).json()).toEqual([]);
      expect((await as(other).post(`/v1/solicitudes-plan/${id}/cobrar`, { metodoPago: 'EFECTIVO' }, randomUUID())).statusCode).toBe(404);
      expect((await as(other).post(`/v1/solicitudes-plan/${id}/rechazar`)).statusCode).toBe(404);
      expect((await as(o).post(`/v1/solicitudes-plan/${id}/rechazar`)).json()).toEqual({ id, estado: 'RECHAZADA' });
      expect((await as(o).post(`/v1/solicitudes-plan/${id}/cobrar`, { metodoPago: 'EFECTIVO' }, randomUUID())).statusCode).toBe(409);
    });
  });

  it('aislamiento: otro local no deshace ventas ni confirma pagos ajenos', async () => {
    const a = await h.owner('Aislamiento Ventas A');
    const b = await h.owner('Aislamiento Ventas B');
    const p = await plan(a);
    const c = await customer(a);
    const s = (await sell(a, c, p, randomUUID(), 'TRANSFERENCIA')).json();
    expect((await as(b).post(`/v1/planes-vendidos/${s.id}/deshacer`, {}, randomUUID())).statusCode).toBe(404);
    expect((await as(b).post(`/v1/pagos/${s.pago.id}/confirmar`)).statusCode).toBe(404);
    expect((await as(b).get('/v1/pagos/pendientes')).json()).toEqual([]);
    expect((await as(a).get('/v1/pagos/pendientes')).json()).toHaveLength(1);
  });
});
