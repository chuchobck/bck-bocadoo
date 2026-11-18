import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
interface Mov {
  id: string;
  tipo: string;
  hora: string;
  montoCentavos: number | null;
  medioPago: string | null;
  pagoEstado: string | null;
  platoNombre: string | null;
  comensalNombre: string | null;
  revertido: boolean;
}

describe.skipIf(!probe)('GET /v1/caja/movimientos', () => {
  const k = new DinerKit(probe!, 131);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const movimientos = (o: { token: string; restaurante: string }, qs = '') => k.as(o).get(`/v1/caja/movimientos${qs}`);
  const venta = (o: Local, body: object = { items: [{ tipo: 'ALMUERZO', cantidad: 2 }], metodoPago: 'EFECTIVO' }) =>
    k.as(o).post('/v1/caja/ventas', body, randomUUID());
  const hoyDe = async (tz: string) =>
    (await probe!.sql<{ d: string }>(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0]!.d;

  /** Un pedido del comensal `d` con almuerzo (sopa + fuerte) y un extra, ya canjeado en caja. */
  async function pedidoCanjeado(o: Local, m: Record<string, string>, d: Awaited<ReturnType<DinerKit['diner']>>) {
    const p = (
      await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: o.restaurante,
          almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] },
          extras: [{ plato: m.Cola, cantidad: 1 }],
        },
        randomUUID(),
      )
    ).json();
    const c = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
    expect(c.statusCode, c.body).toBe(200);
    return p as { id: string; totalCentavos: number };
  }

  /** consumo_almuerzo, ventas y pedidos son de solo inserción: solo aquí, como superusuario dentro del probe, se mueve su hora. */
  async function mover(sql: string, params: unknown[]) {
    await probe!.sql('SET LOCAL session_replication_role = replica');
    await probe!.sql(sql, params);
    await probe!.sql('SET LOCAL session_replication_role = origin');
  }

  async function setup() {
    const o = await k.activeOwner('Caja Movimientos');
    const m = await k.menu(o);
    const conPlan = await k.dinerWithPlan(o);
    const nombreCliente = (await k.as(o).get(`/v1/clientes/${conPlan.clienteId}`)).json().nombre as string;
    return { o, m, conPlan, nombreCliente };
  }

  it('devuelve los tres tipos, con monto, medio de pago, plato y comensal solo donde aplica', async () => {
    const { o, m, conPlan, nombreCliente } = await setup();
    const v = (await venta(o)).json();
    const comensalDePedido = await k.diner();
    const p = await pedidoCanjeado(o, m, comensalDePedido);
    const directo = await k.as(o).post('/v1/caja/validar', { clienteId: conPlan.clienteId }, randomUUID());
    expect(directo.json(), directo.body).toMatchObject({ descontado: true });

    const cashier = await k.h.cashier(o.restaurante);
    for (const who of [o, cashier]) {
      const r = await movimientos(who);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as {
        items: Mov[];
        resumen: unknown;
        nextCursor: string | null;
      };
      expect(body.nextCursor).toBeNull();
      // El consumo del canje del pedido (canal PREORDEN) no es un canje directo: solo hay tres movimientos.
      expect(body.items).toHaveLength(3);
      const por = Object.fromEntries(body.items.map((x) => [x.tipo, x]));
      expect(por.VENTA).toMatchObject({
        id: v.id,
        montoCentavos: 700,
        medioPago: 'EFECTIVO',
        pagoEstado: 'CONFIRMADO',
        platoNombre: null,
        comensalNombre: null,
        revertido: false,
      });
      expect(por.PEDIDO).toMatchObject({
        id: p.id,
        montoCentavos: p.totalCentavos,
        medioPago: null,
        platoNombre: 'Sopa de quinua + Seco de pollo',
        comensalNombre: 'Comensal Prueba',
        revertido: false,
      });
      expect(por.CANJE_DIRECTO).toMatchObject({
        id: directo.json().consumo.id,
        montoCentavos: null,
        medioPago: null,
        platoNombre: null,
        comensalNombre: nombreCliente,
        revertido: false,
      });
      expect(body.resumen).toEqual({
        ventas: { cantidad: 1, ventasConfirmadasCentavos: 700 },
        pedidos: { cantidad: 1, valorPedidosCentavos: p.totalCentavos },
        canjesDirectos: { cantidad: 1 },
      });
      expectOnlyPublicIds(body);
    }
  });

  it('las ventas deshechas y los consumos revertidos salen marcados y no cuentan; el pago pendiente cuenta la venta pero no su monto', async () => {
    const { o, conPlan } = await setup();
    const ok = (await venta(o)).json();
    const deshecha = (await venta(o, { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], metodoPago: 'EFECTIVO' })).json();
    expect((await k.as(o).post(`/v1/caja/ventas/${deshecha.id}/deshacer`, {}, randomUUID())).statusCode).toBe(200);
    const pendiente = (await venta(o, { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], metodoPago: 'TRANSFERENCIA' })).json();
    expect(pendiente.pago.estado).toBe('PENDIENTE');
    const directo = (await k.as(o).post('/v1/caja/validar', { clienteId: conPlan.clienteId }, randomUUID())).json();
    expect((await k.as(o).post(`/v1/caja/consumos/${directo.consumo.id}/deshacer`)).statusCode).toBe(200);

    const body = (await movimientos(o)).json() as { items: Mov[]; resumen: unknown };
    // Los reversos no son filas: 3 ventas (la deshecha incluida) y 1 consumo (el revertido).
    expect(body.items).toHaveLength(4);
    const byId = Object.fromEntries(body.items.map((x) => [x.id, x]));
    expect(byId[ok.id]).toMatchObject({ revertido: false, pagoEstado: 'CONFIRMADO' });
    expect(byId[deshecha.id]!.revertido).toBe(true);
    expect(byId[pendiente.id]).toMatchObject({ revertido: false, pagoEstado: 'PENDIENTE', medioPago: 'TRANSFERENCIA' });
    expect(byId[directo.consumo.id]!.revertido).toBe(true);
    // Ventas: la confirmada (700) y la pendiente (cuenta, pero no suma); la deshecha y el consumo revertido no cuentan.
    expect(body.resumen).toEqual({
      ventas: { cantidad: 2, ventasConfirmadasCentavos: 700 },
      pedidos: { cantidad: 0, valorPedidosCentavos: 0 },
      canjesDirectos: { cantidad: 0 },
    });
  });

  it('va de la hora más reciente a la más antigua y pagina con cursor sin repetir ni saltar nada', async () => {
    const { o, m, conPlan } = await setup();
    const v = (await venta(o)).json();
    const p = await pedidoCanjeado(o, m, await k.diner());
    const c = (await k.as(o).post('/v1/caja/validar', { clienteId: conPlan.clienteId }, randomUUID())).json().consumo.id as string;
    // Dentro del probe todo comparte la hora de la transacción: se separa a mano (segundos, para no cruzar el día local).
    await mover(`UPDATE venta_pos_cabecera SET creado_en = CURRENT_TIMESTAMP - interval '30 seconds' WHERE public_id = $1`, [v.id]);
    await mover(`UPDATE orden_cabecera SET canjeada_en = CURRENT_TIMESTAMP - interval '20 seconds' WHERE public_id = $1`, [p.id]);
    await mover(`UPDATE consumo_almuerzo SET creado_en = CURRENT_TIMESTAMP - interval '10 seconds' WHERE public_id = $1`, [c]);

    const all = (await movimientos(o)).json() as { items: Mov[] };
    expect(all.items.map((x) => x.id)).toEqual([c, p.id, v.id]);

    const first = (await movimientos(o, '?limit=2')).json() as { items: Mov[]; nextCursor: string | null; resumen: unknown };
    expect(first.items.map((x) => x.id)).toEqual([c, p.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await movimientos(o, `?limit=2&cursor=${first.nextCursor}`)).json() as {
      items: Mov[];
      nextCursor: string | null;
      resumen: unknown;
    };
    expect(second.items.map((x) => x.id)).toEqual([v.id]);
    expect(second.nextCursor).toBeNull();
    // El resumen es del día entero, no de la página.
    expect(second.resumen).toEqual(first.resumen);

    const bad = await movimientos(o, '?cursor=nada');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'CURSOR_INVALIDO' });
    expect((await movimientos(o, '?limit=51')).statusCode).toBe(400);
  });

  it('sin `fecha` usa el día local del restaurante (otra zona horaria), no el del servidor', async () => {
    const o = await k.activeOwner('Caja Zona');
    // Kiritimati (UTC+14) y Pago Pago (UTC-11) van 25 h aparte: al menos una tiene otro "hoy" que UTC.
    const utc = await hoyDe('UTC');
    const zona = (await hoyDe('Pacific/Kiritimati')) !== utc ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
    const hoyLocal = await hoyDe(zona);
    expect(hoyLocal).not.toBe(utc);
    await probe!.sql(`UPDATE restaurante SET zona_horaria = $2 WHERE public_id = $1`, [o.restaurante, zona]);

    const m = await k.menu(o); // publicado para el "hoy" de la nueva zona
    const v = (await venta(o)).json();
    const p = await pedidoCanjeado(o, m, await k.diner());

    const r = (await movimientos(o)).json() as { fecha: string; zonaHoraria: string; items: Mov[] };
    expect(r).toMatchObject({ fecha: hoyLocal, zonaHoraria: zona });
    expect(r.items.map((x) => x.id).sort()).toEqual([v.id, p.id].sort());
    // El día de UTC es "mañana" o "ayer" para este local: ahí no hay nada.
    expect(((await movimientos(o, `?fecha=${utc}`)).json() as { items: Mov[] }).items).toEqual([]);
    expect(((await movimientos(o, `?fecha=${hoyLocal}`)).json() as { items: Mov[] }).items).toHaveLength(2);
  });

  it('cambio de día: cada movimiento sale solo en su día local; días sin movimientos van vacíos', async () => {
    const { o, m, conPlan } = await setup();
    const v = (await venta(o)).json();
    const p = await pedidoCanjeado(o, m, await k.diner());
    const c = (await k.as(o).post('/v1/caja/validar', { clienteId: conPlan.clienteId }, randomUUID())).json().consumo.id as string;
    const hoy = (await movimientos(o)).json().fecha as string;
    const ayer = (await probe!.sql<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [hoy])).rows[0]!.d;
    const manana = (await probe!.sql<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [hoy])).rows[0]!.d;

    // Se pasan al "ayer" solo la venta y el canje directo; el pedido se queda en hoy.
    await mover(
      `UPDATE venta_pos_cabecera SET fecha_local = fecha_local - 1, creado_en = creado_en - interval '1 day' WHERE public_id = $1`,
      [v.id],
    );
    await mover(
      `UPDATE consumo_almuerzo SET fecha_local = fecha_local - 1, creado_en = creado_en - interval '1 day' WHERE public_id = $1`,
      [c],
    );

    const ids = async (qs: string) => ((await movimientos(o, qs)).json() as { items: Mov[] }).items.map((x) => x.id).sort();
    expect(await ids('')).toEqual([p.id]);
    expect(await ids(`?fecha=${hoy}`)).toEqual([p.id]);
    expect(await ids(`?fecha=${ayer}`)).toEqual([v.id, c].sort());
    expect(await ids(`?fecha=${manana}`)).toEqual([]);
    const dePasado = (await movimientos(o, `?fecha=${ayer}`)).json();
    expect(dePasado.fecha).toBe(ayer);
    expect(dePasado.resumen).toMatchObject({
      ventas: { cantidad: 1, ventasConfirmadasCentavos: 700 },
      pedidos: { cantidad: 0, valorPedidosCentavos: 0 },
      canjesDirectos: { cantidad: 1 },
    });

    // Un pedido canjeado ayer (hora local) sale en ayer, no en hoy.
    await mover(`UPDATE orden_cabecera SET canjeada_en = canjeada_en - interval '1 day' WHERE public_id = $1`, [p.id]);
    expect(await ids('')).toEqual([]);
    expect(await ids(`?fecha=${ayer}`)).toEqual([v.id, c, p.id].sort());
  });

  it('el cajero solo consulta hoy (hora local del restaurante); el dueño, cualquier fecha', async () => {
    const o = await k.activeOwner('Caja Solo Hoy');
    const cashier = await k.h.cashier(o.restaurante);
    await k.menu(o);
    await venta(o);
    const hoy = (await movimientos(cashier)).json().fecha as string;
    const dia = async (delta: number) =>
      (await probe!.sql<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [hoy, delta])).rows[0]!.d;
    const prohibido = { status: 403, code: 'CAJERO_SOLO_HOY' };

    // Hoy: sin fecha y con la fecha de hoy explícita.
    for (const qs of ['', `?fecha=${hoy}`]) {
      const r = await movimientos(cashier, qs);
      expect(r.statusCode, qs).toBe(200);
      expect(r.json().items).toHaveLength(1);
    }
    // Ayer y mañana: 403 con código de negocio, en problem+json, y sin filtrar datos.
    for (const fecha of [await dia(-1), await dia(1), '2020-01-01']) {
      const r = await movimientos(cashier, `?fecha=${fecha}`);
      expect(r.statusCode, fecha).toBe(403);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.json()).toMatchObject(prohibido);
      expect(r.json()).not.toHaveProperty('items');
    }
    // El dueño sí puede ver cualquier día.
    for (const fecha of [hoy, await dia(-1), await dia(1), '2020-01-01']) {
      expect((await movimientos(o, `?fecha=${fecha}`)).statusCode, fecha).toBe(200);
    }
    // Una fecha inexistente sigue siendo 400, también para el cajero.
    expect((await movimientos(cashier, '?fecha=2026-02-31')).statusCode).toBe(400);
  });

  it('"hoy" del cajero es el del restaurante, no el del servidor (otra zona horaria)', async () => {
    const o = await k.activeOwner('Caja Zona Cajero');
    const cashier = await k.h.cashier(o.restaurante);
    const utc = await hoyDe('UTC');
    const zona = (await hoyDe('Pacific/Kiritimati')) !== utc ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
    const hoyLocal = await hoyDe(zona);
    await probe!.sql(`UPDATE restaurante SET zona_horaria = $2 WHERE public_id = $1`, [o.restaurante, zona]);

    // La fecha de UTC es la de otro día para este local: el cajero no puede; la local sí.
    const fuera = await movimientos(cashier, `?fecha=${utc}`);
    expect(fuera.statusCode).toBe(403);
    expect(fuera.json()).toMatchObject({ code: 'CAJERO_SOLO_HOY' });
    const dentro = await movimientos(cashier, `?fecha=${hoyLocal}`);
    expect(dentro.statusCode, dentro.body).toBe(200);
    expect(dentro.json().fecha).toBe(hoyLocal);
    expect((await movimientos(cashier)).json().fecha).toBe(hoyLocal);
    expect((await movimientos(o, `?fecha=${utc}`)).statusCode).toBe(200);
  });

  it('fecha inválida → 400', async () => {
    const o = await k.activeOwner();
    for (const bad of ['2026-02-31', '13-11-2026', 'hoy', '2026-11-1']) {
      const r = await movimientos(o, `?fecha=${bad}`);
      expect(r.statusCode, bad).toBe(400);
      expect(r.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('aislamiento: cada local ve solo lo suyo, y nadie entra al local de otro', async () => {
    const { o: a, m: ma, conPlan: ca } = await setup();
    const b = await k.activeOwner('Otro Local');
    const mb = await k.menu(b);
    const cb = await k.dinerWithPlan(b);

    const va = (await venta(a)).json();
    const pa = await pedidoCanjeado(a, ma, await k.diner());
    const da = (await k.as(a).post('/v1/caja/validar', { clienteId: ca.clienteId }, randomUUID())).json().consumo.id as string;
    const vb = (await venta(b, { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], metodoPago: 'EFECTIVO' })).json();
    const pb = await pedidoCanjeado(b, mb, await k.diner());
    const db = (await k.as(b).post('/v1/caja/validar', { clienteId: cb.clienteId }, randomUUID())).json().consumo.id as string;

    const verA = (await movimientos(a)).json() as { items: Mov[]; resumen: { ventas: { ventasConfirmadasCentavos: number } } };
    const verB = (await movimientos(b)).json() as { items: Mov[]; resumen: { ventas: { ventasConfirmadasCentavos: number } } };
    expect(verA.items.map((x) => x.id).sort()).toEqual([va.id, pa.id, da].sort());
    expect(verB.items.map((x) => x.id).sort()).toEqual([vb.id, pb.id, db].sort());
    expect(verA.resumen.ventas.ventasConfirmadasCentavos).toBe(700);
    expect(verB.resumen.ventas.ventasConfirmadasCentavos).toBe(350);

    // Un cursor de un local no abre nada del otro: la consulta siempre lleva el tenant del que pregunta.
    const cursorA = ((await movimientos(a, '?limit=1')).json() as { nextCursor: string }).nextCursor;
    const conCursorDeA = (await movimientos(b, `?limit=1&cursor=${cursorA}`)).json() as { items: Mov[] };
    expect(conCursorDeA.items.every((x) => [vb.id, pb.id, db].includes(x.id))).toBe(true);

    // El dueño de B no puede pedir los movimientos de A con el x-restaurant-id de A.
    expect((await movimientos({ token: b.token, restaurante: a.restaurante })).statusCode).toBe(403);
    // Ni siquiera el SQL directo como bck_api, con el contexto de B, ve filas de A (RLS).
    const filas = await k.rls<{ public_id: string }>(
      {
        tenantId: (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [b.restaurante]))
          .rows[0]!.id,
      },
      'SELECT public_id FROM venta_pos_cabecera',
    );
    expect(filas.map((f) => f.public_id)).not.toContain(va.id);
  });

  it('quien no es personal del local recibe 403 (comensal con x-restaurant-id) y sin sesión 401', async () => {
    const o = await k.activeOwner();
    const comensal = await k.diner();
    const r = await movimientos({ token: comensal.token, restaurante: o.restaurante });
    expect(r.statusCode).toBe(403);
    expect(r.headers['content-type']).toContain('application/problem+json');
    // Sin x-restaurant-id un endpoint de personal no abre (400 del guard de tenant).
    expect((await movimientos({ token: comensal.token })).statusCode).toBe(400);
    expect((await movimientos({ restaurante: o.restaurante })).statusCode).toBe(401);
  });

  it('es de solo lectura: consultar no cambia ninguna tabla', async () => {
    const { o, conPlan } = await setup();
    await venta(o);
    await k.as(o).post('/v1/caja/validar', { clienteId: conPlan.clienteId }, randomUUID());
    const cuenta = async () =>
      (
        await probe!.sql<{ n: string }>(
          `SELECT (SELECT count(*) FROM venta_pos_cabecera) + (SELECT count(*) FROM consumo_almuerzo) + (SELECT count(*) FROM transaccion_pago)
                  + (SELECT count(*) FROM intento_escaneo) + (SELECT count(*) FROM orden_cabecera) AS n`,
        )
      ).rows[0]!.n;
    const antes = await cuenta();
    for (let i = 0; i < 3; i++) expect((await movimientos(o)).statusCode).toBe(200);
    expect(await cuenta()).toBe(antes);
  });
});
