import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const C = 600; // Churrasco, A_LA_CARTA
const O1 = 450; // oferta sobre el Churrasco (precio original 650)
const O2 = 250; // oferta sobre un plato ALMUERZO (Seco de pollo)

/**
 * PR 7b (docs/spec-cobros.md E.2, E.3, E.8, D, G-8, G-29, G-33, G-37): ofertas flash en pedidos y en la selección de
 * mesa, el stock que se toma al canjear en caja y la regla completa de SALDO_CAMBIO. Más `paraLlevar` por línea en el POS.
 */
describe.skipIf(!probe)('PR 7b: ofertas flash en pedidos y mesas, SALDO_CAMBIO y paraLlevar por línea (POS)', () => {
  const k = new DinerKit(probe!, 143);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Quien = { token?: string; restaurante?: string };

  async function local() {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const ch = await k.as(o).post('/v1/menu/platos', { nombre: 'Churrasco', categoria: 'A_LA_CARTA', precioCentavos: C });
    expect(ch.statusCode, ch.body).toBe(201);
    const pub = async (gestionId: string) =>
      (await probe!.sql<{ id: string }>('SELECT public_id AS id FROM plato WHERE plato_id = $1', [gestionId])).rows[0]!.id;
    const gestionDe = async (publicId: string) =>
      (await probe!.sql<{ id: string }>('SELECT plato_id::text AS id FROM plato WHERE public_id = $1', [publicId])).rows[0]!.id;
    return {
      o,
      m,
      seco: m['Seco de pollo']!,
      sopa: m['Sopa de quinua']!,
      cola: m.Cola!,
      churrasco: await pub(ch.json().id),
      churrascoGestion: ch.json().id as string,
      secoGestion: await gestionDe(m['Seco de pollo']!),
      colaGestion: await gestionDe(m.Cola!),
    };
  }
  type Local = Awaited<ReturnType<typeof local>>;

  /** Publica una oferta; devuelve su public_id. */
  async function oferta(l: Local, body: Record<string, unknown>) {
    const r = await k
      .as(l.o)
      .post(
        '/v1/ofertas',
        { titulo: 'Oferta flash', precioCentavos: O1, precioOriginalCentavos: 650, stock: 5, duracionMinutos: 60, ...body },
        randomUUID(),
      );
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  const stockDe = async (id: string) =>
    (await probe!.sql<{ s: number }>('SELECT stock_restante AS s FROM oferta_flash WHERE public_id = $1', [id])).rows[0]!.s;
  const canjesDe = async (id: string) =>
    (
      await probe!.sql<{ cantidad: number; monto: string; cuenta: string | null; pagos: string }>(
        `SELECT c.cantidad, c.monto_centavos AS monto, c.cuenta_cobro_id::text AS cuenta,
                (SELECT count(*) FROM transaccion_pago p WHERE p.canje_oferta_id = c.canje_id) AS pagos
           FROM canje_oferta_flash c JOIN oferta_flash o ON o.oferta_flash_id = c.oferta_flash_id WHERE o.public_id = $1`,
        [id],
      )
    ).rows;
  const saldoPlan = async (l: Local, c: string) => (await k.as(l.o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const consumos = async (l: Local) =>
    (
      await probe!.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM consumo_almuerzo c JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1 AND c.cantidad = 1`,
        [l.o.restaurante],
      )
    ).rows[0]!.n;
  const totales = (c: Record<string, number>) => [
    c.subtotalCentavos,
    c.recargoCentavos,
    c.totalCentavos,
    c.cubiertoPorPlanCentavos,
    c.saldoPorCobrarCentavos,
  ];

  const pedir = (who: object, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/pedidos', body, key);
  const cotizar = (who: object, body: object) => k.as(who).post('/v1/mis/pedidos/cotizar', body);
  const canjear = (who: Quien, id: string, body?: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/pedidos/${id}/canjear`, body, key);

  describe('pedidos', () => {
    it('G-8: almuerzo con oferta cobra el precio de la oferta y no consume plan; no reserva stock; /cotizar da lo mismo', async () => {
      const l = await local();
      const o2 = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350 });
      const d = await k.dinerWithPlan(l.o);
      const body = { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa, l.seco], ofertaId: o2 } };
      const q = await cotizar(d, body);
      expect(q.statusCode, q.body).toBe(200);
      expect(totales(q.json())).toEqual([250, 0, 250, 0, 250]);
      expect(q.json().lineas[0]).toMatchObject({ tipo: 'OFERTA', fuente: 'OFERTA', ofertaId: o2, precioUnitarioCentavos: O2 });

      const r = await pedir(d, body);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ totalCentavos: 250, almuerzo: { ofertaId: o2, precioCentavos: 250, cubiertoPorPlan: false } });
      expect(totales(r.json().cotizacion)).toEqual([250, 0, 250, 0, 250]);
      expect(await stockDe(o2)).toBe(5); // I-7: no se reserva al pedir
      expect(await saldoPlan(l, d.clienteId)).toBe(5);
      const h = await probe!.sql<{ total: string; oferta: string | null }>(
        `SELECT o.total_centavos AS total, f.public_id AS oferta FROM orden_cabecera o
           LEFT JOIN oferta_flash f ON f.oferta_flash_id = o.almuerzo_oferta_flash_id WHERE o.public_id = $1`,
        [r.json().id],
      );
      expect(h.rows).toEqual([{ total: '250', oferta: o2 }]);
    });

    it('ofertas como ítems: recargo según la categoría del plato (carta sí, bebida no); total guardado = saldo', async () => {
      const l = await local();
      const o1 = await oferta(l, { platoId: l.churrasco }); // 450, A_LA_CARTA
      const o3 = await oferta(l, { platoId: l.cola, precioCentavos: 80, precioOriginalCentavos: 100 }); // BEBIDA
      const d = await k.diner();
      const r = await pedir(d, {
        restaurante: l.o.restaurante,
        paraLlevar: true,
        ofertas: [
          { oferta: o1, cantidad: 1 },
          { oferta: o3, cantidad: 2 },
        ],
      });
      expect(r.statusCode, r.body).toBe(201);
      // 450 + 2×80 = 610; recargo solo del churrasco: 25.
      expect(totales(r.json().cotizacion)).toEqual([610, 25, 635, 0, 635]);
      expect(r.json()).toMatchObject({ totalCentavos: 635, recargoLlevarCentavos: 25, extras: [], cartaItems: [] });
      expect(r.json().ofertas).toEqual([
        { id: o1, titulo: 'Oferta flash', cantidad: 1, precioUnitarioCentavos: 450, subtotalCentavos: 450 },
        { id: o3, titulo: 'Oferta flash', cantidad: 2, precioUnitarioCentavos: 80, subtotalCentavos: 160 },
      ]);
      const g = await k.as(d).get(`/v1/mis/pedidos/${r.json().id}`);
      expect(g.json().ofertas).toHaveLength(2);
      expect(g.json().totalCentavos).toBe(635);
    });

    it('errores: inexistente, sin plato, de otro plato, cerrada, sin stock', async () => {
      const l = await local();
      const d = await k.diner();
      const base = { restaurante: l.o.restaurante };
      expect((await pedir(d, { ...base, ofertas: [{ oferta: randomUUID(), cantidad: 1 }] })).json()).toMatchObject({
        status: 404,
        code: 'OFERTA_NO_ENCONTRADA',
      });
      const sinPlato = await oferta(l, {});
      expect((await pedir(d, { ...base, ofertas: [{ oferta: sinPlato, cantidad: 1 }] })).json()).toMatchObject({
        status: 422,
        code: 'OFERTA_SIN_PLATO',
      });
      const deCarta = await oferta(l, { platoId: l.churrasco });
      // almuerzo.ofertaId con un plato que no es ALMUERZO
      expect((await pedir(d, { ...base, almuerzo: { platos: [l.sopa], ofertaId: deCarta } })).json()).toMatchObject({
        status: 422,
        code: 'OFERTA_NO_APLICA_ALMUERZO',
      });
      // oferta de un plato ALMUERZO que no está entre los elegidos
      const deSeco = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350 });
      expect((await pedir(d, { ...base, almuerzo: { platos: [l.sopa], ofertaId: deSeco } })).json()).toMatchObject({
        status: 422,
        code: 'OFERTA_NO_APLICA_ALMUERZO',
      });
      expect((await pedir(d, { ...base, ofertas: [{ oferta: deCarta, cantidad: 6 }] })).json()).toMatchObject({
        status: 409,
        code: 'STOCK_INSUFICIENTE',
      });
      expect((await k.as(l.o).post(`/v1/ofertas/${deCarta}/cerrar`)).statusCode).toBe(200);
      expect((await pedir(d, { ...base, ofertas: [{ oferta: deCarta, cantidad: 1 }] })).json()).toMatchObject({
        status: 409,
        code: 'OFERTA_CERRADA',
      });
    });

    it('canje: toma el stock, registra el canje dentro de la cuenta (sin pago propio) y no consume el plan; repetir no descuenta otra vez', async () => {
      const l = await local();
      const o2 = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350, stock: 3 });
      const d = await k.dinerWithPlan(l.o);
      const p = (await pedir(d, { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa, l.seco], ofertaId: o2 } })).json();
      const r = await canjear(l.o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ yaCanjeado: false, porCobrarCentavos: 250, almuerzo: { descontado: false } });
      expect(r.json().cuenta).toMatchObject({ estado: 'ABIERTA', saldoCentavos: 250 });
      expect(await stockDe(o2)).toBe(2);
      expect(await saldoPlan(l, d.clienteId)).toBe(5);
      expect(await consumos(l)).toBe(0);
      const c = await canjesDe(o2);
      expect(c).toEqual([{ cantidad: 1, monto: '250', cuenta: expect.any(String), pagos: '0' }]);
      const linea = await probe!.sql<{ fuente: string; canje: string | null }>(
        `SELECT l.fuente, l.canje_oferta_id::text AS canje FROM cuenta_cobro_linea l JOIN cuenta_cobro c USING (cuenta_id)
           JOIN orden_cabecera o ON o.orden_id = c.orden_id WHERE o.public_id = $1`,
        [p.id],
      );
      expect(linea.rows).toEqual([{ fuente: 'OFERTA', canje: expect.any(String) }]);
      const otra = await canjear(l.o, p.id);
      expect(otra.json().yaCanjeado).toBe(true);
      expect(await stockDe(o2)).toBe(2);
      expect(await canjesDe(o2)).toHaveLength(1);
    });

    it('G-37: la oferta cae entre pedir y canjear → 409 SALDO_CAMBIO sin descontar plan ni stock; confirmar con el saldo nuevo canjea a precio normal', async () => {
      const l = await local();
      const o2 = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350 });
      const d = await k.dinerWithPlan(l.o);
      const p = (await pedir(d, { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa, l.seco], ofertaId: o2 } })).json();
      expect(p.totalCentavos).toBe(250);
      expect((await k.as(l.o).post(`/v1/ofertas/${o2}/cerrar`)).statusCode).toBe(200);

      // Sin `cobro` también: la referencia es el total guardado al pedir.
      const r = await canjear(l.o, p.id);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: 0, saldoEsperadoCentavos: 250 });
      expect(r.json().avisos).toEqual(
        expect.arrayContaining([expect.objectContaining({ codigo: 'OFERTA_AGOTADA', lineaRef: 'almuerzo' })]),
      );
      expect(await saldoPlan(l, d.clienteId)).toBe(5);
      expect(await consumos(l)).toBe(0);
      expect(await stockDe(o2)).toBe(5);
      expect(await canjesDe(o2)).toHaveLength(0);
      expect((await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
      // Con `cobro` y otro saldo esperado, igual.
      const otro = await canjear(l.o, p.id, { cobro: { saldoEsperadoCentavos: 250, metodoPago: 'EFECTIVO' } });
      expect(otro.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: 0 });
      expect(await saldoPlan(l, d.clienteId)).toBe(5);

      // La caja confirma el saldo nuevo (0: ahora lo cubre el plan): se descuenta 1 y no hay canje de oferta.
      const ok = await canjear(l.o, p.id, { cobro: { saldoEsperadoCentavos: 0 } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ porCobrarCentavos: 0, almuerzo: { descontado: true } });
      expect(await saldoPlan(l, d.clienteId)).toBe(4);
      expect(await stockDe(o2)).toBe(5);
      expect(await canjesDe(o2)).toHaveLength(0);
    });

    it('G-37 con stock: dos pedidos para la última unidad; el segundo cae a SALDO_CAMBIO y el stock nunca queda negativo', async () => {
      const l = await local();
      const o1 = await oferta(l, { platoId: l.churrasco, stock: 1 });
      const a = await k.diner();
      const b = await k.diner();
      const body = { restaurante: l.o.restaurante, ofertas: [{ oferta: o1, cantidad: 1 }] };
      const pa = (await pedir(a, body)).json();
      const pb = (await pedir(b, body)).json();
      expect((await canjear(l.o, pa.id)).statusCode).toBe(200);
      expect(await stockDe(o1)).toBe(0);
      const r = await canjear(l.o, pb.id);
      expect(r.json()).toMatchObject({ status: 409, code: 'SALDO_CAMBIO', saldoCentavos: C, saldoEsperadoCentavos: 450 });
      expect(await stockDe(o1)).toBe(0);
      const ok = await canjear(l.o, pb.id, { cobro: { saldoEsperadoCentavos: C } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().avisos).toEqual([{ codigo: 'OFERTA_AGOTADA', lineaRef: 'oferta:0' }]);
      expect(ok.json().cuenta).toMatchObject({ saldoCentavos: C });
      expect(await stockDe(o1)).toBe(0);
      expect(await canjesDe(o1)).toHaveLength(1);
    });

    it('sin diferencias no hay SALDO_CAMBIO: pedido sin ofertas y con plan igual al estimado canjea como siempre', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const p = (await pedir(d, { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa, l.seco] } })).json();
      const r = await canjear(l.o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().porCobrarCentavos).toBe(0);
    });

    it('plan que se gastó entre pedir y canjear también da SALDO_CAMBIO, sin cobro', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o, { almuerzos: 1 });
      const p = (await pedir(d, { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa, l.seco] } })).json();
      expect(p.totalCentavos).toBe(0);
      // Se gastó por otro lado (no con validar: desde el PR 10, validar con este cliente cerraría esta misma preorden
      // en vez de descontar algo aparte; aquí se simula cualquier otra baja del cupo entre pedir y canjear).
      await probe!.sql("UPDATE suscripcion_plan SET almuerzos_restantes = 0, estado = 'AGOTADA' WHERE cliente_id = $1", [d.clienteId]);
      const r = await canjear(l.o, p.id);
      expect(r.json()).toMatchObject({ status: 409, code: 'SALDO_CAMBIO', saldoCentavos: P, saldoEsperadoCentavos: 0 });
    });
  });

  describe('mesas', () => {
    async function mesa(
      l: Local,
      host: { token: string },
      invitados: { p: { token: string }; llevar?: boolean }[],
      modo: 'CADA_UNO' | 'INVITO_YO',
      hostLlevar = false,
    ) {
      const inMinutes = new Date(Date.now() + 30 * 60_000).toISOString();
      const r = await k
        .as(host)
        .post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes, modo, paraLlevar: hostLlevar }, randomUUID());
      expect(r.statusCode, r.body).toBe(201);
      const id = r.json().id as string;
      for (const g of invitados) {
        const u = await k.as(g.p).post(`/v1/mesas/invitacion/${id}/unirse`, { paraLlevar: g.llevar ?? false }, randomUUID());
        expect(u.statusCode, u.body).toBe(200);
      }
      return id;
    }
    const elegir = (p: { token: string }, id: string, body: object) => k.as(p).put(`/v1/mis/mesas/${id}/seleccion`, body);
    const validar = (who: Quien, id: string, key = randomUUID()) => k.as(who).post(`/v1/caja/mesas/${id}/validar`, undefined, key);

    it('G-29 CADA_UNO: oferta suelta O1×1 para llevar, sin almuerzo: 450 + 25, plan intacto, stock −1 y canje dentro de su cuenta', async () => {
      const l = await local();
      const o1 = await oferta(l, { platoId: l.churrasco });
      const a = await k.dinerWithPlan(l.o);
      const id = await mesa(l, a, [], 'CADA_UNO', true);
      const s = await elegir(a, id, { ofertas: [{ oferta: o1, cantidad: 1 }] });
      expect(s.statusCode, s.body).toBe(200);
      const yo = s.json().miembros.find((m: { esAnfitrion: boolean }) => m.esAnfitrion);
      expect(yo.seleccion.ofertas).toEqual([
        { id: o1, titulo: 'Oferta flash', cantidad: 1, precioUnitarioCentavos: 450, subtotalCentavos: 450 },
      ]);
      expect(totales(yo.cotizacion)).toEqual([450, 25, 475, 0, 475]);
      expect(await stockDe(o1)).toBe(5); // elegir no reserva

      const r = await validar(l.o, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(totales(r.json().cotizacion)).toEqual([450, 25, 475, 0, 475]);
      expect(await saldoPlan(l, a.clienteId)).toBe(5);
      expect(await consumos(l)).toBe(0);
      expect(await stockDe(o1)).toBe(4);
      expect(await canjesDe(o1)).toEqual([{ cantidad: 1, monto: '450', cuenta: expect.any(String), pagos: '0' }]);
      // Reintentar con la misma llave no descuenta otra vez.
      const key = randomUUID();
      const l2 = await local();
      const o = await oferta(l2, { platoId: l2.churrasco });
      const h2 = await k.diner();
      const id2 = await mesa(l2, h2, [], 'CADA_UNO');
      await elegir(h2, id2, { ofertas: [{ oferta: o, cantidad: 2 }] });
      expect((await validar(l2.o, id2, key)).statusCode).toBe(200);
      expect((await validar(l2.o, id2, key)).statusCode).toBe(200);
      expect(await stockDe(o)).toBe(3);
    });

    it('G-33 INVITO_YO: anfitrión con almuerzo (plan) e invitado con oferta O2 en su almuerzo: 600, cubierto 350, saldo 250, 1 consumo', async () => {
      const l = await local();
      const o2 = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350 });
      const h = await k.dinerWithPlan(l.o);
      const g1 = await k.diner();
      const id = await mesa(l, h, [{ p: g1 }], 'INVITO_YO');
      expect((await elegir(h, id, { almuerzo: { platos: [l.sopa] } })).statusCode).toBe(200);
      const s = await elegir(g1, id, { almuerzo: { platos: [l.sopa, l.seco], ofertaId: o2 } });
      expect(s.statusCode, s.body).toBe(200);
      const yo = s.json().miembros.find((m: { esAnfitrion: boolean }) => !m.esAnfitrion);
      expect(yo.seleccion.almuerzo.ofertaId).toBe(o2);

      const r = await validar(l.o, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(totales(r.json().cotizacion)).toEqual([600, 0, 600, 350, 250]);
      expect(await consumos(l)).toBe(1);
      expect(await saldoPlan(l, h.clienteId)).toBe(4);
      expect(await stockDe(o2)).toBe(4);
      expect(await canjesDe(o2)).toEqual([{ cantidad: 1, monto: '250', cuenta: expect.any(String), pagos: '0' }]);
    });

    it('elegir: reemplazar la selección quita la oferta del almuerzo; errores de validación', async () => {
      const l = await local();
      const o2 = await oferta(l, { platoId: l.seco, precioCentavos: O2, precioOriginalCentavos: 350 });
      const o1 = await oferta(l, { platoId: l.churrasco });
      const h = await k.diner();
      const id = await mesa(l, h, [], 'CADA_UNO');
      const ok = await elegir(h, id, { almuerzo: { platos: [l.sopa, l.seco], ofertaId: o2 } });
      expect(ok.statusCode, ok.body).toBe(200);
      const sin = await elegir(h, id, { almuerzo: { platos: [l.sopa, l.seco] } });
      expect(sin.json().miembros[0].seleccion.almuerzo.ofertaId).toBeNull();
      // oferta que no es de un plato del almuerzo elegido
      expect((await elegir(h, id, { almuerzo: { platos: [l.sopa], ofertaId: o2 } })).json()).toMatchObject({
        status: 422,
        code: 'OFERTA_NO_APLICA_ALMUERZO',
      });
      // el plato de una oferta suelta no se repite como plato suelto
      expect(
        (await elegir(h, id, { extras: [{ plato: l.churrasco, cantidad: 1 }], ofertas: [{ oferta: o1, cantidad: 1 }] })).json(),
      ).toMatchObject({ status: 400, code: 'SELECCION_INVALIDA' });
      expect((await elegir(h, id, { ofertas: [{ oferta: randomUUID(), cantidad: 1 }] })).json()).toMatchObject({
        status: 404,
        code: 'OFERTA_NO_ENCONTRADA',
      });
      expect((await elegir(h, id, { ofertas: [{ oferta: o1, cantidad: 9 }] })).json()).toMatchObject({
        status: 409,
        code: 'STOCK_INSUFICIENTE',
      });
    });

    it('la oferta cae entre elegir y validar: la línea se cobra al precio normal del plato (600 + 25), con aviso, y no toca stock', async () => {
      const l = await local();
      const o1 = await oferta(l, { platoId: l.churrasco });
      const h = await k.diner();
      const id = await mesa(l, h, [], 'CADA_UNO', true);
      expect((await elegir(h, id, { ofertas: [{ oferta: o1, cantidad: 1 }] })).statusCode).toBe(200);
      expect((await k.as(l.o).post(`/v1/ofertas/${o1}/cerrar`)).statusCode).toBe(200);
      const r = await validar(l.o, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(totales(r.json().cotizacion)).toEqual([600, 25, 625, 0, 625]);
      expect(r.json().avisos).toEqual([expect.objectContaining({ codigo: 'OFERTA_AGOTADA' })]);
      expect(await stockDe(o1)).toBe(5);
      expect(await canjesDe(o1)).toHaveLength(0);
    });

    it('la mesa pide más unidades que el stock: ninguna se toma, todas a precio normal y el stock no baja', async () => {
      const l = await local();
      const o1 = await oferta(l, { platoId: l.churrasco, stock: 1 });
      const a = await k.diner();
      const b = await k.diner();
      const id = await mesa(l, a, [{ p: b }], 'CADA_UNO');
      expect((await elegir(a, id, { ofertas: [{ oferta: o1, cantidad: 1 }] })).statusCode).toBe(200);
      expect((await elegir(b, id, { ofertas: [{ oferta: o1, cantidad: 1 }] })).statusCode).toBe(200);
      const r = await validar(l.o, id);
      expect(r.statusCode, r.body).toBe(200);
      // 2 unidades pedidas, 1 en stock: la oferta no alcanza para la mesa, ninguna se toma y ambas van a precio normal.
      expect(await stockDe(o1)).toBe(1);
      expect(r.json().avisos.filter((x: { codigo: string }) => x.codigo === 'OFERTA_AGOTADA')).toHaveLength(2);
      expect(totales(r.json().cotizacion)).toEqual([1200, 0, 1200, 0, 1200]);
    });
  });

  describe('POS: paraLlevar por línea', () => {
    const vender = (o: Quien, body: object) => k.as(o).post('/v1/caja/ventas', { metodoPago: 'EFECTIVO', ...body }, randomUUID());

    it('la línea gana sobre la venta; sin él hereda; el recargo es por almuerzo que se lleva', async () => {
      const o = await k.activeOwner();
      const a = await vender(o, {
        items: [
          { tipo: 'ALMUERZO', cantidad: 2, paraLlevar: true },
          { tipo: 'ALMUERZO', cantidad: 1 },
        ],
      });
      expect(a.statusCode, a.body).toBe(201);
      expect(a.json().totalCentavos).toBe(3 * P + 2 * R);
      const b = await vender(o, {
        paraLlevar: true,
        items: [
          { tipo: 'ALMUERZO', cantidad: 2, paraLlevar: false },
          { tipo: 'ALMUERZO', cantidad: 1 },
        ],
      });
      expect(b.json().totalCentavos).toBe(3 * P + 1 * R);
      const c = await vender(o, { paraLlevar: true, items: [{ tipo: 'ALMUERZO', cantidad: 2 }] });
      expect(c.json().totalCentavos).toBe(2 * P + 2 * R);
      const d = await vender(o, { items: [{ tipo: 'ALMUERZO', cantidad: 2, paraLlevar: false }] });
      expect(d.json().totalCentavos).toBe(2 * P);
    });

    it('fuera del POS no se acepta: el pedido rechaza `paraLlevar` por línea (400)', async () => {
      const l = await local();
      const d = await k.diner();
      const r = await pedir(d, { restaurante: l.o.restaurante, almuerzo: { platos: [l.sopa], paraLlevar: true } });
      expect(r.statusCode).toBe(400);
    });
  });
});
