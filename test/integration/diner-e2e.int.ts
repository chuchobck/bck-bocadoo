import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * Recorridos completos del comensal sobre la API real (fases 5 a 8 juntas), con el patrón probe: al terminar cada
 * prueba la base queda como estaba.
 */
describe.skipIf(!probe)('Fase 8 de punta a punta: el comensal', () => {
  const k = new DinerKit(probe!, 90);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  it('un día completo: pide su plan en la vitrina, preordena, canjea en caja, gana un sello, opina, recibe respuesta y reclama', async () => {
    // El dueño arma su local: activo, menú publicado, plan visible y tarjeta de sellos.
    const o = await k.activeOwner('Doña Rosa E2E');
    const menu = await k.menu(o);
    const planId = await k.plan(o, { nombre: 'Semanal vitrina', visibleEnMarketplace: true });
    await k.as(o).put('/v1/sellos/config', { activa: true, meta: 5, premio: 'Postre gratis' });
    const cashier = await k.h.cashier(o.restaurante);

    // El comensal se registra, ve el local en la vitrina y pide el plan; el cajero lo cobra.
    const d = await k.diner();
    const vitrina = (await k.as({}).get(`/v1/restaurantes/${o.slug}`)).json();
    expect(vitrina.planes.map((p: { id: string }) => p.id)).toContain(planId);
    expect((await k.as(d).post(`/v1/restaurantes/${o.slug}/solicitudes-plan`, { planId })).statusCode).toBe(201);
    const sol = (await k.as(cashier).get('/v1/solicitudes-plan')).json()[0];
    expect((await k.as(cashier).post(`/v1/solicitudes-plan/${sol.id}/cobrar`, { metodoPago: 'EFECTIVO' }, randomUUID())).statusCode).toBe(
      200,
    );

    // Su pase ya muestra el plan y el QR rotativo.
    const pase = (await k.as(d).get('/v1/pase')).json();
    expect(pase.locales).toEqual([expect.objectContaining({ almuerzosDisponibles: 5 })]);
    expectOnlyPublicIds(pase);
    expect((await k.as(d).get('/v1/mis/sellos')).json()[0]).toMatchObject({ sellos: 0, faltan: 5, premio: 'Postre gratis' });

    // Preordena el almuerzo (cubierto por el plan) más una cola.
    const pedido = (
      await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: o.restaurante,
          almuerzo: { platos: [menu['Sopa de quinua'], menu['Seco de pollo']] },
          extras: [{ plato: menu.Cola, cantidad: 1 }],
        },
        randomUUID(),
      )
    ).json();
    expect(pedido).toMatchObject({ estado: 'EN_CAMINO', almuerzo: { cubiertoPorPlan: true }, totalCentavos: 100 });

    // La caja ve el pedido, escanea su QR y lo canjea: descuenta del plan y cobra la cola aparte.
    expect((await k.as(cashier).get('/v1/caja/pedidos')).json().map((p: { id: string }) => p.id)).toEqual([pedido.id]);
    const canje = (await k.as(cashier).post(`/v1/caja/pedidos/${pedido.qr}/canjear`, {}, randomUUID())).json();
    expect(canje).toMatchObject({ almuerzo: { resultado: 'OK', descontado: true }, porCobrarCentavos: 100 });
    await k.as(cashier).post(`/v1/caja/pedidos/${pedido.id}/servir`);
    const consumo = canje.almuerzo.consumoId as string;

    // El comensal ve su almuerzo, su saldo y su sello.
    expect((await k.as(d).get('/v1/mis/consumos')).json().items).toEqual([expect.objectContaining({ id: consumo, canal: 'PREORDEN' })]);
    expect((await k.as(d).get('/v1/pase')).json().locales[0].almuerzosDisponibles).toBe(4);
    expect((await k.as(d).get('/v1/mis/sellos')).json()[0]).toMatchObject({ sellos: 1, faltan: 4 });
    expect((await k.as(d).get(`/v1/mis/pedidos/${pedido.id}`)).json().estado).toBe('SERVIDA');

    // 25 minutos después aparece "¿Qué tal hoy?": opina y el dueño responde.
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json()).toEqual([]);
    await k.backdateLunch(consumo, 26);
    expect((await k.as(d).get('/v1/mis/opiniones/pendientes')).json().map((p: { consumo: { id: string } }) => p.consumo.id)).toEqual([
      consumo,
    ]);
    await k.as(d).post(`/v1/mis/consumos/${consumo}/opinion`, { etiquetas: ['FRIO'], comentario: 'El seco llegó frío.' }, randomUUID());
    const inbox = (await k.as(o).get('/v1/opiniones?estado=SIN_RESPONDER')).json();
    expect(inbox.items).toEqual([expect.objectContaining({ id: consumo, comentario: 'El seco llegó frío.' })]);
    await k.as(o).post(`/v1/opiniones/${consumo}/responder`, { respuesta: 'Perdón, ya lo corregimos.' });
    expect((await k.as(d).get('/v1/mis/opiniones')).json()[0].respuesta.texto).toBe('Perdón, ya lo corregimos.');

    // Reclama; el dueño lo acepta: el almuerzo vuelve al plan y el sello se quita.
    await k.as(d).post(`/v1/mis/consumos/${consumo}/reclamo`, { mensaje: 'Me lo sirvieron frío, no lo comí.' }, randomUUID());
    const reclamo = (await k.as(o).get('/v1/reclamos')).json()[0];
    await k.as(o).post(`/v1/reclamos/${reclamo.id}/devolver`, { respuesta: 'Te devolvimos el almuerzo.' });
    expect((await k.as(d).get('/v1/mis/reclamos')).json()[0]).toMatchObject({ estado: 'DEVUELTO' });
    expect((await k.as(d).get('/v1/pase')).json().locales[0].almuerzosDisponibles).toBe(5);
    expect((await k.as(d).get('/v1/mis/sellos')).json()[0]).toMatchObject({ sellos: 0 });
    expect((await k.as(d).get(`/v1/mis/consumos/${consumo}`)).json().revertido).toBe(true);
  });

  it('mesa compartida "invito yo": el anfitrión invita por link, el amigo valida el link y se une, la caja cobra todo al anfitrión', async () => {
    const o = await k.activeOwner('Mesa E2E');
    const host = await k.dinerWithPlan(o);
    const friend = await k.diner();
    const mesa = (
      await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(20), modo: 'INVITO_YO' }, randomUUID())
    ).json();
    const link = mesa.invitacion as string;
    const inv = (await k.as(friend).get(`/v1/mesas/invitacion/${link}`)).json();
    expect(inv).toMatchObject({ puedeUnirse: true, modo: 'INVITO_YO', restaurante: { id: o.restaurante } });
    await k.as(friend).post(`/v1/mesas/invitacion/${link}/unirse`, {}, randomUUID());
    expect((await k.as(host).get(`/v1/mis/mesas/${mesa.id}`)).json().miembros).toHaveLength(2);

    const v = (await k.as(o).post(`/v1/caja/mesas/${mesa.id}/validar`, {}, randomUUID())).json();
    expect(v).toMatchObject({ descontados: 2, porCobrar: 0 });
    expect((await k.as(host).get('/v1/pase')).json().locales[0].almuerzosDisponibles).toBe(3);
    expect((await k.as(host).get('/v1/mis/consumos')).json().items).toHaveLength(2);
    expect((await k.as(friend).get('/v1/mis/consumos')).json().items).toEqual([]); // pagó el anfitrión
    expect((await k.as(friend).get(`/v1/mis/mesas/${mesa.id}`)).json().estado).toBe('EN_MESA');
  });

  it('un comensal solo ve lo suyo: barrido de todos los GET del comensal con otra cuenta', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    await k.as(o).put('/v1/sellos/config', { activa: true, meta: 5, premio: 'Postre' });
    const d = await k.dinerWithPlan(o);
    const c = await k.lunch(o, d.clienteId);
    await k.backdateLunch(c, 30);
    await k.as(d).post(`/v1/mis/consumos/${c}/opinion`, { etiquetas: ['RICO'] }, randomUUID());
    await k.as(d).post(`/v1/mis/consumos/${c}/reclamo`, { mensaje: 'Un reclamo de prueba.' }, randomUUID());
    const p = (
      await k.as(d).post('/v1/mis/pedidos', { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] }, randomUUID())
    ).json();
    const mesa = (await k.as(d).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(10) }, randomUUID())).json();

    const mine = {
      consumos: (await k.as(d).get('/v1/mis/consumos')).json().items.length,
      pedidos: (await k.as(d).get('/v1/mis/pedidos')).json().items.length,
      mesas: (await k.as(d).get('/v1/mis/mesas')).json().length,
      opiniones: (await k.as(d).get('/v1/mis/opiniones')).json().length,
      reclamos: (await k.as(d).get('/v1/mis/reclamos')).json().length,
      sellos: (await k.as(d).get('/v1/mis/sellos')).json().length,
      locales: (await k.as(d).get('/v1/pase')).json().locales.length,
    };
    expect(mine).toEqual({ consumos: 1, pedidos: 1, mesas: 1, opiniones: 1, reclamos: 1, sellos: 1, locales: 1 });

    const otro = await k.diner();
    const theirs = {
      consumos: (await k.as(otro).get('/v1/mis/consumos')).json().items,
      pedidos: (await k.as(otro).get('/v1/mis/pedidos')).json().items,
      mesas: (await k.as(otro).get('/v1/mis/mesas')).json(),
      opiniones: (await k.as(otro).get('/v1/mis/opiniones')).json(),
      reclamos: (await k.as(otro).get('/v1/mis/reclamos')).json(),
      sellos: (await k.as(otro).get('/v1/mis/sellos')).json(),
      locales: (await k.as(otro).get('/v1/pase')).json().locales,
      pendientes: (await k.as(otro).get('/v1/mis/opiniones/pendientes')).json(),
    };
    for (const v of Object.values(theirs)) expect(v).toEqual([]);
    for (const url of [`/v1/mis/consumos/${c}`, `/v1/mis/pedidos/${p.id}`, `/v1/mis/mesas/${mesa.id}`]) {
      expect((await k.as(otro).get(url)).statusCode, url).toBe(404);
    }
    // Lo mismo directo en la base con su usuario (RLS), en todas las tablas del comensal.
    const uid = await k.internalUser(otro.usuarioId);
    for (const t of [
      'cliente_restaurante',
      'suscripcion_plan',
      'consumo_almuerzo',
      'orden_cabecera',
      'orden_detalle',
      'mesa_compartida',
      'mesa_compartida_miembro',
      'opinion',
      'reclamo',
      'tarjeta_sellos_cliente',
      'movimiento_sello',
    ]) {
      expect(await k.rls({ userId: uid }, `SELECT 1 FROM ${t}`), t).toEqual([]);
    }
  });

  it('Swagger documenta todos los endpoints de la fase 8, con Idempotency-Key en los POST que crean y los códigos de error', async () => {
    const doc = (await k.as({}).get('/docs-json')).json();
    const ops: Record<string, string[]> = {
      '/v1/pase': ['get'],
      '/v1/mis/consumos': ['get'],
      '/v1/mis/consumos/{id}': ['get'],
      '/v1/mis/pedidos': ['get', 'post'],
      '/v1/mis/pedidos/{id}': ['get'],
      '/v1/mis/pedidos/{id}/cancelar': ['post'],
      '/v1/caja/pedidos': ['get'],
      '/v1/caja/pedidos/{id}': ['get'],
      '/v1/caja/pedidos/{id}/canjear': ['post'],
      '/v1/caja/pedidos/{id}/servir': ['post'],
      '/v1/mis/mesas': ['get', 'post'],
      '/v1/mis/mesas/{id}': ['get'],
      '/v1/mis/mesas/{id}/cancelar': ['post'],
      '/v1/mesas/invitacion/{id}': ['get'],
      '/v1/mesas/invitacion/{id}/unirse': ['post'],
      '/v1/mis/opiniones': ['get'],
      '/v1/mis/opiniones/pendientes': ['get'],
      '/v1/mis/consumos/{id}/opinion': ['post'],
      '/v1/mis/consumos/{id}/opinion/descartar': ['post'],
      '/v1/opiniones': ['get'],
      '/v1/opiniones/{id}/responder': ['post'],
      '/v1/mis/reclamos': ['get'],
      '/v1/mis/consumos/{id}/reclamo': ['post'],
      '/v1/mis/sellos': ['get'],
      '/v1/sellos/config': ['get', 'put'],
      '/v1/clientes/{id}/sellos': ['get'],
      '/v1/clientes/{id}/sellos/canjear': ['post'],
    };
    for (const [path, methods] of Object.entries(ops)) {
      for (const m of methods) {
        const op = doc.paths[path]?.[m];
        expect(op, `${m.toUpperCase()} ${path}`).toBeDefined();
        expect(op.summary, `${m.toUpperCase()} ${path}`).toBeTruthy();
      }
    }
    const creates = [
      '/v1/mis/pedidos',
      '/v1/mis/mesas',
      '/v1/mesas/invitacion/{id}/unirse',
      '/v1/mis/consumos/{id}/opinion',
      '/v1/mis/consumos/{id}/opinion/descartar',
      '/v1/mis/consumos/{id}/reclamo',
      '/v1/caja/pedidos/{id}/canjear',
      '/v1/clientes/{id}/sellos/canjear',
    ];
    for (const path of creates) {
      const params = (doc.paths[path].post.parameters ?? []) as { name: string; in: string; required: boolean }[];
      expect(
        params.find((p) => p.name === 'Idempotency-Key' && p.in === 'header' && p.required),
        path,
      ).toBeDefined();
    }
    expect(JSON.stringify(doc.paths['/v1/mis/pedidos'].post.responses)).toContain('PEDIDO_ACTIVO');
    expect(JSON.stringify(doc.paths['/v1/mesas/invitacion/{id}/unirse'].post.responses)).toContain('MESA_LLENA');
  });
});
