import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;

/**
 * PR 5a (docs/spec-cobros.md E.3, E.11, F.3, G): cuentas de cobro de pedidos canjeados en caja. Los casos G-44, G-46 y
 * G-48 de la spec son de QR (5b) y mesa (PR 6); aquí se prueban con la cuenta de un pedido, que es lo que existe hoy.
 */
describe.skipIf(!probe)('PR 5a: cuentas de cobro en caja (pedidos)', () => {
  const k = new DinerKit(probe!, 88);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Quien = { token: string; restaurante?: string };

  /** Pedido del comensal. Por defecto: con plan, para llevar, almuerzo (sopa + seco) y una Cola (total 100 + R). */
  async function pedido(opts: { plan?: boolean; almuerzos?: number; paraLlevar?: boolean; cola?: boolean; o?: Local } = {}) {
    const o = opts.o ?? (await k.activeOwner());
    const m = await k.menu(o);
    const d = opts.plan === false ? await k.diner() : await k.dinerWithPlan(o, opts.almuerzos ? { almuerzos: opts.almuerzos } : {});
    const r = await k.as(d).post(
      '/v1/mis/pedidos',
      {
        restaurante: o.restaurante,
        paraLlevar: opts.paraLlevar ?? true,
        almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] },
        extras: opts.cola === false ? [] : [{ plato: m.Cola, cantidad: 1 }],
      },
      randomUUID(),
    );
    expect(r.statusCode, r.body).toBe(201);
    return { o, m, d: d as typeof d & { clienteId?: string }, p: r.json() };
  }
  const canjear = (who: Quien, id: string, body?: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/pedidos/${id}/canjear`, body, key);
  const cobrar = (who: Quien, cuenta: string, body: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/cuentas/${cuenta}/cobrar`, body, key);
  const anular = (who: Quien, cuenta: string, body: object = {}, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/cuentas/${cuenta}/anular`, body, key);
  const saldoPlan = async (o: Quien, c: string) => (await k.as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const hoy = async (o: Local) =>
    (
      await probe!.sql<{ d: string }>(
        `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date, 'YYYY-MM-DD') AS d FROM restaurante WHERE public_id = $1`,
        [o.restaurante],
      )
    ).rows[0]!.d;
  const efectivoDelDia = async (o: Local) =>
    (await k.as(o).get(`/v1/caja/cierre/${await hoy(o)}`)).json().efectivoEsperadoCentavos as number;
  const filasCuenta = async () =>
    (
      await probe!.sql<{ cuentas: string; lineas: string; pagos: string }>(
        `SELECT (SELECT count(*) FROM cuenta_cobro) AS cuentas, (SELECT count(*) FROM cuenta_cobro_linea) AS lineas,
                (SELECT count(*) FROM transaccion_pago WHERE cuenta_cobro_id IS NOT NULL) AS pagos`,
      )
    ).rows[0]!;

  describe('canjear con cobro', () => {
    it('sin cuerpo (o con {}) es el canje de siempre: no crea cuenta y agrega cotizacion final, cuenta null y avisos', async () => {
      const { o, d, p } = await pedido();
      const antes = await filasCuenta();
      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        yaCanjeado: false,
        almuerzo: { resultado: 'OK', descontado: true },
        porCobrarCentavos: 100 + R,
        cuenta: null,
        avisos: [],
        cotizacion: { estimada: false, subtotalCentavos: P + 100, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: 100 + R },
      });
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      expect(await filasCuenta()).toEqual(antes);
      expectOnlyPublicIds(r.json());
    });

    it('G-18b/G-43: cuenta ABIERTA (saldo = recargo); deshacer el consumo la anula y devuelve el almuerzo', async () => {
      const { o, d, p } = await pedido({ cola: false });
      expect(p.totalCentavos).toBe(R);
      const r = await canjear(o, p.id, { cobro: {} });
      expect(r.statusCode, r.body).toBe(200);
      const cuenta = r.json().cuenta;
      expect(cuenta).toMatchObject({
        origen: 'PEDIDO',
        estado: 'ABIERTA',
        saldoCentavos: R,
        pagadoCentavos: 0,
        pagos: [],
        cotizacion: { estimada: false, recargoCentavos: R, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: R },
      });
      expect(r.json().porCobrarCentavos).toBe(R);
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      expectOnlyPublicIds(r.json());

      const u = await k.as(o).post(`/v1/caja/consumos/${r.json().almuerzo.consumoId}/deshacer`);
      expect(u.statusCode, u.body).toBe(200);
      expect(await saldoPlan(o, d.clienteId!)).toBe(5);
      const c = (await k.as(o).get(`/v1/caja/cuentas/${cuenta.id}`)).json();
      expect(c).toMatchObject({ estado: 'ANULADA', saldoCentavos: 0, cotizacion: { totalCentavos: 0, saldoPorCobrarCentavos: 0 } });
      // El reverso es una línea más con cantidad negativa y el mismo ref (las líneas no se editan).
      expect(c.cotizacion.lineas.map((l: { cantidad: number; ref: string }) => l.cantidad)).toEqual([1, -1]);
      expect(new Set(c.cotizacion.lineas.map((l: { ref: string }) => l.ref)).size).toBe(1);
    });

    it('G-18a/G-45: cobrado en EFECTIVO en el mismo paso → COBRADA; deshacer el consumo → 409 CUENTA_COBRADA sin cambios', async () => {
      const { o, d, p } = await pedido({ cola: false });
      const r = await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: R } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().cuenta).toMatchObject({
        estado: 'COBRADA',
        saldoCentavos: 0,
        pagadoCentavos: R,
        pagos: [{ metodo: 'EFECTIVO', montoCentavos: R, estado: 'CONFIRMADO' }],
      });
      expect(r.json().porCobrarCentavos).toBe(R);
      const u = await k.as(o).post(`/v1/caja/consumos/${r.json().almuerzo.consumoId}/deshacer`);
      expect(u.statusCode, u.body).toBe(409);
      expect(u.json().code).toBe('CUENTA_COBRADA');
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      expect((await k.as(o).get(`/v1/caja/cuentas/${r.json().cuenta.id}`)).json()).toMatchObject({ estado: 'COBRADA', saldoCentavos: 0 });
    });

    it('G-44 (pedido): cobrado en EFECTIVO y anulado → pago inverso, plan +1 y efectivo del día neto 0', async () => {
      const { o, d, p } = await pedido();
      const efectivo0 = await efectivoDelDia(o);
      const r = await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R } });
      expect(r.statusCode, r.body).toBe(200);
      const cuenta = r.json().cuenta;
      expect(cuenta).toMatchObject({ estado: 'COBRADA', pagadoCentavos: 100 + R });
      expect(await efectivoDelDia(o)).toBe(efectivo0 + 100 + R);
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);

      const key = randomUUID();
      const a = await anular(o, cuenta.id, { motivo: 'Se equivocó de pedido' }, key);
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ estado: 'ANULADA', anuladaEn: expect.any(String), saldoCentavos: 0, pagadoCentavos: 0 });
      expect(
        a
          .json()
          .pagos.map((x: { montoCentavos: number }) => x.montoCentavos)
          .sort(),
      ).toEqual([-(100 + R), 100 + R].sort());
      expect(a.json().cotizacion).toMatchObject({ totalCentavos: 0, saldoPorCobrarCentavos: 0 });
      expect(await saldoPlan(o, d.clienteId!)).toBe(5);
      expect(await efectivoDelDia(o)).toBe(efectivo0);
      // Repetir (misma u otra llave) devuelve la cuenta anulada sin otro reverso.
      for (const again of [key, randomUUID()]) expect((await anular(o, cuenta.id, {}, again)).json()).toEqual(a.json());
      expect(await saldoPlan(o, d.clienteId!)).toBe(5);
      // Deshacer el consumo ya revertido por la anulación no devuelve otro almuerzo.
      const u = await k.as(o).post(`/v1/caja/consumos/${r.json().almuerzo.consumoId}/deshacer`);
      expect(u.statusCode).toBeLessThan(500);
      expect(await saldoPlan(o, d.clienteId!)).toBe(5);
    });

    it('G-46 (pedido): sin plan, dos pagos parciales (EFECTIVO y TRANSFERENCIA confirmada); reintento y saldo viejo', async () => {
      const { o, p } = await pedido({ plan: false, paraLlevar: false });
      const total = P + 100;
      expect(p.totalCentavos).toBe(total);
      const c = (await canjear(o, p.id, { cobro: {} })).json().cuenta;
      expect(c).toMatchObject({ estado: 'ABIERTA', saldoCentavos: total });

      const p1 = await cobrar(o, c.id, { metodoPago: 'EFECTIVO', montoCentavos: 200, saldoEsperadoCentavos: total });
      expect(p1.statusCode, p1.body).toBe(200);
      expect(p1.json()).toMatchObject({ estado: 'ABIERTA', pagadoCentavos: 200, saldoCentavos: total - 200 });

      // La caja con la pantalla vieja (esperaba el total): 409 con el saldo real y no cobra.
      const viejo = await cobrar(o, c.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: total });
      expect(viejo.statusCode).toBe(409);
      expect(viejo.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: total - 200 });

      const key = randomUUID();
      const body = {
        metodoPago: 'TRANSFERENCIA',
        pagoConfirmado: true,
        saldoEsperadoCentavos: total - 200,
        referenciaExterna: `T-${randomUUID()}`,
      };
      const p2 = await cobrar(o, c.id, body, key);
      expect(p2.statusCode, p2.body).toBe(200);
      expect(p2.json()).toMatchObject({ estado: 'COBRADA', saldoCentavos: 0, pagadoCentavos: total, cobradaEn: expect.any(String) });
      expect(p2.json().pagos).toHaveLength(2);
      // El reintento con la misma llave es el mismo pago (aunque la cuenta ya esté cobrada).
      const again = await cobrar(o, c.id, body, key);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().pagos).toEqual(p2.json().pagos);
      // Misma llave con otro monto: 409.
      const otro = await cobrar(o, c.id, { ...body, montoCentavos: 1 }, key);
      expect(otro.statusCode).toBe(409);
      expect(otro.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      // Cuenta cobrada: otro pago → 409 CUENTA_CERRADA.
      const cerrada = await cobrar(o, c.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 0 });
      expect(cerrada.json().code).toBe('CUENTA_CERRADA');
    });

    it('G-48 (pedido): misma llave con otro cobro → 409 IDEMPOTENCY_KEY_REUTILIZADA; mismo cuerpo → la misma cuenta', async () => {
      const { o, p } = await pedido();
      const key = randomUUID();
      const r = await canjear(o, p.id, { cobro: {} }, key);
      expect(r.statusCode, r.body).toBe(200);
      const otro = await canjear(o, p.id, { cobro: { saldoEsperadoCentavos: 100 + R } }, key);
      expect(otro.statusCode).toBe(409);
      expect(otro.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      const mismo = await canjear(o, p.id, { cobro: {} }, key);
      expect(mismo.statusCode, mismo.body).toBe(200);
      expect(mismo.json()).toMatchObject({
        yaCanjeado: true,
        cuenta: { id: r.json().cuenta.id },
        almuerzo: { consumoId: r.json().almuerzo.consumoId },
      });
      // Otra llave: ya canjeado, misma cuenta, sin otro consumo ni otra cuenta.
      const otraLlave = await canjear(o, p.id, undefined, randomUUID());
      expect(otraLlave.json()).toMatchObject({ yaCanjeado: true, cuenta: { id: r.json().cuenta.id } });
      // Solo las de este local: las suites sin probe (checkout.int.ts) confirman cuentas propias desde el PR 6b.
      const delLocal = await probe!.sql(
        'SELECT 1 FROM cuenta_cobro c JOIN restaurante r ON r.restaurante_id = c.restaurante_id WHERE r.public_id = $1',
        [o.restaurante],
      );
      expect(delLocal.rowCount).toBe(1);
      // La llave de ese canje en otro pedido: 409.
      const { p: p2 } = await pedido({ o });
      expect((await canjear(o, p2.id, { cobro: {} }, key)).json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
    });

    it('SALDO_CAMBIO: saldo esperado distinto → 409 con el saldo y la cotización, sin descontar el plan ni crear cuenta', async () => {
      const { o, d, p } = await pedido();
      const antes = await filasCuenta();
      const r = await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 999 } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({
        code: 'SALDO_CAMBIO',
        saldoCentavos: 100 + R,
        saldoEsperadoCentavos: 999,
        cotizacion: { estimada: false, saldoPorCobrarCentavos: 100 + R },
      });
      expect(await saldoPlan(o, d.clienteId!)).toBe(5);
      expect(await filasCuenta()).toEqual(antes);
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
    });

    it('I-6: el plan se gastó entre pedir y canjear → 409 contra totalCentavos; con el saldo nuevo confirmado, canjea y cobra', async () => {
      const o = await k.activeOwner();
      const { d, p } = await pedido({ o, almuerzos: 1 });
      // El comensal gasta su único almuerzo en caja antes de canjear el pedido (hace 5 min: no es un DUPLICADO).
      const v = await k.as(o).post('/v1/caja/validar', { clienteId: d.clienteId }, randomUUID());
      expect(v.json().descontado, v.body).toBe(true);
      await k.backdateLunch(v.json().consumo.id, 5);
      const r = await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R } });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: P + 100 + R, saldoEsperadoCentavos: 100 + R });
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
      const ok = await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: P + 100 + R } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        almuerzo: { descontado: false },
        porCobrarCentavos: P + 100 + R,
        cuenta: { estado: 'COBRADA', pagadoCentavos: P + 100 + R, cotizacion: { cubiertoPorPlanCentavos: 0 } },
      });
    });

    it('INC-06: el almuerzo se cobra al precio guardado al pedir aunque el local lo cambie después', async () => {
      const { o, p } = await pedido({ plan: false, paraLlevar: false, cola: false });
      expect(p.totalCentavos).toBe(P);
      expect((await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 500 })).statusCode).toBe(200);
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().cotizacion).toMatchObject({
        subtotalCentavos: P,
        saldoPorCobrarCentavos: P,
      });
      const r = await canjear(o, p.id, { cobro: {} });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ porCobrarCentavos: P, cuenta: { saldoCentavos: P } });
    });

    it('ANTES_DE_SERVIR: la cuenta abierta avisa que hay que cobrar antes de entregar (INC-04)', async () => {
      const o = await k.activeOwner();
      expect((await k.as(o).patch('/v1/restaurante', { momentoCobro: 'ANTES_DE_SERVIR' })).statusCode).toBe(200);
      const { p } = await pedido({ o });
      const r = await canjear(o, p.id, { cobro: {} });
      expect(r.json().cuenta).toMatchObject({ momentoCobro: 'ANTES_DE_SERVIR', estado: 'ABIERTA', debeCobrarseAntesDeServir: true });
      const c = (await cobrar(o, r.json().cuenta.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R })).json();
      expect(c).toMatchObject({ estado: 'COBRADA', debeCobrarseAntesDeServir: false });
    });

    it('validación: cobro con campos de más o método desconocido → 400; método sin habilitar → 422', async () => {
      const { o, p } = await pedido();
      expect((await canjear(o, p.id, { cobro: { metodoPago: 'BITCOIN' } })).statusCode).toBe(400);
      expect((await canjear(o, p.id, { cobro: { propina: 5 } })).statusCode).toBe(400);
      expect((await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', montoCentavos: -1 } })).statusCode).toBe(400);
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
      const c = (await canjear(o, p.id, { cobro: {} })).json().cuenta;
      const mucho = await cobrar(o, c.id, { metodoPago: 'EFECTIVO', montoCentavos: 10_000, saldoEsperadoCentavos: 100 + R });
      expect(mucho.statusCode).toBe(422);
      expect(mucho.json().code).toBe('MONTO_EXCEDE_SALDO');
      expect((await cobrar(o, c.id, { metodoPago: 'EFECTIVO' })).statusCode).toBe(400); // falta saldoEsperadoCentavos
    });
  });

  describe('confirmar y rechazar pagos de cuenta', () => {
    it('TRANSFERENCIA pendiente cuenta para el saldo; rechazarla reabre la cuenta y confirmarla la deja cobrada', async () => {
      const { o, p } = await pedido();
      const c = (await canjear(o, p.id, { cobro: {} })).json().cuenta;
      const t = await cobrar(o, c.id, { metodoPago: 'TRANSFERENCIA', saldoEsperadoCentavos: 100 + R });
      expect(t.json()).toMatchObject({ estado: 'COBRADA', saldoCentavos: 0, pagos: [{ estado: 'PENDIENTE' }] });
      const pago = t.json().pagos[0].id as string;
      // Solo el dueño confirma o rechaza.
      const cajero = await k.h.cashier(o.restaurante);
      expect((await k.as(cajero).post(`/v1/pagos/${pago}/rechazar`)).statusCode).toBe(403);

      const rech = await k.as(o).post(`/v1/pagos/${pago}/rechazar`);
      expect(rech.statusCode, rech.body).toBe(200);
      expect(rech.json()).toMatchObject({
        id: c.id,
        estado: 'ABIERTA',
        saldoCentavos: 100 + R,
        pagos: [{ id: pago, estado: 'RECHAZADO' }],
      });
      expect((await k.as(o).post(`/v1/pagos/${pago}/rechazar`)).json()).toEqual(rech.json()); // repetir: lo mismo
      expect((await k.as(o).post(`/v1/pagos/${pago}/confirmar`)).statusCode).toBe(409);

      const t2 = (await cobrar(o, c.id, { metodoPago: 'DEUNA', saldoEsperadoCentavos: 100 + R })).json();
      const pago2 = t2.pagos.find((x: { estado: string }) => x.estado === 'PENDIENTE').id as string;
      const conf = await k.as(o).post(`/v1/pagos/${pago2}/confirmar`);
      expect(conf.statusCode, conf.body).toBe(200);
      expect(conf.json()).toMatchObject({ estado: 'COBRADA', saldoCentavos: 0 });
      expect(conf.json().pagos.find((x: { id: string }) => x.id === pago2).estado).toBe('CONFIRMADO');
      // Los pagos de cuentas no se mezclan con la lista de planes por confirmar.
      expect((await k.as(o).get('/v1/pagos/pendientes')).json().every((x: { id: string }) => x.id !== pago2)).toBe(true);
    });

    it('anular con un pago pendiente lo rechaza (no hay dinero que devolver)', async () => {
      const { o, p } = await pedido();
      const c = (await canjear(o, p.id, { cobro: {} })).json().cuenta;
      await cobrar(o, c.id, { metodoPago: 'TRANSFERENCIA', saldoEsperadoCentavos: 100 + R });
      const a = (await anular(o, c.id)).json();
      expect(a).toMatchObject({ estado: 'ANULADA', pagos: [{ estado: 'RECHAZADO', montoCentavos: 100 + R }] });
    });

    it('la misma referencia externa en dos cuentas → 409 REFERENCIA_PAGO_REPETIDA', async () => {
      const o = await k.activeOwner();
      const ref = `T-${randomUUID()}`;
      const cuentas = [];
      for (let i = 0; i < 2; i++) {
        const { p } = await pedido({ o });
        cuentas.push((await canjear(o, p.id, { cobro: {} })).json().cuenta.id as string);
      }
      const body = { metodoPago: 'TRANSFERENCIA', saldoEsperadoCentavos: 100 + R, referenciaExterna: ref };
      expect((await cobrar(o, cuentas[0]!, body)).statusCode).toBe(200);
      const dup = await cobrar(o, cuentas[1]!, body);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe('REFERENCIA_PAGO_REPETIDA');
      // Con cobro en el canje, igual.
      const { p } = await pedido({ o });
      const c = await canjear(o, p.id, { cobro: { ...body } });
      expect(c.statusCode).toBe(409);
      expect(c.json().code).toBe('REFERENCIA_PAGO_REPETIDA');
      expect((await k.as(o).get(`/v1/caja/pedidos/${p.id}`)).json().estado).toBe('EN_CAMINO');
    });
  });

  describe('roles, tenant y RLS', () => {
    it('cajero: ve, cobra y anula cuentas del día; las de otro día solo el dueño (403 SOLO_CUENTAS_DEL_DIA)', async () => {
      const { o, p } = await pedido();
      const cajero = await k.h.cashier(o.restaurante);
      const r = await canjear(cajero, p.id, { cobro: {} });
      expect(r.statusCode, r.body).toBe(200);
      const c = r.json().cuenta;
      expect((await k.as(cajero).get(`/v1/caja/cuentas/${c.id}`)).statusCode).toBe(200);
      expect((await cobrar(cajero, c.id, { metodoPago: 'EFECTIVO', montoCentavos: 25, saldoEsperadoCentavos: 100 + R })).statusCode).toBe(
        200,
      );

      // La cuenta pasa a ser de ayer (solo aquí, como superusuario y dentro del probe).
      await probe!.sql('SET LOCAL session_replication_role = replica');
      await probe!.sql('UPDATE cuenta_cobro SET fecha_local = fecha_local - 1 WHERE public_id = $1', [c.id]);
      await probe!.sql('SET LOCAL session_replication_role = origin');
      const no = await anular(cajero, c.id);
      expect(no.statusCode).toBe(403);
      expect(no.json().code).toBe('SOLO_CUENTAS_DEL_DIA');
      expect((await anular(o, c.id)).json().estado).toBe('ANULADA');
    });

    it('otro local → 404; comensal o sin sesión → 403/401; id que no existe → 404', async () => {
      const { o, d, p } = await pedido();
      const c = (await canjear(o, p.id, { cobro: {} })).json().cuenta;
      const otro = await k.activeOwner();
      for (const call of [
        k.as(otro).get(`/v1/caja/cuentas/${c.id}`),
        cobrar(otro, c.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R }),
        anular(otro, c.id),
      ])
        expect((await call).statusCode).toBe(404);
      expect((await k.as(d).get(`/v1/caja/cuentas/${c.id}`)).statusCode).toBe(400); // sin x-restaurant-id
      expect((await k.as({ ...d, restaurante: o.restaurante }).get(`/v1/caja/cuentas/${c.id}`)).statusCode).toBe(403);
      expect((await k.as({}).get(`/v1/caja/cuentas/${c.id}`)).statusCode).toBe(401);
      const nada = await k.as(o).get(`/v1/caja/cuentas/${randomUUID()}`);
      expect(nada.statusCode).toBe(404);
      expect(nada.json().code).toBe('CUENTA_NO_ENCONTRADA');
      expect((await k.as(o).post(`/v1/caja/cuentas/${c.id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 1 })).statusCode).toBe(
        400,
      ); // sin llave
    });

    it('RLS: bck_api ve las cuentas, líneas y pagos de su tenant y el pagador las suyas; nadie más; bck_servicio ve todo', async () => {
      const { o, d, p } = await pedido();
      const c = (await canjear(o, p.id, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 100 + R } })).json().cuenta;
      const rid = (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [o.restaurante]))
        .rows[0]!.id;
      const otro = await k.activeOwner();
      const otroId = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [otro.restaurante])
      ).rows[0]!.id;
      const uid = await k.internalUser(d.usuarioId);
      const ajeno = await k.internalUser((await k.diner()).usuarioId);
      const q = {
        cuentas: 'SELECT public_id FROM cuenta_cobro',
        lineas: 'SELECT linea_id FROM cuenta_cobro_linea',
        pagos: 'SELECT pago_id FROM transaccion_pago WHERE cuenta_cobro_id IS NOT NULL',
        saldo: 'SELECT cuenta_id FROM v_cuenta_saldo',
      };
      for (const sql of Object.values(q)) {
        expect(await k.rls({ tenantId: String(otroId) }, sql), sql).toEqual([]);
        expect(await k.rls({ userId: ajeno }, sql), sql).toEqual([]);
        // El pagador lee su cuenta, sus líneas y sus pagos (comensal_lee): «te falta pagar X».
        expect((await k.rls({ userId: uid }, sql)).length, sql).toBeGreaterThan(0);
        expect((await k.rls({ tenantId: String(rid) }, sql)).length, sql).toBeGreaterThan(0);
      }
      expect((await k.rls({ tenantId: String(rid) }, q.cuentas)).map((x) => x.public_id)).toEqual([c.id]);
      // Insertar en otro tenant: RLS lo impide.
      await expect(
        k.rls(
          { tenantId: String(otroId) },
          `INSERT INTO cuenta_cobro_linea (cuenta_id, restaurante_id, ref, persona_ref, tipo, fuente, pagador, nombre, cantidad, precio_unitario_centavos,
                                           recargo_unitario_centavos, subtotal_centavos, recargo_centavos, cubierto_centavos, clave_idempotencia)
           SELECT cuenta_id, restaurante_id, 'x', '0', 'EXTRA', 'CAJA', 'PROPIO', 'x', 1, 1, 0, 1, 0, 0, gen_random_uuid() FROM cuenta_cobro WHERE public_id = $1`,
          [c.id],
        ),
      ).resolves.toEqual([]); // la cuenta no es visible: no inserta nada
      const servicio = await k.h.db.service(
        async (s) => (await s.query('SELECT 1 FROM cuenta_cobro WHERE public_id = $1', [c.id])).rowCount,
      );
      expect(servicio).toBe(1);
    });
  });
});
