import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_DAYS, DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const P = 350;
const R = 25;

describe.skipIf(!probe)('PR 3: cotizaciones informativas (pedidos, mesas y validar mesa)', () => {
  const k = new DinerKit(probe!, 97);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Persona = { token: string; usuarioId: string; clienteId?: string };

  const pedir = (who: Persona, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/pedidos', body, key);
  const cotizar = (who: { token?: string }, body: object) => k.as(who).post('/v1/mis/pedidos/cotizar', body);

  /** Plato extra con precio dentro del menú de hoy (publicado). Devuelve su public_id de comensal. */
  async function platoDelMenu(
    o: Local,
    categoria: 'A_LA_CARTA' | 'ALMUERZO',
    nombre: string,
    precioCentavos: number,
    seccion = 'ADICIONAL',
  ) {
    const crear = await k.as(o).post('/v1/menu/platos', { nombre, categoria, seccion, precioCentavos });
    expect(crear.statusCode, crear.body).toBe(201);
    const hoy = (await k.as(o).get('/v1/menu/hoy')).json();
    const items = hoy.items.map((i: { platoId: string; seccion: string }) => ({ platoId: i.platoId, seccion: i.seccion }));
    expect((await k.as(o).post('/v1/menu/hoy/despublicar')).statusCode).toBe(200);
    expect((await k.as(o).put('/v1/menu/hoy', { items: [...items, { platoId: crear.json().id, seccion: 'ADICIONAL' }] })).statusCode).toBe(
      200,
    );
    expect((await k.as(o).post('/v1/menu/hoy/publicar')).statusCode).toBe(200);
    const vitrina = (await k.as({}).get(`/v1/restaurantes/${o.slug}`)).json();
    for (const s of vitrina.menuHoy.secciones) for (const p of s.platos) if (p.nombre === nombre) return p.id as string;
    throw new Error('el plato no salió en la vitrina');
  }

  async function diaDeHoy(o: Local): Promise<number> {
    const r = await probe!.sql<{ d: number }>(
      `SELECT EXTRACT(ISODOW FROM (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria))::int AS d FROM restaurante WHERE public_id = $1`,
      [o.restaurante],
    );
    return r.rows[0]!.d;
  }

  async function filas() {
    const r = await probe!.sql<Record<string, string>>(
      `SELECT (SELECT count(*) FROM orden_cabecera) AS ordenes, (SELECT count(*) FROM orden_detalle) AS detalle,
              (SELECT count(*) FROM consumo_almuerzo) AS consumos, (SELECT count(*) FROM intento_escaneo) AS intentos,
              (SELECT count(*) FROM transaccion_pago) AS pagos, (SELECT coalesce(sum(almuerzos_restantes), 0) FROM suscripcion_plan) AS saldo`,
    );
    return r.rows[0];
  }

  // --------------------------------------------------------------------------------------------------------------

  describe('POST /v1/mis/pedidos/cotizar', () => {
    it('no escribe nada: ni pedido, ni número del día, ni consumo del plan; 200 sin Idempotency-Key', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const d = await k.dinerWithPlan(o);
      const antes = await filas();

      const body = {
        restaurante: o.restaurante,
        almuerzo: { platos: [ids['Sopa de quinua']!, ids['Seco de pollo']!] },
        extras: [{ plato: ids['Huevo frito']!, cantidad: 2 }],
        paraLlevar: true,
      };
      const r = await cotizar(d, body);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        estimada: true,
        monedaCodigo: 'USD',
        subtotalCentavos: P + 150,
        recargoCentavos: R,
        totalCentavos: P + 150 + R,
        cubiertoPorPlanCentavos: P, // el plan del comensal cubre el almuerzo
        saldoPorCobrarCentavos: 150 + R,
        avisos: [],
      });
      expect(r.json()).not.toHaveProperty('unidadesPlan');
      expect(r.json().lineas.map((l: { tipo: string; fuente: string }) => [l.tipo, l.fuente])).toEqual([
        ['ALMUERZO', 'PLAN'],
        ['EXTRA', 'CAJA'],
      ]);
      expectOnlyPublicIds(r.json());

      // Repetirlo da lo mismo y sigue sin escribir.
      expect((await cotizar(d, body)).json()).toEqual(r.json());
      expect(await filas()).toEqual(antes);

      // Pedir de verdad: es el pedido #1 (la cotización no tomó número) y su total es lo que cotizó.
      const real = await pedir(d, body);
      expect(real.statusCode, real.body).toBe(201);
      expect(real.json()).toMatchObject({ numero: 1, totalCentavos: 150 + R });
      expect(real.json().cotizacion.saldoPorCobrarCentavos).toBe(r.json().saldoPorCobrarCentavos);
      expect(real.json().cotizacion.recargoCentavos).toBe(r.json().recargoCentavos);
      // Con el snapshot de P (PR 5a, INC-06) la cotización del pedido creado es la misma que la de cotizar: el almuerzo
      // vale P y lo cubre el plan (antes salía a 0 con `cubierto` 0).
      expect(real.json().cotizacion).toMatchObject({ subtotalCentavos: P + 150, cubiertoPorPlanCentavos: P });
      expect(real.json().cotizacion.lineas).toEqual(r.json().lineas);
    });

    it('mismos errores de validación que crear pedido', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const sinMenu = await k.activeOwner(); // local activo sin menú publicado
      const d = await k.diner();
      const casos: [string, object][] = [
        ['pedido vacío', { restaurante: o.restaurante }],
        ['restaurante inexistente', { restaurante: randomUUID(), almuerzo: { platos: [ids['Sopa de quinua']!] } }],
        ['restaurante no es uuid', { restaurante: 'x', almuerzo: { platos: [ids['Sopa de quinua']!] } }],
        ['plato que no está en el menú', { restaurante: o.restaurante, almuerzo: { platos: [randomUUID()] } }],
        [
          'dos fuertes en el almuerzo',
          { restaurante: o.restaurante, almuerzo: { platos: [ids['Seco de pollo']!, ids['Menestra con carne']!] } },
        ],
        ['extra sin precio', { restaurante: o.restaurante, extras: [{ plato: ids['Sopa de quinua']!, cantidad: 1 }] }],
        ['cantidad fuera de rango', { restaurante: o.restaurante, extras: [{ plato: ids['Cola']!, cantidad: 11 }] }],
        ['menú no publicado', { restaurante: sinMenu.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } }],
      ];
      for (const [nombre, body] of casos) {
        const q = await cotizar(d, body);
        const c = await pedir(d, body);
        expect(q.statusCode, `${nombre}: ${q.body}`).toBe(c.statusCode);
        expect(q.statusCode, nombre).toBeGreaterThanOrEqual(400);
        expect(q.json().code, nombre).toBe(c.json().code);
      }
    });

    it('un pedido en camino bloquea igual que al crear; el local pausado también; sin token 401', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const d = await k.diner();
      const body = { restaurante: o.restaurante, extras: [{ plato: ids['Cola']!, cantidad: 1 }] };
      expect((await pedir(d, body)).statusCode).toBe(201);
      const q = await cotizar(d, body);
      expect(q.statusCode).toBe(409);
      expect(q.json().code).toBe('PEDIDO_ACTIVO');
      expect((await cotizar({}, body)).statusCode).toBe(401);

      const otro = await k.diner();
      expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
      const p = await cotizar(otro, body);
      expect(p.statusCode).toBe(409);
      expect(p.json().code).toBe('RESTAURANTE_PAUSADO');
    });

    it('plan sin saldo: el almuerzo va a caja', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const d = await k.dinerWithPlan(o, { almuerzos: 1 });
      await k.lunch(o, d.clienteId); // gasta el único almuerzo
      const r = await cotizar(d, { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ cubiertoPorPlanCentavos: 0, saldoPorCobrarCentavos: P });
      expect(r.json().lineas[0]).toMatchObject({ fuente: 'CAJA', porCobrarCentavos: P });
      // Es lo mismo que cobraría el pedido de verdad.
      expect((await pedir(d, { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } })).json().totalCentavos).toBe(P);
    });

    it('plan en un día no válido: el almuerzo va a caja (y coincide con el pedido real)', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const hoy = await diaDeHoy(o);
      const d = await k.dinerWithPlan(o, { diasValidos: ALL_DAYS.filter((x) => x !== hoy) });
      const body = { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } };
      const r = await cotizar(d, body);
      expect(r.json()).toMatchObject({ cubiertoPorPlanCentavos: 0, saldoPorCobrarCentavos: P });
      expect(r.json().lineas[0].fuente).toBe('CAJA');
      expect((await pedir(d, body)).json().totalCentavos).toBe(P);
    });
  });

  // --------------------------------------------------------------------------------------------------------------

  describe('cotizacion en las respuestas de pedidos', () => {
    it('POST, GET lista, GET uno y las vistas de caja traen cotizacion; totalCentavos y recargo siguen con la regla de hoy', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const cajero = await k.h.cashier(o.restaurante);

      // [descripción, plan?, cuerpo, total de hoy, recargo de hoy]
      const tabla: [string, boolean, object, number, number][] = [
        ['almuerzo sin plan', false, { almuerzo: { platos: [ids['Sopa de quinua']!] } }, P, 0],
        [
          'almuerzo + huevo para llevar, sin plan',
          false,
          { almuerzo: { platos: [ids['Sopa de quinua']!] }, extras: [{ plato: ids['Huevo frito']!, cantidad: 1 }], paraLlevar: true },
          P + 75 + R,
          R,
        ],
        [
          'solo bebida para llevar (los extras no pagan recargo)',
          false,
          { extras: [{ plato: ids['Cola']!, cantidad: 2 }], paraLlevar: true },
          200,
          0,
        ],
        ['almuerzo con plan, para llevar', true, { almuerzo: { platos: [ids['Seco de pollo']!] }, paraLlevar: true }, R, R],
        [
          'almuerzo con plan + cola',
          true,
          { almuerzo: { platos: [ids['Seco de pollo']!] }, extras: [{ plato: ids['Cola']!, cantidad: 1 }] },
          100,
          0,
        ],
      ];
      for (const [nombre, conPlan, cuerpo, total, recargo] of tabla) {
        const d = conPlan ? await k.dinerWithPlan(o) : await k.diner();
        const r = await pedir(d, { restaurante: o.restaurante, ...cuerpo });
        expect(r.statusCode, `${nombre}: ${r.body}`).toBe(201);
        const p = r.json();
        expect(p.totalCentavos, nombre).toBe(total);
        expect(p.recargoLlevarCentavos, nombre).toBe(recargo);
        // En estos casos la cotización coincide con el total de hoy.
        expect(p.cotizacion, nombre).toMatchObject({
          estimada: true,
          monedaCodigo: 'USD',
          saldoPorCobrarCentavos: total,
          recargoCentavos: recargo,
        });
        expect(p.almuerzo === null || p.almuerzo.precioCentavos === (conPlan ? 0 : P), nombre).toBe(true);
        expectOnlyPublicIds(p);

        // Las lecturas devuelven lo mismo que el POST.
        const uno = (await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json();
        expect(uno.cotizacion, nombre).toEqual(p.cotizacion);
        const lista = (await k.as(d).get('/v1/mis/pedidos')).json().items;
        expect(lista[0].cotizacion, nombre).toEqual(p.cotizacion);
        expect(lista[0].totalCentavos).toBe(total);
        // Caja: el pedido (uno y lista) también.
        const caja = (await k.as(cajero).get(`/v1/caja/pedidos/${p.id}`)).json();
        expect(caja.cotizacion, nombre).toEqual(p.cotizacion);
        expect(caja.totalCentavos).toBe(total);
        const enLista = (await k.as(cajero).get('/v1/caja/pedidos?estado=TODOS')).json().find((x: { id: string }) => x.id === p.id);
        expect(enLista.cotizacion, nombre).toEqual(p.cotizacion);
        // Cancelar el pedido deja al comensal pedir otro y no rompe la respuesta.
        const c = await k.as(d).post(`/v1/mis/pedidos/${p.id}/cancelar`);
        expect(c.json().cotizacion).toBeDefined();
      }
    });

    it('canjear: el pedido canjeado conserva la cotización (cubierto por plan) y el cobro de hoy no cambia', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const d = await k.dinerWithPlan(o, { almuerzos: 1 });
      const p = (
        await pedir(d, {
          restaurante: o.restaurante,
          almuerzo: { platos: [ids['Sopa de quinua']!] },
          extras: [{ plato: ids['Cola']!, cantidad: 1 }],
        })
      ).json();
      expect(p.cotizacion.saldoPorCobrarCentavos).toBe(100);
      const canje = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, undefined, randomUUID());
      expect(canje.statusCode, canje.body).toBe(200);
      expect(canje.json()).toMatchObject({ porCobrarCentavos: 100, almuerzo: { descontado: true } });
      // El plan se gastó en el canje; la cotización del pedido mira el consumo del pedido (no el plan de hoy, que ya está
      // en 0): sigue cubierto, ahora con el precio guardado (snapshot de P).
      expect(canje.json().pedido.cotizacion).toMatchObject({
        saldoPorCobrarCentavos: 100,
        cubiertoPorPlanCentavos: 350,
        subtotalCentavos: 450,
      });
      // La cotización final del canje dice lo mismo.
      expect(canje.json().cotizacion).toMatchObject({ estimada: false, saldoPorCobrarCentavos: 100, cubiertoPorPlanCentavos: 350 });
      // Desde el PR 6c, sin `cobro` y con saldo > 0 (la Cola) el canje abre la cuenta ABIERTA con ese saldo.
      expect(canje.json().cuenta).toMatchObject({ origen: 'PEDIDO', estado: 'ABIERTA', saldoCentavos: 100 });
      expect(canje.json().pedido.totalCentavos).toBe(100);
    });

    it('DIVERGENCIA CONOCIDA (cambia en el PR 7): un extra A_LA_CARTA del menú para llevar paga recargo en la cotización pero no en totalCentavos', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const ceviche = await platoDelMenu(o, 'A_LA_CARTA', 'Ceviche', 600);
      const cajero = await k.h.cashier(o.restaurante);

      // Con almuerzo: hoy un solo recargo (el del almuerzo); la cotización suma uno por unidad (almuerzo + ceviche).
      const a = (
        await pedir(await k.diner(), {
          restaurante: o.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [ids['Sopa de quinua']!] },
          extras: [{ plato: ceviche, cantidad: 1 }],
        })
      ).json();
      expect(a).toMatchObject({ totalCentavos: P + 600 + R, recargoLlevarCentavos: R });
      expect(a.cotizacion).toMatchObject({
        recargoCentavos: 2 * R,
        totalCentavos: P + 600 + 2 * R,
        saldoPorCobrarCentavos: P + 600 + 2 * R,
      });
      expect(a.cotizacion.saldoPorCobrarCentavos - a.totalCentavos).toBe(R);
      expect(a.cotizacion.lineas.find((l: { tipo: string }) => l.tipo === 'A_LA_CARTA')).toMatchObject({
        recargoUnitarioCentavos: R,
        cantidad: 1,
      });
      // Las vistas de caja dicen lo mismo que el comensal.
      expect((await k.as(cajero).get(`/v1/caja/pedidos/${a.id}`)).json().cotizacion).toEqual(a.cotizacion);

      // Solo el plato a la carta: hoy sin recargo; la cotización cobra uno por unidad.
      const b = (
        await pedir(await k.diner(), { restaurante: o.restaurante, paraLlevar: true, extras: [{ plato: ceviche, cantidad: 2 }] })
      ).json();
      expect(b).toMatchObject({ totalCentavos: 1200, recargoLlevarCentavos: 0 });
      expect(b.cotizacion).toMatchObject({ recargoCentavos: 2 * R, saldoPorCobrarCentavos: 1200 + 2 * R });

      // Sin llevar no hay diferencia.
      const c = (await pedir(await k.diner(), { restaurante: o.restaurante, extras: [{ plato: ceviche, cantidad: 1 }] })).json();
      expect(c.cotizacion.saldoPorCobrarCentavos).toBe(c.totalCentavos);
    });

    it('un plato ALMUERZO pedido suelto se mapea por sección: el fuerte paga recargo (diverge hasta el PR 7); jugo y postre no', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const fuerte = await platoDelMenu(o, 'ALMUERZO', 'Seco aparte', 500, 'FUERTE');
      const jugo = await platoDelMenu(o, 'ALMUERZO', 'Jugo aparte', 200, 'JUGO');
      const postre = await platoDelMenu(o, 'ALMUERZO', 'Postre aparte', 250, 'POSTRE');
      const pedido = async (plato: string) =>
        (await pedir(await k.diner(), { restaurante: o.restaurante, paraLlevar: true, extras: [{ plato, cantidad: 1 }] })).json();

      const f = await pedido(fuerte);
      expect(f).toMatchObject({ totalCentavos: 500, recargoLlevarCentavos: 0 });
      expect(f.cotizacion).toMatchObject({ recargoCentavos: R, saldoPorCobrarCentavos: 500 + R });
      expect(f.cotizacion.lineas[0].tipo).toBe('A_LA_CARTA');

      for (const [plato, tipo, total] of [
        [jugo, 'BEBIDA', 200],
        [postre, 'EXTRA', 250],
      ] as const) {
        const r = await pedido(plato);
        expect(r.cotizacion.lineas[0].tipo).toBe(tipo);
        expect(r.cotizacion).toMatchObject({ recargoCentavos: 0, saldoPorCobrarCentavos: total });
        expect(r.totalCentavos).toBe(total); // sin divergencia
      }
    });
  });

  // --------------------------------------------------------------------------------------------------------------

  describe('roles y tenant ajeno', () => {
    it('el pedido de un comensal: otro comensal 404; personal del local sí; personal de otro local 404; un comensal no entra a caja', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const ajeno = await k.activeOwner();
      await k.menu(ajeno);
      const cajero = await k.h.cashier(o.restaurante);
      const d = await k.diner();
      const p = (await pedir(d, { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } })).json();

      expect((await k.as(await k.diner()).get(`/v1/mis/pedidos/${p.id}`)).statusCode).toBe(404);
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(200);
      expect((await k.as(cajero).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(200);
      expect((await k.as(ajeno).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(404);
      const otroLista = (await k.as(ajeno).get('/v1/caja/pedidos?estado=TODOS')).json();
      expect(otroLista).toEqual([]);
      expect((await k.as({ token: d.token, restaurante: o.restaurante }).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(403);
      expect((await k.as({}).get(`/v1/caja/pedidos/${p.id}`)).statusCode).toBe(401);
    });

    it('la mesa: caja de otro local 404, un comensal ajeno 404, un comensal no entra a la vista de caja', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const ajeno = await k.activeOwner();
      const host = await k.diner();
      const mesa = (
        await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30) }, randomUUID())
      ).json();
      expect((await k.as(o).get(`/v1/caja/mesas/${mesa.id}`)).statusCode).toBe(200);
      expect((await k.as(ajeno).get(`/v1/caja/mesas/${mesa.id}`)).statusCode).toBe(404);
      expect((await k.as(ajeno).post(`/v1/caja/mesas/${mesa.id}/validar`, undefined, randomUUID())).statusCode).toBe(404);
      expect((await k.as(await k.diner()).get(`/v1/mis/mesas/${mesa.id}`)).statusCode).toBe(404);
      expect((await k.as({ token: host.token, restaurante: o.restaurante }).get(`/v1/caja/mesas/${mesa.id}`)).statusCode).toBe(403);
    });
  });

  // --------------------------------------------------------------------------------------------------------------

  describe('mesas: visibilidad de la cotización', () => {
    async function mesa(o: Local, modo: 'CADA_UNO' | 'INVITO_YO') {
      const host = await k.dinerWithPlan(o);
      const guest = await k.dinerWithPlan(o);
      const sinPlan = await k.diner();
      const m = (
        await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30), modo }, randomUUID())
      ).json();
      expect((await k.as(guest).post(`/v1/mesas/invitacion/${m.id}/unirse`, { paraLlevar: true }, randomUUID())).statusCode).toBe(200);
      expect((await k.as(sinPlan).post(`/v1/mesas/invitacion/${m.id}/unirse`, {}, randomUUID())).statusCode).toBe(200);
      return { id: m.id as string, host, guest, sinPlan };
    }
    type M = { esAnfitrion: boolean; soyYo?: boolean; paraLlevar: boolean; cotizacion: Record<string, number> | null };
    const resumen = (ms: M[]) => ms.map((m) => (m.cotizacion ? m.cotizacion.saldoPorCobrarCentavos : null));

    it('CADA_UNO: cada quien ve la suya; la caja ve todas y la de la mesa', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const { id, host, guest, sinPlan } = await mesa(o, 'CADA_UNO');

      // Caja: todo (host con plan: 0; guest con plan y para llevar: 25; sin plan: 350).
      const caja = (await k.as(o).get(`/v1/caja/mesas/${id}`)).json();
      expect(resumen(caja.miembros)).toEqual([0, R, P]);
      expect(caja.cotizacion).toMatchObject({
        estimada: true,
        subtotalCentavos: 3 * P,
        recargoCentavos: R,
        cubiertoPorPlanCentavos: 2 * P,
        saldoPorCobrarCentavos: R + P,
      });
      expectOnlyPublicIds(caja);

      // Invitado: solo la suya (misma visibilidad que `seleccion`); la de la mesa, no.
      const g = (await k.as(guest).get(`/v1/mis/mesas/${id}`)).json();
      expect(g.miembros.map((m: M) => [m.esAnfitrion, m.cotizacion !== null, m.seleccion !== null])).toEqual([
        [true, false, false],
        [false, true, true],
        [false, false, false],
      ]);
      expect(g.miembros[1].cotizacion).toEqual(caja.miembros[1].cotizacion);
      expect(g.cotizacion).toBeNull();

      // Quien no tiene plan: su cotización (350, sin saldo de plan) también se ve solo para él.
      const s = (await k.as(sinPlan).get(`/v1/mis/mesas/${id}`)).json();
      expect(resumen(s.miembros)).toEqual([null, null, P]);

      // Anfitrión: ve las selecciones y las cotizaciones de todos y la de la mesa, iguales a las de la caja. Del plan de
      // cada invitado solo obtiene cuántos almuerzos cubre hoy (fn_plan_pagador_mesa, PR 6); antes eran null.
      const h = (await k.as(host).get(`/v1/mis/mesas/${id}`)).json();
      expect(h.miembros.every((m: M & { seleccion: unknown }) => m.seleccion !== null)).toBe(true);
      expect(resumen(h.miembros)).toEqual([0, R, P]);
      expect(h.miembros.map((m: M) => m.cotizacion)).toEqual(caja.miembros.map((m: M) => m.cotizacion));
      expect(h.cotizacion).toEqual(caja.cotizacion);
    });

    it('INVITO_YO: el anfitrión ve todas y la de la mesa; un invitado ve la suya con el plan del anfitrión', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const { id, host, guest } = await mesa(o, 'INVITO_YO');

      // El plan del anfitrión (5 almuerzos) cubre a los tres.
      const caja = (await k.as(o).get(`/v1/caja/mesas/${id}`)).json();
      expect(resumen(caja.miembros)).toEqual([0, R, 0]);
      expect(caja.miembros.map((m: { cotizacion: { lineas: { pagador: string }[] } }) => m.cotizacion.lineas[0]!.pagador)).toEqual([
        'PROPIO',
        'ANFITRION',
        'ANFITRION',
      ]);
      expect(caja.cotizacion).toMatchObject({ cubiertoPorPlanCentavos: 3 * P, recargoCentavos: R, saldoPorCobrarCentavos: R });
      expect(caja.cotizacion.porPagador).toHaveLength(1);

      const h = (await k.as(host).get(`/v1/mis/mesas/${id}`)).json();
      expect(h.miembros.map((m: M) => m.cotizacion)).toEqual(caja.miembros.map((m: M) => m.cotizacion));
      expect(h.cotizacion).toEqual(caja.cotizacion);

      const g = (await k.as(guest).get(`/v1/mis/mesas/${id}`)).json();
      expect(g.miembros.map((m: M) => m.cotizacion)).toEqual([null, caja.miembros[1].cotizacion, null]);
      expect(g.cotizacion).toBeNull();
    });

    it('la selección cambia la cotización: se cotiza lo elegido; sin selección cuenta 1 almuerzo', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const { id, guest, sinPlan } = await mesa(o, 'CADA_UNO');
      // El invitado sin plan pide solo dos colas: ningún almuerzo.
      expect(
        (await k.as(sinPlan).put(`/v1/mis/mesas/${id}/seleccion`, { extras: [{ plato: ids['Cola']!, cantidad: 2 }] })).statusCode,
      ).toBe(200);
      // El invitado con plan pide almuerzo y un huevo.
      expect(
        (
          await k.as(guest).put(`/v1/mis/mesas/${id}/seleccion`, {
            almuerzo: { platos: [ids['Sopa de quinua']!] },
            extras: [{ plato: ids['Huevo frito']!, cantidad: 1 }],
          })
        ).statusCode,
      ).toBe(200);
      const caja = (await k.as(o).get(`/v1/caja/mesas/${id}`)).json();
      expect(resumen(caja.miembros)).toEqual([0, R + 75, 200]); // host sin selección: 1 almuerzo cubierto
      expect(caja.miembros[2].cotizacion.lineas.map((l: { tipo: string }) => l.tipo)).toEqual(['BEBIDA']);
      expect(caja.cotizacion.saldoPorCobrarCentavos).toBe(R + 75 + 200);
      // Un invitado ve su propia cotización con su selección.
      const g = (await k.as(guest).get(`/v1/mis/mesas/${id}`)).json();
      expect(g.miembros[1].cotizacion).toEqual(caja.miembros[1].cotizacion);
    });

    it('plan en día no válido: la cotización lo cobra y cubiertos / almuerzosDisponibles dejan de contarlo (INC-12)', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const hoy = await diaDeHoy(o);
      const valido = await k.dinerWithPlan(o);
      const noValido = await k.dinerWithPlan(o, { diasValidos: ALL_DAYS.filter((d) => d !== hoy) });
      const m = (await k.as(valido).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30) }, randomUUID())).json();
      expect((await k.as(noValido).post(`/v1/mesas/invitacion/${m.id}/unirse`, {}, randomUUID())).statusCode).toBe(200);

      const caja = (await k.as(o).get(`/v1/caja/mesas/${m.id}`)).json();
      expect(caja.cubiertos).toBe(1); // antes de INC-12 eran 2
      expect(caja.miembros.map((x: { almuerzosDisponibles: number }) => x.almuerzosDisponibles)).toEqual([5, 0]);
      expect(resumen(caja.miembros)).toEqual([0, P]);
      expect(caja.miembros[1].cotizacion.lineas[0]).toMatchObject({ fuente: 'CAJA' });
      // Y lo que la caja cobra al validar coincide: el segundo miembro queda sin descontar.
      const v = (await k.as(o).post(`/v1/caja/mesas/${m.id}/validar`, undefined, randomUUID())).json();
      expect(v.resultados.map((x: { resultado: string }) => x.resultado)).toEqual(['OK', 'DIA_NO_VALIDO']);
    });

    it('caja: el pedido de un cliente con plan en día no válido muestra almuerzosDisponibles 0 (INC-12)', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const hoy = await diaDeHoy(o);
      const d = await k.dinerWithPlan(o, { diasValidos: ALL_DAYS.filter((x) => x !== hoy) });
      const p = (await pedir(d, { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } })).json();
      const caja = (await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json();
      expect(caja.cliente.almuerzosDisponibles).toBe(0);
      expect(caja.cotizacion.saldoPorCobrarCentavos).toBe(P);
      // Control: con un plan que vale hoy, 5.
      const e = await k.dinerWithPlan(o);
      expect((await k.as(e).post(`/v1/mis/pedidos/${p.id}/cancelar`)).statusCode).toBe(404); // no es suyo
      await k.as(d).post(`/v1/mis/pedidos/${p.id}/cancelar`);
      const p2 = (await pedir(e, { restaurante: o.restaurante, almuerzo: { platos: [ids['Sopa de quinua']!] } })).json();
      expect((await k.as(o).get(`/v1/caja/pedidos/${p2.id}`)).json().cliente.almuerzosDisponibles).toBe(5);
    });
  });

  // --------------------------------------------------------------------------------------------------------------

  describe('POST /v1/caja/mesas/{id}/validar con aplicarSeleccion false: cotizacion informativa (E.5)', () => {
    it('trae la cotización de 1 almuerzo por miembro con su paraLlevar y no cambia descuentos ni porCobrar', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const host = await k.dinerWithPlan(o);
      const guest = await k.dinerWithPlan(o);
      const sinPlan = await k.diner();
      const m = (await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30) }, randomUUID())).json();
      await k.as(guest).post(`/v1/mesas/invitacion/${m.id}/unirse`, { paraLlevar: true }, randomUUID());
      await k.as(sinPlan).post(`/v1/mesas/invitacion/${m.id}/unirse`, {}, randomUUID());
      // La selección del tercero (solo una cola) NO entra en la informativa de validar: E.5 literal, 1 almuerzo cada uno.
      await k.as(sinPlan).put(`/v1/mis/mesas/${m.id}/seleccion`, { extras: [{ plato: ids['Cola']!, cantidad: 1 }] });
      const previa = (await k.as(o).get(`/v1/caja/mesas/${m.id}`)).json();
      expect(previa.miembros[2].cotizacion.lineas.map((l: { tipo: string }) => l.tipo)).toEqual(['BEBIDA']);

      const saldoAntes = (await filas())!.saldo;
      const key = randomUUID();
      // aplicarSeleccion: false = lo de antes del PR 6 (1 almuerzo por miembro, sin cuentas).
      const legacy = { aplicarSeleccion: false };
      const r = await k.as(o).post(`/v1/caja/mesas/${m.id}/validar`, legacy, key);
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json();
      // Lo de siempre.
      expect(v).toMatchObject({ yaValidada: false, descontados: 2, porCobrar: 1, estado: 'EN_MESA' });
      expect(v.resultados.map((x: { resultado: string }) => x.resultado)).toEqual(['OK', 'OK', 'SIN_PLAN']);
      expect(Number((await filas())!.saldo)).toBe(Number(saldoAntes) - 2);
      // Lo nuevo: un almuerzo por miembro, con el plan de ANTES de descontar y su paraLlevar.
      expect(v.cotizacion).toMatchObject({
        estimada: true,
        subtotalCentavos: 3 * P,
        recargoCentavos: R,
        cubiertoPorPlanCentavos: 2 * P,
        saldoPorCobrarCentavos: R + P,
        monedaCodigo: 'USD',
      });
      expect(v.cotizacion.lineas.map((l: { tipo: string; fuente: string }) => [l.tipo, l.fuente])).toEqual([
        ['ALMUERZO', 'PLAN'],
        ['ALMUERZO', 'PLAN'],
        ['ALMUERZO', 'CAJA'],
      ]);
      expect(v.miembros.map((x: { cotizacion: { saldoPorCobrarCentavos: number } }) => x.cotizacion.saldoPorCobrarCentavos)).toEqual([
        0,
        R,
        P,
      ]);

      // Reintento (misma clave y otra): sigue sin descontar y reconstruye la misma cotización desde la base.
      for (const kk of [key, randomUUID()]) {
        const again = (await k.as(o).post(`/v1/caja/mesas/${m.id}/validar`, legacy, kk)).json();
        expect(again).toMatchObject({ yaValidada: true, resultados: [] });
        expect(again.cotizacion).toEqual(v.cotizacion);
        expect(again.miembros.map((x: { cotizacion: unknown }) => x.cotizacion)).toEqual(
          v.miembros.map((x: { cotizacion: unknown }) => x.cotizacion),
        );
      }
      expect(Number((await filas())!.saldo)).toBe(Number(saldoAntes) - 2);
    });

    it('INVITO_YO: la informativa reparte el plan del anfitrión y avisa PLAN_NO_ALCANZA; porCobrar sigue siendo el de hoy', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const host = await k.dinerWithPlan(o, { almuerzos: 2, vigenciaDias: 30 });
      const m = (
        await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30), modo: 'INVITO_YO' }, randomUUID())
      ).json();
      for (let i = 0; i < 2; i++) await k.as(await k.diner()).post(`/v1/mesas/invitacion/${m.id}/unirse`, {}, randomUUID());
      const v = (await k.as(o).post(`/v1/caja/mesas/${m.id}/validar`, { aplicarSeleccion: false }, randomUUID())).json();
      expect(v).toMatchObject({ descontados: 2, porCobrar: 1 });
      expect(v.cotizacion).toMatchObject({ cubiertoPorPlanCentavos: 2 * P, saldoPorCobrarCentavos: P });
      expect(v.cotizacion.avisos).toEqual([expect.objectContaining({ codigo: 'PLAN_NO_ALCANZA' })]);
      expect(v.cotizacion.porPagador).toHaveLength(1);
    });
  });
});
