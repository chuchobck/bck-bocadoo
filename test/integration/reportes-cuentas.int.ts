import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Diner, DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const B = 100; // Cola (BEBIDA)
const C = 600; // Churrasco (A_LA_CARTA)

/**
 * Entrega D, PR 8 (docs/spec-cobros.md H.1): el cierre de caja y los reportes del dueño incluyen lo cobrado en cuentas.
 * Una cuenta ABIERTA solo se informa; COBRADA entra por el método de sus pagos CONFIRMADOS; PENDIENTE, RECHAZADO y ANULADA no suman.
 */
describe.skipIf(!probe)('PR 8: reportes y cierre con cuentas de cobro', () => {
  const k = new DinerKit(probe!, 143);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  async function local() {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const ch = await k.as(o).post('/v1/menu/platos', { nombre: 'Churrasco', categoria: 'A_LA_CARTA', precioCentavos: C });
    expect(ch.statusCode, ch.body).toBe(201);
    const churrasco = (await probe!.sql<{ id: string }>('SELECT public_id AS id FROM plato WHERE plato_id = $1', [ch.json().id])).rows[0]!
      .id;
    return { o, cola: m.Cola!, churrasco };
  }
  type Local = Awaited<ReturnType<typeof local>>;
  const codigo = async (d: Diner, l: Local) =>
    (await k.as(d).get(`/v1/pase/codigo?restaurante=${l.o.restaurante}`)).json().codigo as string;
  /** QR de un comensal sin plan (almuerzo a P en su cuenta). */
  const qrSinPlan = async (l: Local, body: object = {}) => {
    const d = await k.diner();
    const r = await k.as(l.o).post('/v1/caja/validar', { codigoQr: await codigo(d, l), ...body }, randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    return r.json().cuenta as { id: string; estado: string; saldoCentavos: number; pagos: { id: string }[] };
  };
  const efectivo = (saldo: number) => ({ cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: saldo } });
  const transferencia = (saldo: number) => ({
    cobro: { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: saldo, referenciaExterna: `T-${randomUUID()}` },
  });
  const hoy = async (l: Local) =>
    (
      await probe!.sql<{ d: string }>(
        `SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date::text AS d FROM restaurante WHERE public_id = $1`,
        [l.o.restaurante],
      )
    ).rows[0]!.d;
  const cierre = async (l: Local) => (await k.as(l.o).get(`/v1/caja/cierre/${await hoy(l)}`)).json();
  const resumen = async (l: Local) => (await k.as(l.o).get('/v1/reportes/resumen-diario')).json();
  const metodo = (c: { porMetodo: { metodo: string }[] }, m: string) =>
    (c.porMetodo.find((x) => x.metodo === m) ?? { planesCentavos: 0, posCentavos: 0, cuentasCentavos: 0 }) as {
      planesCentavos: number;
      posCentavos: number;
      cuentasCentavos: number;
    };

  it('cuenta QR sin plan cobrada en efectivo y por transferencia entra al cierre, una sola vez', async () => {
    const l = await local();
    const base = await cierre(l);
    expect(base.cuentasCobradas).toEqual({ cantidad: 0, totalCentavos: 0 });
    await qrSinPlan(l, efectivo(P));
    await qrSinPlan(l, transferencia(P));
    const c = await cierre(l);
    expect(c.efectivoEsperadoCentavos).toBe(P);
    expect(c.totalCentavos).toBe(2 * P);
    expect(metodo(c, 'EFECTIVO')).toMatchObject({ planesCentavos: 0, posCentavos: P, cuentasCentavos: P, totalCentavos: P });
    expect(metodo(c, 'TRANSFERENCIA')).toMatchObject({ posCentavos: P, cuentasCentavos: P });
    expect(c.cuentasCobradas).toEqual({ cantidad: 2, totalCentavos: 2 * P });
    expect(c.cuentasAbiertas).toEqual({ cantidad: 0, saldoCentavos: 0 });
    expect(c).toMatchObject({ almuerzosSueltos: 2, almuerzosConPlan: 0, almuerzosServidos: 2, almuerzosParaLlevar: 0 });
  });

  it('para llevar: el almuerzo y su recargo cobrados en una cuenta suman a sueltos y a para llevar', async () => {
    const l = await local();
    await qrSinPlan(l, { paraLlevar: true, ...efectivo(P + R) });
    const c = await cierre(l);
    expect(c).toMatchObject({ almuerzosSueltos: 1, almuerzosParaLlevar: 1, efectivoEsperadoCentavos: P + R });
  });

  it('cuenta ABIERTA solo se informa en cuentasAbiertas; al cobrarla pasa a las cifras del día', async () => {
    const l = await local();
    const a = await qrSinPlan(l);
    expect(a.estado).toBe('ABIERTA');
    const c = await cierre(l);
    expect(c.cuentasAbiertas).toEqual({ cantidad: 1, saldoCentavos: P });
    expect(c).toMatchObject({ efectivoEsperadoCentavos: 0, totalCentavos: 0, almuerzosSueltos: 0, almuerzosServidos: 0 });
    expect(c.cuentasCobradas).toEqual({ cantidad: 0, totalCentavos: 0 });
    const pago = await k
      .as(l.o)
      .post(`/v1/caja/cuentas/${a.id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: P }, randomUUID());
    expect(pago.statusCode, pago.body).toBe(200);
    const d = await cierre(l);
    expect(d.cuentasAbiertas).toEqual({ cantidad: 0, saldoCentavos: 0 });
    expect(d).toMatchObject({ efectivoEsperadoCentavos: P, almuerzosSueltos: 1, cuentasCobradas: { cantidad: 1, totalCentavos: P } });
  });

  it('cuenta ANULADA y pago RECHAZADO no suman', async () => {
    const l = await local();
    const anulada = await qrSinPlan(l, efectivo(P));
    expect((await cierre(l)).efectivoEsperadoCentavos).toBe(P);
    const a = await k.as(l.o).post(`/v1/caja/cuentas/${anulada.id}/anular`, { motivo: 'Error' }, randomUUID());
    expect(a.statusCode, a.body).toBe(200);
    // Un DEUNA sin confirmar: pendiente (no suma) y, rechazado, tampoco; la cuenta vuelve a deber el almuerzo.
    const pendiente = await qrSinPlan(l, { cobro: { metodoPago: 'DEUNA', saldoEsperadoCentavos: P } });
    const antes = await cierre(l);
    // La cuenta queda COBRADA (el pago pendiente cubre el saldo): su almuerzo cuenta como suelto, el dinero no suma hasta confirmar.
    expect(antes).toMatchObject({ efectivoEsperadoCentavos: 0, totalCentavos: 0, pagosPendientes: 1, almuerzosSueltos: 1 });
    expect(antes.cuentasCobradas).toEqual({ cantidad: 1, totalCentavos: 0 });
    const pagoId = (await k.as(l.o).get(`/v1/caja/cuentas/${pendiente.id}`)).json().pagos[0].id as string;
    expect((await k.as(l.o).post(`/v1/pagos/${pagoId}/rechazar`)).statusCode).toBe(200);
    const c = await cierre(l);
    expect(c).toMatchObject({ efectivoEsperadoCentavos: 0, totalCentavos: 0, pagosPendientes: 0, almuerzosSueltos: 0 });
    expect(c.cuentasCobradas).toEqual({ cantidad: 0, totalCentavos: 0 });
    expect(c.cuentasAbiertas).toEqual({ cantidad: 1, saldoCentavos: P });
    const r = await resumen(l);
    expect(r.ingresos).toMatchObject({ totalCentavos: 0, porOrigen: { cuentas: 0, pedidos: 0 } });
    expect(r.cuentas).toMatchObject({ cobradas: 0, abiertas: 1, saldoAbiertasCentavos: P, almuerzosSueltos: 0 });
  });

  it('sin doble conteo con POS ni con planes: cada peso y cada almuerzo en un solo lugar', async () => {
    const l = await local();
    const plan = await k.plan(l.o);
    const d = await k.dinerWithPlan(l.o); // plan vendido: 1500 en efectivo
    expect(plan).toBeTruthy();
    // POS: un almuerzo suelto en efectivo (350).
    const venta = await k
      .as(l.o)
      .post('/v1/caja/ventas', { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], metodoPago: 'EFECTIVO' }, randomUUID());
    expect(venta.statusCode, venta.body).toBe(201);
    // QR con plan para llevar: el almuerzo es del plan (consumo); solo el recargo se cobra en la cuenta.
    const conPlan = await k
      .as(l.o)
      .post('/v1/caja/validar', { codigoQr: await codigo(d, l), paraLlevar: true, ...efectivo(R) }, randomUUID());
    expect(conPlan.statusCode, conPlan.body).toBe(200);
    expect(conPlan.json().cuenta).toMatchObject({ estado: 'COBRADA', pagadoCentavos: R });
    // QR sin plan: un almuerzo suelto en la cuenta.
    await qrSinPlan(l, efectivo(P));
    const c = await cierre(l);
    expect(c).toMatchObject({ almuerzosConPlan: 1, almuerzosSueltos: 2, almuerzosServidos: 3 });
    expect(c.almuerzosParaLlevar).toBe(1);
    const e = metodo(c, 'EFECTIVO');
    expect(e.planesCentavos).toBe(1500);
    expect(e.posCentavos).toBe(P + R + P); // POS 350 + cuentas 375
    expect(e.cuentasCentavos).toBe(R + P);
    expect(c.efectivoEsperadoCentavos).toBe(1500 + P + R + P);
    expect(c.cuentasCobradas).toEqual({ cantidad: 2, totalCentavos: R + P });
    const r = await resumen(l);
    expect(r.ingresos.porOrigen).toEqual({ planes: 1500, ventas: P, ofertas: 0, pedidos: 0, cuentas: R + P });
    expect(r.ingresos.totalCentavos).toBe(c.totalCentavos);
    expect(r.ventasPos.almuerzos).toBe(1);
    expect(r.cuentas.almuerzosSueltos).toBe(1);
  });

  it('el reporte del dueño coincide con el cierre del mismo día (dinero, almuerzos y cuentas), con un pedido cobrado en una cuenta', async () => {
    const l = await local();
    await qrSinPlan(l, {
      items: [
        { plato: l.cola, cantidad: 1 },
        { plato: l.churrasco, cantidad: 1 },
      ],
      ...efectivo(P + B + C),
    });
    await qrSinPlan(l, transferencia(P));
    await qrSinPlan(l); // abierta
    const d = await k.dinerWithPlan(l.o);
    const pedido = await k
      .as(d)
      .post(
        '/v1/mis/pedidos',
        { restaurante: l.o.restaurante, almuerzo: { platos: [await platoDelAlmuerzo(l)] }, extras: [{ plato: l.cola, cantidad: 1 }] },
        randomUUID(),
      );
    expect(pedido.statusCode, pedido.body).toBe(201);
    const canje = await k
      .as(l.o)
      .post(`/v1/caja/pedidos/${pedido.json().id}/canjear`, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B } }, randomUUID());
    expect(canje.json().cuenta, canje.body).toMatchObject({ origen: 'PEDIDO', estado: 'COBRADA' });

    const c = await cierre(l);
    const r = await resumen(l);
    expect(r.ingresos.totalCentavos).toBe(c.totalCentavos);
    expect(r.ingresos.porOrigen.cuentas).toBe(c.cuentasCobradas.totalCentavos);
    expect(r.ingresos.porOrigen).toMatchObject({ planes: 1500, pedidos: 0, cuentas: P + B + C + P + B });
    expect(r.ingresos.porMetodo.find((m: { metodo: string }) => m.metodo === 'EFECTIVO').centavos).toBe(c.efectivoEsperadoCentavos);
    expect(r.cuentas).toMatchObject({
      cobradas: c.cuentasCobradas.cantidad,
      abiertas: c.cuentasAbiertas.cantidad,
      saldoAbiertasCentavos: c.cuentasAbiertas.saldoCentavos,
    });
    expect(r.ventasPos.almuerzos + r.cuentas.almuerzosSueltos).toBe(c.almuerzosSueltos);
    expect(c.almuerzosSueltos).toBe(2); // los dos QR cobrados; el del pedido es del plan y el abierto no cuenta

    // Ranking: la Cola del QR cuenta en cuentas y la del pedido en pedidos, sin duplicar la del pedido; el Churrasco es solo de cuentas.
    const rk = (await k.as(l.o).get('/v1/reportes/ranking-platos')).json();
    const plato = (nombre: string) => rk.items.find((i: { plato: { nombre: string } }) => i.plato.nombre === nombre);
    expect(plato('Cola')).toMatchObject({ unidades: 2, unidadesVentas: 0, unidadesPedidos: 1, unidadesCuentas: 1 });
    expect(plato('Churrasco')).toMatchObject({ unidades: 1, unidadesCuentas: 1, ingresoCentavos: C });
    // Horas pico: informativo, no entra en total.
    const hp = (await k.as(l.o).get('/v1/reportes/horas-pico')).json();
    expect(hp.totalCuentas).toBe(c.cuentasCobradas.cantidad);
    expect(hp.porHora.reduce((s: number, h: { total: number; almuerzos: number; ventas: number }) => s + h.total, 0)).toBe(
      hp.totalAlmuerzos + hp.totalVentas,
    );
  });

  it('aislamiento entre locales: cada dueño ve solo sus cuentas', async () => {
    const a = await local();
    const b = await local();
    await qrSinPlan(a, efectivo(P));
    await qrSinPlan(a);
    const cb = await cierre(b);
    expect(cb).toMatchObject({
      efectivoEsperadoCentavos: 0,
      almuerzosSueltos: 0,
      cuentasAbiertas: { cantidad: 0 },
      cuentasCobradas: { cantidad: 0 },
    });
    const rb = await resumen(b);
    expect(rb.ingresos.porOrigen.cuentas).toBe(0);
    expect(rb.cuentas).toEqual({ cobradas: 0, abiertas: 0, saldoAbiertasCentavos: 0, almuerzosSueltos: 0 });
    const ca = await cierre(a);
    expect(ca).toMatchObject({ efectivoEsperadoCentavos: P, almuerzosSueltos: 1, cuentasAbiertas: { cantidad: 1, saldoCentavos: P } });
    expect((await k.as(b.o).get('/v1/reportes/ranking-platos')).json().items).toEqual([]);
  });

  async function platoDelAlmuerzo(l: Local) {
    return (
      await probe!.sql<{ id: string }>(
        `SELECT p.public_id AS id FROM plato p JOIN restaurante r ON r.restaurante_id = p.restaurante_id
          WHERE r.public_id = $1 AND p.nombre = 'Seco de pollo'`,
        [l.o.restaurante],
      )
    ).rows[0]!.id;
  }
});
