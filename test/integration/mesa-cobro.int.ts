import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Diner, DinerKit, expectOnlyPublicIds } from './diner-kit';
import { unique } from './harness';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const C = 600; // Churrasco (A_LA_CARTA, carta fija)
const B = 100; // Cola (BEBIDA, menú de hoy)
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * PR 6 (docs/spec-cobros.md D mesas, E.5–E.7, F.1, F.3 y G 28, 30–32, 34–36, 38, 39, 46 y 47): validar una mesa cobra la
 * selección de cada comensal (una cuenta por pagador con saldo), `salir` de la mesa, el acceso de quien salió (RLS) y la
 * cotización del comensal con fn_plan_pagador_mesa. Patrón probe: cada prueba termina en ROLLBACK.
 */
describe.skipIf(!probe)('PR 6: la selección de la mesa pasa a cobro', () => {
  const k = new DinerKit(probe!, 141);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Quien = { token?: string; restaurante?: string };
  type Persona = Diner & { clienteId?: string };

  /** Local activo con el menú del kit (almuerzo, Cola, Huevo frito) y un Churrasco de la carta. */
  async function local(opts: { momento?: 'ANTES_DE_SERVIR' | 'DESPUES_DE_SERVIR' } = {}) {
    const o = await k.activeOwner();
    if (opts.momento) expect((await k.as(o).patch('/v1/restaurante', { momentoCobro: opts.momento })).statusCode).toBe(200);
    const m = await k.menu(o);
    const ch = await k.as(o).post('/v1/menu/platos', { nombre: 'Churrasco', categoria: 'A_LA_CARTA', precioCentavos: C });
    expect(ch.statusCode, ch.body).toBe(201);
    const churrasco = (await probe!.sql<{ id: string }>('SELECT public_id AS id FROM plato WHERE plato_id = $1', [ch.json().id])).rows[0]!
      .id;
    return {
      o,
      seco: m['Seco de pollo']!,
      sopa: m['Sopa de quinua']!,
      cola: m.Cola!,
      huevo: m['Huevo frito']!,
      churrasco,
      churrascoId: ch.json().id,
    };
  }
  type Local = Awaited<ReturnType<typeof local>>;

  /** Comensal con plan de `almuerzos` en el local (0 = tuvo plan y lo gastó: SIN_SALDO). */
  async function conPlan(l: Local, almuerzos: number): Promise<Persona> {
    const d = await k.dinerWithPlan(l.o, { nombre: `Plan ${unique()}`, almuerzos: Math.max(1, almuerzos) });
    if (almuerzos === 0) {
      const consumo = await k.lunch(l.o, d.clienteId);
      await k.backdateLunch(consumo, 5); // que no cuente como DUPLICADO
    }
    return d;
  }

  async function mesa(
    l: Local,
    host: Persona,
    invitados: { p: Persona; llevar?: boolean }[],
    modo: 'CADA_UNO' | 'INVITO_YO',
    hostLlevar = false,
  ) {
    const r = await k
      .as(host)
      .post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo, paraLlevar: hostLlevar }, randomUUID());
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    for (const g of invitados) {
      const u = await k.as(g.p).post(`/v1/mesas/invitacion/${id}/unirse`, { paraLlevar: g.llevar ?? false }, randomUUID());
      expect(u.statusCode, u.body).toBe(200);
    }
    return id;
  }

  const elegir = async (p: Persona, mesaId: string, sel: { almuerzo?: string[]; extras?: [string, number][] }) => {
    const r = await k.as(p).put(`/v1/mis/mesas/${mesaId}/seleccion`, {
      ...(sel.almuerzo && { almuerzo: { platos: sel.almuerzo } }),
      ...(sel.extras && { extras: sel.extras.map(([plato, cantidad]) => ({ plato, cantidad })) }),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r;
  };
  const validar = (who: Quien, mesaId: string, body?: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/mesas/${mesaId}/validar`, body, key);
  const salir = (p: Persona, mesaId: string) => k.as(p).post(`/v1/mis/mesas/${mesaId}/salir`);
  const saldoPlan = async (l: Local, c: string) => (await k.as(l.o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const totales = (c: Record<string, number>) => [
    c.subtotalCentavos,
    c.recargoCentavos,
    c.totalCentavos,
    c.cubiertoPorPlanCentavos,
    c.saldoPorCobrarCentavos,
  ];
  const consumosDeMesa = async (mesaId: string) =>
    (
      await probe!.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM consumo_almuerzo c JOIN mesa_compartida m USING (mesa_compartida_id)
          WHERE m.public_id = $1 AND c.cantidad = 1`,
        [mesaId],
      )
    ).rows[0]!.n;
  const cuentasDeMesa = async (mesaId: string) =>
    (
      await probe!.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM cuenta_cobro c JOIN mesa_compartida m USING (mesa_compartida_id) WHERE m.public_id = $1`,
        [mesaId],
      )
    ).rows[0]!.n;

  describe('G: casos de mesa', () => {
    it('G-28 CADA_UNO: una cuenta por miembro con lo suyo; 1 consumo; el plan de quien solo pidió carta queda intacto', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      const b = await k.diner(); // SIN_PLAN
      const c = await conPlan(l, 0); // SIN_SALDO
      const d = await conPlan(l, 5);
      const id = await mesa(l, a, [{ p: b }, { p: c, llevar: true }, { p: d }], 'CADA_UNO');
      await elegir(a, id, { almuerzo: [l.seco], extras: [[l.cola, 1]] });
      await elegir(b, id, { almuerzo: [l.seco], extras: [[l.huevo, 1]] });
      await elegir(c, id, { almuerzo: [l.sopa] });
      await elegir(d, id, { extras: [[l.churrasco, 1]] });

      const r = await validar(l.o, id);
      expect(r.statusCode, r.body).toBe(200);
      const v = r.json();
      expect(totales(v.cotizacion)).toEqual([1825, 25, 1850, 350, 1500]);
      expect(v.cotizacion.estimada).toBe(false);
      expect(v.cuentas).toHaveLength(4);
      expect(v.cuentas.map((x: { cotizacion: Record<string, number> }) => totales(x.cotizacion))).toEqual([
        [450, 0, 450, 350, 100],
        [425, 0, 425, 0, 425],
        [350, 25, 375, 0, 375],
        [600, 0, 600, 0, 600],
      ]);
      expect(
        v.cuentas.map((x: { saldoCentavos: number; estado: string; origen: string }) => [x.origen, x.estado, x.saldoCentavos]),
      ).toEqual([
        ['MESA', 'ABIERTA', 100],
        ['MESA', 'ABIERTA', 425],
        ['MESA', 'ABIERTA', 375],
        ['MESA', 'ABIERTA', 600],
      ]);
      expect(v.cuentas[0].pagador).toEqual({ nombre: expect.any(String), esAnfitrion: true });
      expect(v.resultados.map((x: { resultado: string; descontado: boolean }) => [x.resultado, x.descontado])).toEqual([
        ['OK', true],
        ['SIN_PLAN', false],
        ['SIN_SALDO', false],
        ['SIN_ALMUERZO', false],
      ]);
      expect(v.resultados.map((x: { cuentaId: string }) => x.cuentaId)).toEqual(v.cuentas.map((x: { id: string }) => x.id));
      expect([v.descontados, v.porCobrar]).toEqual([1, 2]);
      expect(await consumosDeMesa(id)).toBe(1);
      expect(await saldoPlan(l, a.clienteId!)).toBe(4);
      expect(await saldoPlan(l, d.clienteId!)).toBe(5);
      expectOnlyPublicIds(v.cuentas);
      // La línea PLAN de A tiene su consumo (F.1); las cuentas son de solo lectura para la caja vía /cuentas.
      expect((await k.as(l.o).get(`/v1/caja/cuentas/${v.cuentas[0].id}`)).json()).toMatchObject({ origen: 'MESA', saldoCentavos: 100 });
    });

    it('G-47: repetir con la misma llave o con otra no descuenta ni crea cuentas: yaValidada con las mismas cuentas; otro cuerpo → 409', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      const b = await k.diner();
      const id = await mesa(l, a, [{ p: b }], 'CADA_UNO');
      await elegir(a, id, { almuerzo: [l.seco], extras: [[l.cola, 1]] });
      const key = randomUUID();
      const v1 = (await validar(l.o, id, undefined, key)).json();
      const ids = v1.cuentas.map((x: { id: string }) => x.id);
      expect(ids).toHaveLength(2);
      const consumo = v1.resultados[0].consumoId;

      for (const otra of [key, randomUUID()]) {
        const again = await validar(l.o, id, {}, otra);
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toMatchObject({ yaValidada: true, resultados: [] });
        expect(again.json().cuentas.map((x: { id: string }) => x.id)).toEqual(ids);
        expect(totales(again.json().cotizacion)).toEqual(totales(v1.cotizacion));
      }
      expect(await consumosDeMesa(id)).toBe(1);
      expect(await cuentasDeMesa(id)).toBe(2);
      expect(await saldoPlan(l, a.clienteId!)).toBe(4);
      expect(
        (
          await probe!.sql<{ id: string }>(
            'SELECT public_id AS id FROM consumo_almuerzo WHERE mesa_compartida_id IS NOT NULL AND public_id = $1',
            [consumo],
          )
        ).rowCount,
      ).toBe(1);

      // Misma llave, otro cuerpo (aplicarSeleccion: false) → 409, nada cambia.
      const otro = await validar(l.o, id, { aplicarSeleccion: false }, key);
      expect(otro.statusCode).toBe(409);
      expect(otro.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      expect(await cuentasDeMesa(id)).toBe(2);
    });

    it('G-30 CADA_UNO: miembro DUPLICADO (validado por QR hace segundos): el almuerzo se omite, la Cola se cobra', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      await k.lunch(l.o, a.clienteId!);
      const id = await mesa(l, a, [], 'CADA_UNO');
      await elegir(a, id, { almuerzo: [l.seco], extras: [[l.cola, 1]] });
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([B, 0, B, 0, B]);
      expect(v.cotizacion.lineas.find((x: { tipo: string }) => x.tipo === 'ALMUERZO')).toMatchObject({
        omitida: 'DUPLICADO',
        porCobrarCentavos: 0,
      });
      expect(v.avisos).toEqual([{ codigo: 'DUPLICADO', lineaRef: expect.stringMatching(/:almuerzo$/) }]);
      expect(v.resultados[0]).toMatchObject({ resultado: 'DUPLICADO', descontado: false, cuentaId: v.cuentas[0].id });
      expect(v.porCobrar).toBe(0);
      expect(v.cuentas[0].saldoCentavos).toBe(B);
      expect(await saldoPlan(l, a.clienteId!)).toBe(4); // solo el del QR
    });

    it('G-31 INVITO_YO: anfitrión con 2; H, G1, G2 (llevar), G3 → una cuenta del anfitrión 1425/725, 2 consumos, PLAN_NO_ALCANZA', async () => {
      const l = await local();
      const h = await conPlan(l, 2);
      const [g1, g2, g3] = [await k.diner(), await k.diner(), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2, llevar: true }, { p: g3 }], 'INVITO_YO');
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([1400, 25, 1425, 700, 725]);
      const alm = v.cotizacion.lineas.filter((x: { tipo: string }) => x.tipo === 'ALMUERZO');
      expect(
        alm.map((x: { fuente: string; pagador: string; recargoCentavos: number }) => [x.fuente, x.pagador, x.recargoCentavos]),
      ).toEqual([
        ['PLAN', 'PROPIO', 0],
        ['PLAN', 'ANFITRION', 0],
        ['CAJA', 'ANFITRION', R],
        ['CAJA', 'ANFITRION', 0],
      ]);
      expect(v.avisos.map((x: { codigo: string }) => x.codigo)).toContain('PLAN_NO_ALCANZA');
      expect(v.cuentas).toHaveLength(1);
      expect(v.cuentas[0]).toMatchObject({ origen: 'MESA', estado: 'ABIERTA', saldoCentavos: 725, pagador: { esAnfitrion: true } });
      expect(new Set(v.resultados.map((x: { cuentaId: string }) => x.cuentaId))).toEqual(new Set([v.cuentas[0].id]));
      // El segundo es el último almuerzo del plan (OK_ADVERTENCIA); a G2 y G3 la base ya responde SIN_SALDO.
      expect(v.resultados.map((x: { resultado: string }) => x.resultado)).toEqual(['OK', 'OK_ADVERTENCIA', 'SIN_SALDO', 'SIN_SALDO']);
      expect([v.descontados, v.porCobrar]).toEqual([2, 2]);
      expect(await consumosDeMesa(id)).toBe(2);
      expect(await saldoPlan(l, h.clienteId!)).toBe(0);
    });

    it('G-46: la cuenta del caso 31 (725) se cobra en dos partes: 500 EFECTIVO y 225 TRANSFERENCIA; reintento y saldo viejo', async () => {
      const l = await local();
      const h = await conPlan(l, 2);
      const [g1, g2, g3] = [await k.diner(), await k.diner(), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2, llevar: true }, { p: g3 }], 'INVITO_YO');
      const cuenta = (await validar(l.o, id)).json().cuentas[0];
      expect(totales(cuenta.cotizacion)).toEqual([1400, 25, 1425, 700, 725]);
      const cobrar = (body: object, key = randomUUID()) => k.as(l.o).post(`/v1/caja/cuentas/${cuenta.id}/cobrar`, body, key);

      const p1 = await cobrar({ metodoPago: 'EFECTIVO', montoCentavos: 500, saldoEsperadoCentavos: 725 });
      expect(p1.statusCode, p1.body).toBe(200);
      expect(p1.json()).toMatchObject({ estado: 'ABIERTA', pagadoCentavos: 500, saldoCentavos: 225 });
      const viejo = await cobrar({ metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 725 });
      expect(viejo.statusCode).toBe(409);
      expect(viejo.json().code).toBe('SALDO_CAMBIO');
      const key2 = randomUUID();
      const body2 = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: 225 };
      const p2 = await cobrar(body2, key2);
      expect(p2.statusCode, p2.body).toBe(200);
      expect(p2.json()).toMatchObject({ estado: 'COBRADA', pagadoCentavos: 725, saldoCentavos: 0 });
      const p2b = await cobrar(body2, key2);
      expect(p2b.statusCode, p2b.body).toBe(200);
      expect(p2b.json().pagos).toHaveLength(2);
      expect(p2b.json().pagos.map((x: { montoCentavos: number; metodo: string }) => [x.metodo, x.montoCentavos])).toEqual([
        ['EFECTIVO', 500],
        ['TRANSFERENCIA', 225],
      ]);
    });

    it('G-32 INVITO_YO con anfitrión sin plan: todo a caja en la cuenta del anfitrión (1150)', async () => {
      const l = await local();
      const h = await k.diner();
      const [g1, g2] = [await conPlan(l, 5), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2 }], 'INVITO_YO');
      await elegir(h, id, { almuerzo: [l.seco], extras: [[l.cola, 1]] });
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([1150, 0, 1150, 0, 1150]);
      expect(v.cuentas).toHaveLength(1);
      expect(v.cuentas[0].saldoCentavos).toBe(1150);
      expect(v.resultados.map((x: { resultado: string }) => x.resultado)).toEqual(['SIN_PLAN', 'SIN_PLAN', 'SIN_PLAN']);
      expect(await consumosDeMesa(id)).toBe(0);
      expect(await saldoPlan(l, g1.clienteId!)).toBe(5); // el plan del invitado no se toca en INVITO_YO
    });

    it('G-34 INVITO_YO: el invitado (llevar) pide carta y extra sin almuerzo; todo a la cuenta del anfitrión (1050/700), 1 consumo', async () => {
      const l = await local();
      const h = await conPlan(l, 5);
      const g1 = await k.diner();
      const id = await mesa(l, h, [{ p: g1, llevar: true }], 'INVITO_YO');
      await elegir(h, id, { almuerzo: [l.seco] });
      await elegir(g1, id, {
        extras: [
          [l.churrasco, 1],
          [l.huevo, 1],
        ],
      });
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([1025, 25, 1050, 350, 700]);
      expect(v.cuentas).toHaveLength(1);
      expect(v.resultados.map((x: { resultado: string }) => x.resultado)).toEqual(['OK', 'SIN_ALMUERZO']);
      expect(await consumosDeMesa(id)).toBe(1);
      expect(await saldoPlan(l, h.clienteId!)).toBe(4);
    });

    it('G-35: aplicarSeleccion false explícito → 1 almuerzo por miembro como antes, cotización informativa, porCobrar 1, sin cuentas', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      const b = await k.diner();
      const id = await mesa(l, a, [{ p: b, llevar: true }], 'CADA_UNO');
      await elegir(b, id, { extras: [[l.cola, 2]] }); // con false la selección no se cobra
      const v = (await validar(l.o, id, { aplicarSeleccion: false })).json();
      expect(totales(v.cotizacion)).toEqual([700, 25, 725, 350, 375]);
      expect(v.cotizacion.estimada).toBe(true);
      expect(v).toMatchObject({ descontados: 1, porCobrar: 1, cuentas: [] });
      expect(v.resultados.map((x: { cuentaId: null }) => x.cuentaId)).toEqual([null, null]);
      expect(await cuentasDeMesa(id)).toBe(0);
    });

    it('G-36 INVITO_YO: la vista previa estimaba 2 cubiertos; el plan se gastó antes de validar → manda la base (Cub 350, Saldo 700)', async () => {
      const l = await local();
      const h = await conPlan(l, 2);
      const [g1, g2] = [await k.diner(), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2 }], 'INVITO_YO');
      const previa = (await k.as(l.o).get(`/v1/caja/mesas/${id}`)).json();
      expect(totales(previa.cotizacion)).toEqual([1050, 0, 1050, 700, 350]);
      await k.lunch(l.o, h.clienteId!); // el anfitrión gasta un almuerzo por QR
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([1050, 0, 1050, 350, 700]);
      expect(v.cotizacion.lineas.filter((x: { tipo: string }) => x.tipo === 'ALMUERZO').map((x: { fuente: string }) => x.fuente)).toEqual([
        'PLAN',
        'CAJA',
        'CAJA',
      ]);
      expect(v.cuentas[0].saldoCentavos).toBe(700);
    });

    it('G-38 CADA_UNO: el Churrasco se agotó entre elegir y validar → omitido; saldo 0 sin cuenta; aviso PLATO_AGOTADO', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      const id = await mesa(l, a, [], 'CADA_UNO');
      await elegir(a, id, { almuerzo: [l.seco], extras: [[l.churrasco, 1]] });
      expect((await k.as(l.o).patch(`/v1/menu/platos/${l.churrascoId}/agotado`, { agotado: true })).statusCode).toBe(200);
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([350, 0, 350, 350, 0]);
      expect(v.cotizacion.lineas.find((x: { tipo: string }) => x.tipo === 'A_LA_CARTA')).toMatchObject({ omitida: 'PLATO_AGOTADO' });
      expect(v.avisos.map((x: { codigo: string }) => x.codigo)).toEqual(['PLATO_AGOTADO']);
      expect(v.cuentas).toEqual([]);
      expect(v.resultados[0]).toMatchObject({ resultado: 'OK', descontado: true, cuentaId: null });
      // Sin cuenta, deshacer el consumo de mesa funciona como siempre.
      const u = await k.as(l.o).post(`/v1/caja/consumos/${v.resultados[0].consumoId}/deshacer`);
      expect(u.statusCode, u.body).toBe(200);
      expect(await saldoPlan(l, a.clienteId!)).toBe(5);
    });

    it('G-39 INVITO_YO: G2 salió antes → no se le cobra ni aparece en resultados; 2 consumos, saldo 0, sin cuenta', async () => {
      const l = await local();
      const h = await conPlan(l, 5);
      const [g1, g2] = [await k.diner(), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2 }], 'INVITO_YO');
      expect((await salir(g2, id)).statusCode).toBe(200);
      const v = (await validar(l.o, id)).json();
      expect(totales(v.cotizacion)).toEqual([700, 0, 700, 700, 0]);
      expect(v.resultados).toHaveLength(2);
      expect(v.cuentas).toEqual([]);
      expect(v.personas).toBe(2);
      expect(v.miembros.find((x: { salio: boolean }) => x.salio)).toMatchObject({ cotizacion: null });
      expect(await consumosDeMesa(id)).toBe(2);
      expect(await saldoPlan(l, h.clienteId!)).toBe(3);
    });

    it('sin cuerpo, con {} o con aplicarSeleccion true: el mismo cobro; un campo de más → 400', async () => {
      const l = await local();
      for (const body of [undefined, {}, { aplicarSeleccion: true }]) {
        const b = await k.diner();
        const id = await mesa(l, b, [], 'CADA_UNO');
        await elegir(b, id, { extras: [[l.cola, 1]] });
        const v = (await validar(l.o, id, body)).json();
        expect(v.cuentas.map((x: { saldoCentavos: number }) => x.saldoCentavos)).toEqual([B]);
      }
      const b = await k.diner();
      const id = await mesa(l, b, [], 'CADA_UNO');
      expect((await validar(l.o, id, { aplicarSeleccion: true, cobro: {} })).statusCode).toBe(400);
      expect((await validar(l.o, id, { aplicarSeleccion: 'si' })).statusCode).toBe(400);
    });

    it('deshacer el consumo de una cuenta de mesa ABIERTA: línea inversa; la cuenta sigue con lo demás', async () => {
      const l = await local();
      const a = await conPlan(l, 5);
      const id = await mesa(l, a, [], 'CADA_UNO', true);
      await elegir(a, id, { almuerzo: [l.seco], extras: [[l.cola, 1]] });
      const v = (await validar(l.o, id)).json();
      expect(v.cuentas[0].saldoCentavos).toBe(R + B);
      const u = await k.as(l.o).post(`/v1/caja/consumos/${v.resultados[0].consumoId}/deshacer`);
      expect(u.statusCode, u.body).toBe(200);
      expect((await k.as(l.o).get(`/v1/caja/cuentas/${v.cuentas[0].id}`)).json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: B });
      expect(await saldoPlan(l, a.clienteId!)).toBe(5);
    });

    it('agregar o quitar platos en una cuenta de mesa → 409 CUENTA_DE_MESA (no se toca); cobrar y anular sí', async () => {
      const l = await local();
      const a = await k.diner();
      const id = await mesa(l, a, [], 'CADA_UNO');
      const cuenta = (await validar(l.o, id)).json().cuentas[0];
      const add = await k.as(l.o).post(`/v1/caja/cuentas/${cuenta.id}/items`, { items: [{ plato: l.cola, cantidad: 1 }] }, randomUUID());
      expect(add.statusCode).toBe(409);
      expect(add.json().code).toBe('CUENTA_DE_MESA');
      const ref = cuenta.cotizacion.lineas[0].ref as string;
      const q = await k.as(l.o).post(`/v1/caja/cuentas/${cuenta.id}/lineas/${encodeURIComponent(ref)}/quitar`, undefined, randomUUID());
      expect(q.json().code).toBe('CUENTA_DE_MESA');
      const an = await k.as(l.o).post(`/v1/caja/cuentas/${cuenta.id}/anular`, { motivo: 'prueba' }, randomUUID());
      expect(an.json()).toMatchObject({ estado: 'ANULADA' });
      // Anulada, la mesa sigue validada: un reintento la muestra con su estado.
      expect((await validar(l.o, id)).json().cuentas.map((x: { estado: string }) => x.estado)).toEqual(['ANULADA']);
    });

    it('la lista de cuentas del día filtra por origen MESA', async () => {
      const l = await local();
      const a = await k.diner();
      const id = await mesa(l, a, [], 'CADA_UNO');
      const cuenta = (await validar(l.o, id)).json().cuentas[0];
      const lista = (await k.as(l.o).get('/v1/caja/cuentas?origen=MESA')).json();
      expect(lista.items.map((x: { id: string }) => x.id)).toEqual([cuenta.id]);
      expect((await k.as(l.o).get('/v1/caja/cuentas?origen=QR')).json().items).toEqual([]);
    });
  });

  describe('salir de la mesa (E.7) y reingreso', () => {
    it('un invitado sale: 200 con la mesa (salio: true), su selección se borra; repetir es 200; validar lo ignora', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const id = await mesa(l, h, [{ p: g }], 'CADA_UNO');
      await elegir(g, id, { extras: [[l.cola, 2]] });
      const r = await salir(g, id);
      expect(r.statusCode, r.body).toBe(200);
      const yo = r.json().miembros.find((x: { soyYo: boolean }) => x.soyYo);
      expect(yo).toMatchObject({ salio: true, seleccion: { almuerzo: null, extras: [] }, cotizacion: null });
      expect((await salir(g, id)).statusCode).toBe(200);
      // El anfitrión lo ve como salido; no cuenta en su cotización.
      const vh = (await k.as(h).get(`/v1/mis/mesas/${id}`)).json();
      expect(vh.miembros.map((x: { salio: boolean }) => x.salio)).toEqual([false, true]);
      expect(vh.cotizacion.lineas.every((x: { personaRef: string }) => x.personaRef !== undefined)).toBe(true);
      expect(totales(vh.cotizacion)).toEqual([P, 0, P, 0, P]);
      const caja = (await k.as(l.o).get(`/v1/caja/mesas/${id}`)).json();
      expect(caja.personas).toBe(1);
      expect(caja.miembros[1]).toMatchObject({ salio: true, cotizacion: null });
      const v = (await validar(l.o, id)).json();
      expect(v.resultados).toHaveLength(1);
      expect(v.cuentas.map((x: { saldoCentavos: number }) => x.saldoCentavos)).toEqual([P]);
    });

    it('errores: anfitrión 409 ANFITRION_NO_PUEDE_SALIR; mesa validada o cancelada 409 MESA_CERRADA; no miembro 404', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const id = await mesa(l, h, [{ p: g }], 'CADA_UNO');
      const e1 = await salir(h, id);
      expect([e1.statusCode, e1.json().code]).toEqual([409, 'ANFITRION_NO_PUEDE_SALIR']);
      const e2 = await salir(await k.diner(), id);
      expect([e2.statusCode, e2.json().code]).toEqual([404, 'MESA_NO_ENCONTRADA']);
      expect((await salir(g, randomUUID())).statusCode).toBe(404);
      await validar(l.o, id);
      // Ya validada: la cuenta (si la hay) queda; se cobra o se anula en caja (D «se va después de validar»).
      const e3 = await salir(g, id);
      expect([e3.statusCode, e3.json().code]).toEqual([409, 'MESA_CERRADA']);
      const id2 = await mesa(l, h, [{ p: g }], 'CADA_UNO');
      expect((await k.as(h).post(`/v1/mis/mesas/${id2}/cancelar`)).statusCode).toBe(200);
      expect((await salir(g, id2)).json().code).toBe('MESA_CERRADA');
    });

    it('quien salió no puede elegir (409 SALISTE_DE_LA_MESA); puede volver a unirse y elegir; vuelve a contar y se le cobra', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const id = await mesa(l, h, [{ p: g }], 'CADA_UNO');
      await salir(g, id);
      const sel = await k.as(g).put(`/v1/mis/mesas/${id}/seleccion`, { extras: [{ plato: l.cola, cantidad: 1 }] });
      expect([sel.statusCode, sel.json().code]).toEqual([409, 'SALISTE_DE_LA_MESA']);
      const inv = (await k.as(g).get(`/v1/mesas/invitacion/${id}`)).json();
      expect(inv).toMatchObject({ personas: 1, puedeUnirse: true, motivo: null });
      const u = await k.as(g).post(`/v1/mesas/invitacion/${id}/unirse`, { paraLlevar: true }, randomUUID());
      expect(u.statusCode, u.body).toBe(200);
      expect(u.json().miembros.find((x: { soyYo: boolean }) => x.soyYo)).toMatchObject({ salio: false, paraLlevar: true });
      expect((await k.as(g).get(`/v1/mesas/invitacion/${id}`)).json()).toMatchObject({ personas: 2, motivo: 'YA_ERES_MIEMBRO' });
      // Una sola fila por usuario: volvió con la misma.
      const filas = await probe!.sql(
        `SELECT 1 FROM mesa_compartida_miembro x JOIN mesa_compartida m USING (mesa_compartida_id) JOIN usuario u ON u.usuario_id = x.usuario_id
          WHERE m.public_id = $1 AND u.public_id = $2`,
        [id, g.usuarioId],
      );
      expect(filas.rowCount).toBe(1);
      await elegir(g, id, { extras: [[l.cola, 1]] });
      const v = (await validar(l.o, id)).json();
      expect(v.cuentas.map((x: { saldoCentavos: number }) => x.saldoCentavos)).toEqual([P, B]);
    });

    it('reingreso con las reglas de un invitado nuevo: mesa llena (sin contar a los que salieron), validada', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const otros = await Promise.all(Array.from({ length: 10 }, () => k.diner()));
      const id = await mesa(l, h, [{ p: g }, ...otros.map((p) => ({ p }))], 'CADA_UNO'); // 12
      await salir(g, id);
      // Quien salió no ocupa lugar: entra otro.
      const nuevo = await k.diner();
      expect((await k.as(nuevo).post(`/v1/mesas/invitacion/${id}/unirse`, {}, randomUUID())).statusCode).toBe(200);
      const lleno = await k.as(g).post(`/v1/mesas/invitacion/${id}/unirse`, {}, randomUUID());
      expect([lleno.statusCode, lleno.json().code]).toEqual([409, 'MESA_LLENA']);
      expect((await k.as(g).get(`/v1/mesas/invitacion/${id}`)).json()).toMatchObject({ personas: 12, motivo: 'MESA_LLENA' });
      await validar(l.o, id);
      expect((await k.as(g).post(`/v1/mesas/invitacion/${id}/unirse`, {}, randomUUID())).json().code).toBe('MESA_CERRADA');
    });
  });

  describe('cotización del comensal con fn_plan_pagador_mesa (E.6: sin null por el plan ajeno)', () => {
    it('CADA_UNO: el anfitrión ve la de cada invitado y la de la mesa; el invitado solo la suya; coinciden con la caja', async () => {
      const l = await local();
      const h = await conPlan(l, 5);
      const g = await conPlan(l, 20);
      const s = await k.diner();
      const id = await mesa(l, h, [{ p: g, llevar: true }, { p: s }], 'CADA_UNO');
      await elegir(s, id, { extras: [[l.cola, 1]] });
      const caja = (await k.as(l.o).get(`/v1/caja/mesas/${id}`)).json();
      const vh = (await k.as(h).get(`/v1/mis/mesas/${id}`)).json();
      expect(vh.miembros.map((x: { cotizacion: unknown }) => x.cotizacion !== null)).toEqual([true, true, true]);
      expect(vh.miembros.map((x: { cotizacion: Record<string, number> }) => totales(x.cotizacion))).toEqual(
        caja.miembros.map((x: { cotizacion: Record<string, number> }) => totales(x.cotizacion)),
      );
      expect(totales(vh.cotizacion)).toEqual(totales(caja.cotizacion));
      expect(totales(vh.miembros[1].cotizacion)).toEqual([P, R, P + R, P, R]); // el plan del invitado lo cubre
      const vg = (await k.as(g).get(`/v1/mis/mesas/${id}`)).json();
      expect(vg.miembros.map((x: { cotizacion: unknown }) => x.cotizacion !== null)).toEqual([false, true, false]);
      expect(vg.cotizacion).toBeNull();
      // Nada del plan ajeno en la respuesta: ni nombre del plan ni saldo (el invitado tiene 20).
      expect(JSON.stringify(vh)).not.toMatch(/almuerzosDisponibles|almuerzosRestantes|"disponibles"/);
    });

    it('INVITO_YO: el invitado ve su parte con el plan del anfitrión (antes null); el anfitrión ve todo', async () => {
      const l = await local();
      const h = await conPlan(l, 1);
      const [g1, g2] = [await k.diner(), await k.diner()];
      const id = await mesa(l, h, [{ p: g1 }, { p: g2 }], 'INVITO_YO');
      const caja = (await k.as(l.o).get(`/v1/caja/mesas/${id}`)).json();
      const v1 = (await k.as(g1).get(`/v1/mis/mesas/${id}`)).json();
      expect(totales(v1.miembros[1].cotizacion)).toEqual(totales(caja.miembros[1].cotizacion));
      expect(v1.miembros[1].cotizacion.lineas[0]).toMatchObject({ fuente: 'CAJA', pagador: 'ANFITRION' }); // el plan de 1 cubre al anfitrión
      expect(v1.miembros.map((x: { cotizacion: unknown }) => x.cotizacion !== null)).toEqual([false, true, false]);
      const vh = (await k.as(h).get(`/v1/mis/mesas/${id}`)).json();
      expect(totales(vh.cotizacion)).toEqual(totales(caja.cotizacion));
      expect(totales(vh.cotizacion)).toEqual([3 * P, 0, 3 * P, P, 2 * P]);
    });

    it('quien salió no obtiene cotizaciones (ni la suya ni la de la mesa)', async () => {
      const l = await local();
      const h = await conPlan(l, 5);
      const g = await k.diner();
      const id = await mesa(l, h, [{ p: g }], 'INVITO_YO');
      await salir(g, id);
      const vg = (await k.as(g).get(`/v1/mis/mesas/${id}`)).json();
      expect(vg.miembros.map((x: { cotizacion: unknown }) => x.cotizacion)).toEqual([null, null]);
      expect(vg.cotizacion).toBeNull();
    });
  });

  describe('RLS y roles', () => {
    const interno = async (mesaId: string) =>
      (await probe!.sql<{ id: string }>('SELECT mesa_compartida_id AS id FROM mesa_compartida WHERE public_id = $1', [mesaId])).rows[0]!.id;
    const miembroDe = async (mesaId: string, p: Persona) =>
      (
        await probe!.sql<{ id: string }>(
          `SELECT x.miembro_id AS id FROM mesa_compartida_miembro x JOIN usuario u USING (usuario_id)
            WHERE x.mesa_compartida_id = $1 AND u.public_id = $2`,
          [await interno(mesaId), p.usuarioId],
        )
      ).rows[0]!.id;
    const restauranteInterno = async (l: Local) =>
      (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [l.o.restaurante])).rows[0]!
        .id;

    it('bck_api: quien salió no lee, no escribe ni borra selección; el anfitrión sigue leyendo la de los que están', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const quedan = await k.diner();
      const id = await mesa(l, h, [{ p: g }, { p: quedan }], 'CADA_UNO');
      await elegir(g, id, { extras: [[l.cola, 1]] });
      await elegir(quedan, id, { extras: [[l.huevo, 1]] });
      const mg = await miembroDe(id, g);
      const yoG = { userId: await k.internalUser(g.usuarioId) };
      expect(await k.rls(yoG, 'SELECT 1 FROM mesa_compartida_miembro_item WHERE miembro_id = $1', [mg])).toHaveLength(1);
      await salir(g, id);

      // Insertar como si siguiera: lo rechaza la política (no solo la API).
      const cola = (await probe!.sql<{ id: string }>('SELECT plato_id AS id FROM plato WHERE public_id = $1', [l.cola])).rows[0]!.id;
      await expect(
        k.rls(
          yoG,
          `INSERT INTO mesa_compartida_miembro_item (miembro_id, mesa_compartida_id, restaurante_id, plato_id, cantidad)
           VALUES ($1, $2, $3, $4, 1)`,
          [mg, await interno(id), await restauranteInterno(l), cola],
        ),
      ).rejects.toThrow(/row-level security/);
      // Un ítem dejado por el servicio (no debería existir) tampoco se lee ni se borra.
      await probe!.sql(
        `INSERT INTO mesa_compartida_miembro_item (miembro_id, mesa_compartida_id, restaurante_id, plato_id, cantidad) VALUES ($1, $2, $3, $4, 1)`,
        [mg, await interno(id), await restauranteInterno(l), cola],
      );
      expect(await k.rls(yoG, 'SELECT 1 FROM mesa_compartida_miembro_item WHERE miembro_id = $1', [mg])).toHaveLength(0);
      expect(await k.rls(yoG, 'DELETE FROM mesa_compartida_miembro_item WHERE miembro_id = $1 RETURNING 1', [mg])).toHaveLength(0);
      expect(await k.rls(yoG, 'SELECT fn_plan_pagador_mesa($1, $2) AS n', [await interno(id), mg])).toEqual([{ n: null }]);
      // Sigue viendo la mesa (salir responde la mesa y queda en «Mis mesas»).
      expect(await k.rls(yoG, 'SELECT 1 FROM mesa_compartida WHERE public_id = $1', [id])).toHaveLength(1);
      // El anfitrión ve la selección de quien sigue (y la que quedó del que salió, que solo el servicio pudo dejar).
      const yoH = { userId: await k.internalUser(h.usuarioId) };
      expect(
        (await k.rls(yoH, 'SELECT miembro_id FROM mesa_compartida_miembro_item WHERE mesa_compartida_id = $1', [await interno(id)])).length,
      ).toBe(2);
      // bck_servicio (BYPASSRLS) ve todo.
      const mesaInterna = await interno(id); // fuera del callback: el probe tiene una sola conexión
      const todo = await k.h.db.service(
        async (q) => (await q.query('SELECT 1 FROM mesa_compartida_miembro_item WHERE mesa_compartida_id = $1', [mesaInterna])).rowCount,
      );
      expect(todo).toBe(2);
    });

    it('cuentas de mesa por RLS: el pagador ve la suya; el invitado de INVITO_YO, un comensal ajeno y otro local no ven nada; el servicio todo', async () => {
      const l = await local();
      const h = await k.diner();
      const g = await k.diner();
      const id = await mesa(l, h, [{ p: g }], 'INVITO_YO');
      const v = (await validar(l.o, id)).json();
      expect(v.cuentas).toHaveLength(1);
      const sql = `SELECT c.public_id::text AS id FROM cuenta_cobro c JOIN mesa_compartida m USING (mesa_compartida_id) WHERE m.public_id = $1`;
      const lineas = `SELECT 1 FROM cuenta_cobro_linea l JOIN cuenta_cobro c USING (cuenta_id) JOIN mesa_compartida m USING (mesa_compartida_id) WHERE m.public_id = $1`;
      const yoH = { userId: await k.internalUser(h.usuarioId) };
      const yoG = { userId: await k.internalUser(g.usuarioId) };
      const ajeno = { userId: await k.internalUser((await k.diner()).usuarioId) };
      expect(await k.rls(yoH, sql, [id])).toEqual([{ id: v.cuentas[0].id }]);
      expect((await k.rls(yoH, lineas, [id])).length).toBe(2);
      expect(await k.rls(yoG, sql, [id])).toEqual([]);
      expect(await k.rls(yoG, lineas, [id])).toEqual([]);
      expect(await k.rls(ajeno, sql, [id])).toEqual([]);
      const otro = await k.activeOwner();
      const otroId = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [otro.restaurante])
      ).rows[0]!.id;
      expect(await k.rls({ tenantId: otroId }, sql, [id])).toEqual([]);
      expect(await k.rls({ tenantId: await restauranteInterno(l) }, sql, [id])).toHaveLength(1);
      // El comensal no escribe cuentas.
      // El comensal no escribe cuentas: RLS no le deja ninguna fila (ni la suya).
      expect(await k.rls(yoH, `UPDATE cuenta_cobro SET estado = 'ANULADA' WHERE public_id = $1 RETURNING 1`, [v.cuentas[0].id])).toEqual(
        [],
      );
      expect((await k.as(l.o).get(`/v1/caja/cuentas/${v.cuentas[0].id}`)).json().estado).toBe('ABIERTA');
      const svc = await k.h.db.service(async (q) => (await q.query(sql, [id])).rows);
      expect(svc).toEqual([{ id: v.cuentas[0].id }]);
    });

    it('roles: el comensal no valida ni ve la mesa por la caja (403); otro local 404; el cajero sí valida; bck_servicio no puede llamar a fn_salir_mesa', async () => {
      const l = await local();
      const h = await k.diner();
      const id = await mesa(l, h, [], 'CADA_UNO');
      expect((await validar({ token: h.token, restaurante: l.o.restaurante }, id)).statusCode).toBe(403);
      const otro = await k.activeOwner();
      expect((await validar(otro, id)).statusCode).toBe(404);
      const caja = await k.h.cashier(l.o.restaurante);
      const v = await validar(caja, id);
      expect(v.statusCode, v.body).toBe(200);
      expect(v.json().cuentas).toHaveLength(1);
      await expect(k.h.db.service((q) => q.query('SELECT fn_salir_mesa($1)', [id]))).rejects.toThrow(/permission denied/);
      // Sin sesión de usuario la función no corre ni para la API.
      await expect(k.rls({ tenantId: await restauranteInterno(l) }, 'SELECT fn_salir_mesa($1)', [id])).rejects.toThrow(
        /usuario en la sesión/,
      );
    });
  });
});
