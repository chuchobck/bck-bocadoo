import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Diner, DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const B = 100; // Cola (BEBIDA, menú de hoy)
const C = 600; // Churrasco (A_LA_CARTA, carta fija)
const E = 75; // Huevo frito (EXTRA, menú de hoy)

/**
 * PR 5b (docs/spec-cobros.md E.4, E.11, F.3, G 17–22, 44 y 48 literales con QR): cuentas del QR en caja, lista del día,
 * agregar y quitar líneas, cuentas abiertas en el cierre, roles, RLS y referencia de pago por restaurante.
 */
describe.skipIf(!probe)('PR 5b: cuentas de cobro del QR en caja', () => {
  const k = new DinerKit(probe!, 87);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Quien = { token?: string; restaurante?: string };

  /**
   * Local activo con el menú del kit (Cola, Huevo frito) y un Churrasco de carta. `tz` se fija antes del menú. Sin
   * `momento`, el de la base (ANTES_DE_SERVIR).
   */
  async function local(opts: { momento?: 'ANTES_DE_SERVIR' | 'DESPUES_DE_SERVIR'; tz?: string } = {}) {
    const o = await k.activeOwner();
    if (opts.tz) await probe!.sql('UPDATE restaurante SET zona_horaria = $2 WHERE public_id = $1', [o.restaurante, opts.tz]);
    if (opts.momento) expect((await k.as(o).patch('/v1/restaurante', { momentoCobro: opts.momento })).statusCode).toBe(200);
    const m = await k.menu(o);
    const ch = await k.as(o).post('/v1/menu/platos', { nombre: 'Churrasco', categoria: 'A_LA_CARTA', precioCentavos: C });
    expect(ch.statusCode, ch.body).toBe(201);
    const churrasco = (await probe!.sql<{ id: string }>('SELECT public_id AS id FROM plato WHERE plato_id = $1', [ch.json().id])).rows[0]!
      .id;
    return { o, cola: m.Cola!, huevo: m['Huevo frito']!, churrasco };
  }
  type Local = Awaited<ReturnType<typeof local>>;
  const codigo = async (d: Diner, l: Local) =>
    (await k.as(d).get(`/v1/pase/codigo?restaurante=${l.o.restaurante}`)).json().codigo as string;
  const validar = (who: Quien, body: object, key = randomUUID()) => k.as(who).post('/v1/caja/validar', body, key);
  const items = (l: Local) => [
    { plato: l.cola, cantidad: 1 },
    { plato: l.churrasco, cantidad: 1 },
    { plato: l.huevo, cantidad: 1 },
  ];
  const cuenta = async (who: Quien, id: string) => (await k.as(who).get(`/v1/caja/cuentas/${id}`)).json();
  const agregar = (who: Quien, id: string, its: object[], key = randomUUID()) =>
    k.as(who).post(`/v1/caja/cuentas/${id}/items`, { items: its }, key);
  const quitar = (who: Quien, id: string, ref: string, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/cuentas/${id}/lineas/${encodeURIComponent(ref)}/quitar`, undefined, key);
  const cobrar = (who: Quien, id: string, body: object, key = randomUUID()) => k.as(who).post(`/v1/caja/cuentas/${id}/cobrar`, body, key);
  const saldoPlan = async (who: Quien, c: string) => (await k.as(who).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const hoy = async (l: Local) =>
    (
      await probe!.sql<{ d: string }>(
        `SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date, 'YYYY-MM-DD') AS d FROM restaurante WHERE public_id = $1`,
        [l.o.restaurante],
      )
    ).rows[0]!.d;
  const cierre = async (l: Local) => (await k.as(l.o).get(`/v1/caja/cierre/${await hoy(l)}`)).json();
  const filas = async () =>
    (
      await probe!.sql<{ cuentas: string; lineas: string; pagos: string; consumos: string }>(
        `SELECT (SELECT count(*) FROM cuenta_cobro) AS cuentas, (SELECT count(*) FROM cuenta_cobro_linea) AS lineas,
                (SELECT count(*) FROM transaccion_pago WHERE cuenta_cobro_id IS NOT NULL) AS pagos,
                (SELECT count(*) FROM consumo_almuerzo) AS consumos`,
      )
    ).rows[0]!;
  const origen = async (cuentaPublicId: string) =>
    (
      await probe!.sql<{ consumo: boolean; intento: boolean; resultado: string | null; usuario: string | null; cliente: string | null }>(
        `SELECT c.consumo_id IS NOT NULL AS consumo, c.intento_id IS NOT NULL AS intento, i.resultado::text AS resultado,
                c.usuario_id::text AS usuario, c.cliente_id::text AS cliente
           FROM cuenta_cobro c LEFT JOIN intento_escaneo i ON i.intento_id = c.intento_id WHERE c.public_id = $1`,
        [cuentaPublicId],
      )
    ).rows[0]!;

  describe('POST /v1/caja/validar con items y cobro', () => {
    it('sin items ni cobro es la validación de siempre: no crea cuenta (aunque haya recargo) y agrega la cotización informativa', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const antes = await filas();
      const r = await validar(l.o, { codigoQr: await codigo(d, l), paraLlevar: true });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'OK',
        descontado: true,
        cuenta: null,
        avisos: [],
        cotizacion: { estimada: false, recargoCentavos: R, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: R },
      });
      expect(Number((await filas()).cuentas)).toBe(Number(antes.cuentas));
      // Un comensal que no es cliente: SIN_PLAN como siempre, sin cotización.
      const extraño = await k.diner();
      expect((await validar(l.o, { codigoQr: await codigo(extraño, l) })).json()).toMatchObject({
        resultado: 'SIN_PLAN',
        cotizacion: null,
        cuenta: null,
      });
      expect(Number((await filas()).cuentas)).toBe(Number(antes.cuentas));
    });

    it('G-17: aquí con plan OK y cobro → nada por cobrar ni platos: sin cuenta y sin pago', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const r = await validar(l.o, { codigoQr: await codigo(d, l), cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 0 } });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'OK',
        cuenta: null,
        cotizacion: { saldoPorCobrarCentavos: 0, cubiertoPorPlanCentavos: P },
      });
      expect((await filas()).pagos).toBe('0');
    });

    it('G-18a: ANTES_DE_SERVIR, llevar con plan y cobro EFECTIVO → cuenta COBRADA (origen el consumo), pago 25', async () => {
      const l = await local({ momento: 'ANTES_DE_SERVIR' });
      const d = await k.dinerWithPlan(l.o);
      const r = await validar(l.o, {
        codigoQr: await codigo(d, l),
        paraLlevar: true,
        cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: R },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'OK',
        descontado: true,
        cuenta: {
          origen: 'QR',
          estado: 'COBRADA',
          momentoCobro: 'ANTES_DE_SERVIR',
          debeCobrarseAntesDeServir: false,
          pagadoCentavos: R,
          saldoCentavos: 0,
          pagos: [{ metodo: 'EFECTIVO', montoCentavos: R, estado: 'CONFIRMADO' }],
        },
      });
      expect(await origen(r.json().cuenta.id)).toMatchObject({ consumo: true, intento: false });
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
      // `cliente.id` de validar es el id de la ficha (interno, como en /v1/clientes): solo la cuenta se revisa aquí.
      expectOnlyPublicIds(r.json().cuenta);
      // G-45 con QR: deshacer el consumo de una cuenta cobrada → 409, sin cambios.
      const u = await k.as(l.o).post(`/v1/caja/consumos/${r.json().consumo.id}/deshacer`);
      expect(u.statusCode).toBe(409);
      expect(u.json().code).toBe('CUENTA_COBRADA');
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
      expect(await cuenta(l.o, r.json().cuenta.id)).toMatchObject({ estado: 'COBRADA', pagadoCentavos: R });
    });

    it('G-18b: DESPUES_DE_SERVIR sin metodoPago → cuenta ABIERTA con saldo 25', async () => {
      const l = await local({ momento: 'DESPUES_DE_SERVIR' });
      const d = await k.dinerWithPlan(l.o);
      const r = await validar(l.o, { codigoQr: await codigo(d, l), paraLlevar: true, cobro: {} });
      expect(r.json().cuenta).toMatchObject({ estado: 'ABIERTA', saldoCentavos: R, pagos: [], debeCobrarseAntesDeServir: false });
      expect(r.json().cuenta.cotizacion.lineas).toMatchObject([{ ref: 'almuerzo#1', fuente: 'PLAN', recargoCentavos: R }]);
    });

    it('G-20: llevar con plan que no vale hoy → cuenta ABIERTA 375 con origen el intento de escaneo (DIA_NO_VALIDO)', async () => {
      const l = await local();
      const dow = (
        await probe!.sql<{ d: number }>(
          `SELECT EXTRACT(ISODOW FROM (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria))::int AS d FROM restaurante WHERE public_id = $1`,
          [l.o.restaurante],
        )
      ).rows[0]!.d;
      const d = await k.dinerWithPlan(l.o, { diasValidos: [dow === 7 ? 1 : dow + 1] });
      const r = await validar(l.o, { codigoQr: await codigo(d, l), paraLlevar: true, cobro: {} });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'DIA_NO_VALIDO',
        descontado: false,
        consumo: null,
        cuenta: { estado: 'ABIERTA', saldoCentavos: P + R },
        cotizacion: { subtotalCentavos: P, recargoCentavos: R, cubiertoPorPlanCentavos: 0, saldoPorCobrarCentavos: P + R },
      });
      expect(await origen(r.json().cuenta.id)).toMatchObject({ consumo: false, intento: true, resultado: 'DIA_NO_VALIDO' });
      expect(await saldoPlan(l.o, d.clienteId)).toBe(5);
    });

    it('sin plan (no es cliente del local) con items → cuenta del intento SIN_PLAN a nombre del comensal; el almuerzo va a caja', async () => {
      const l = await local();
      const d = await k.diner();
      const r = await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.cola, cantidad: 2 }] });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        resultado: 'SIN_PLAN',
        descontado: false,
        cliente: null,
        cuenta: { origen: 'QR', estado: 'ABIERTA', saldoCentavos: P + 2 * B },
        cotizacion: { subtotalCentavos: P + 2 * B, cubiertoPorPlanCentavos: 0 },
      });
      const or = await origen(r.json().cuenta.id);
      expect(or).toMatchObject({ intento: true, resultado: 'SIN_PLAN', cliente: null });
      expect(or.usuario).toBe(await k.internalUser(d.usuarioId));
      expect(r.json().cuenta.pagador.nombre).toBeTruthy();
    });

    it('MANUAL (clienteId) con items: igual que por QR', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const r = await validar(l.o, { clienteId: d.clienteId, items: [{ plato: l.huevo, cantidad: 1 }] });
      expect(r.json()).toMatchObject({ resultado: 'OK', cuenta: { estado: 'ABIERTA', saldoCentavos: E } });
    });

    it('G-21 / G-44 literal: QR llevar con plan + Cola, Churrasco y Huevo cobrado en EFECTIVO (825); anular → todo vuelve', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const efectivo0 = (await cierre(l)).efectivoEsperadoCentavos as number;
      const r = await validar(l.o, {
        codigoQr: await codigo(d, l),
        paraLlevar: true,
        items: items(l),
        cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 825 },
      });
      expect(r.statusCode, r.body).toBe(200);
      const c = r.json().cuenta;
      expect(c).toMatchObject({ origen: 'QR', estado: 'COBRADA', pagadoCentavos: 825, saldoCentavos: 0 });
      expect(c.cotizacion).toMatchObject({
        subtotalCentavos: 1125,
        recargoCentavos: 50,
        totalCentavos: 1175,
        cubiertoPorPlanCentavos: 350,
        saldoPorCobrarCentavos: 825,
      });
      expect(c.cotizacion.lineas.map((x: { tipo: string; fuente: string }) => `${x.tipo}/${x.fuente}`).sort()).toEqual(
        ['A_LA_CARTA/CAJA', 'ALMUERZO/PLAN', 'BEBIDA/CAJA', 'EXTRA/CAJA'].sort(),
      );
      expect(r.json().cotizacion).toEqual(c.cotizacion);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
      expect((await cierre(l)).efectivoEsperadoCentavos).toBe(efectivo0 + 825);

      // G-44: anular → cada línea con su inversa, pago −825, plan +1 y efectivo del día neto 0.
      const a = await k.as(l.o).post(`/v1/caja/cuentas/${c.id}/anular`, { motivo: 'Error de caja' }, randomUUID());
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ estado: 'ANULADA', saldoCentavos: 0, pagadoCentavos: 0 });
      expect(a.json().cotizacion).toMatchObject({ subtotalCentavos: 0, recargoCentavos: 0, totalCentavos: 0, cubiertoPorPlanCentavos: 0 });
      const lineas = a.json().cotizacion.lineas as { ref: string; cantidad: number }[];
      expect(lineas).toHaveLength(8);
      for (const ref of new Set(lineas.map((x) => x.ref)))
        expect(
          lineas
            .filter((x) => x.ref === ref)
            .map((x) => x.cantidad)
            .sort(),
        ).toEqual([-1, 1]);
      expect(
        a
          .json()
          .pagos.map((x: { montoCentavos: number }) => x.montoCentavos)
          .sort((x: number, y: number) => x - y),
      ).toEqual([-825, 825]);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(5);
      expect((await cierre(l)).efectivoEsperadoCentavos).toBe(efectivo0);
    });

    it('G-48 literal: el caso 21 repetido con la misma llave y otros items → 409; el mismo cuerpo → la misma cuenta y el mismo consumo', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const key = randomUUID();
      const qr = await codigo(d, l);
      const body = { codigoQr: qr, paraLlevar: true, items: items(l), cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 825 } };
      const r = await validar(l.o, body, key);
      expect(r.statusCode, r.body).toBe(200);
      const despues = await filas();

      const otros = await validar(l.o, { ...body, items: [{ plato: l.cola, cantidad: 2 }] }, key);
      expect(otros.statusCode).toBe(409);
      expect(otros.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      // Sin items ni cobro con la misma llave también es otro cuerpo.
      expect((await validar(l.o, { codigoQr: qr, paraLlevar: true }, key)).json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');

      const mismo = await validar(l.o, body, key);
      expect(mismo.statusCode, mismo.body).toBe(200);
      expect(mismo.json()).toMatchObject({ resultado: 'OK', consumo: { id: r.json().consumo.id }, cuenta: { id: r.json().cuenta.id } });
      expect(mismo.json().cuenta.pagos).toEqual(r.json().cuenta.pagos);
      expect(await filas()).toEqual(despues);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
    });

    it('G-22 / I-10: DUPLICADO (otra llave antes de 60 s) no cobra nada, ni el almuerzo ni los platos; pasados 60 s, valida de nuevo', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const primero = await validar(l.o, { codigoQr: await codigo(d, l) });
      expect(primero.json().resultado).toBe('OK');
      const antes = await filas();
      const dup = await validar(l.o, {
        codigoQr: await codigo(d, l),
        items: [{ plato: l.cola, cantidad: 1 }],
        cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B },
      });
      expect(dup.statusCode, dup.body).toBe(200);
      expect(dup.json()).toMatchObject({
        resultado: 'DUPLICADO',
        descontado: false,
        cuenta: null,
        avisos: [{ codigo: 'DUPLICADO', lineaRef: 'almuerzo' }],
        cotizacion: { totalCentavos: 0, saldoPorCobrarCentavos: 0, lineas: [{ ref: 'almuerzo', omitida: 'DUPLICADO' }] },
      });
      const despues = await filas();
      expect({ ...despues, consumos: antes.consumos }).toEqual(antes);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
      // La regla de los 60 s sigue: con el primer consumo de hace 2 minutos, la misma validación descuenta y abre la cuenta.
      await k.backdateLunch(primero.json().consumo.id, 2);
      const luego = await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.cola, cantidad: 1 }] });
      expect(luego.json()).toMatchObject({ resultado: 'OK', cuenta: { estado: 'ABIERTA', saldoCentavos: B } });
    });

    it('LIMITE_SAAS no cobra nada: sin cuenta y sin descontar', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      await probe!.sql(
        `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, fin_ciclo_actual)
         SELECT r.restaurante_id, 1, 'SUSPENDIDA', CURRENT_DATE + 30 FROM restaurante r WHERE r.public_id = $1`,
        [l.o.restaurante],
      );
      const antes = await filas();
      const r = await validar(l.o, { codigoQr: await codigo(d, l), paraLlevar: true, items: [{ plato: l.cola, cantidad: 1 }], cobro: {} });
      expect(r.json()).toMatchObject({ resultado: 'LIMITE_SAAS', cuenta: null, cotizacion: { saldoPorCobrarCentavos: 0 } });
      expect(await filas()).toEqual(antes);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(5);
    });

    it('SALDO_CAMBIO: el saldo esperado no es el real → 409 con el saldo; ni descuenta ni crea cuenta', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      const antes = await filas();
      const r = await validar(l.o, {
        codigoQr: await codigo(d, l),
        paraLlevar: true,
        items: items(l),
        cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 999 },
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: 825, saldoEsperadoCentavos: 999 });
      expect(await filas()).toEqual(antes);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(5);
    });

    it('ALMUERZO_SIN_PRECIO (I-12): sin plan y P = 0 → 409 solo con cuenta; sin items ni cobro, como siempre', async () => {
      const l = await local();
      await probe!.sql('UPDATE restaurante SET precio_suelto_centavos = 0 WHERE public_id = $1', [l.o.restaurante]);
      const d = await k.diner();
      const r = await validar(l.o, { codigoQr: await codigo(d, l), cobro: {} });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe('ALMUERZO_SIN_PRECIO');
      expect((await validar(l.o, { codigoQr: await codigo(d, l) })).json()).toMatchObject({ resultado: 'SIN_PLAN', cuenta: null });
    });

    it('validación de items: agotado → 409, inexistente → 422, repetido / de más / ofertaId (G-23) → 400', async () => {
      const l = await local();
      const d = await k.dinerWithPlan(l.o);
      await probe!.sql('UPDATE plato SET agotado_en = CURRENT_TIMESTAMP WHERE public_id = $1', [l.churrasco]);
      const agotado = await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.churrasco, cantidad: 1 }] });
      expect(agotado.statusCode).toBe(409);
      expect(agotado.json().code).toBe('PLATO_AGOTADO');
      const nada = await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: randomUUID(), cantidad: 1 }] });
      expect(nada.statusCode).toBe(422);
      expect(nada.json().code).toBe('PLATO_NO_DISPONIBLE');
      for (const body of [
        {
          items: [
            { plato: l.cola, cantidad: 1 },
            { plato: l.cola.toUpperCase(), cantidad: 1 },
          ],
        },
        { items: [{ plato: l.cola, cantidad: 11 }] },
        { items: [{ plato: l.cola, cantidad: 1, paraLlevar: true }] },
        { ofertaId: randomUUID() },
        { cobro: { metodoPago: 'EFECTIVO' } },
      ])
        expect((await validar(l.o, { codigoQr: await codigo(d, l), ...body })).statusCode, JSON.stringify(body)).toBe(400);
      expect(await saldoPlan(l.o, d.clienteId)).toBe(5);
    });
  });

  describe('GET /v1/caja/cuentas (lista del día)', () => {
    it('usa el día local del restaurante (no el UTC), filtra por estado y origen y pagina por cursor', async () => {
      // Una zona donde, a esta hora, la fecha local no es la de UTC.
      const h = (await probe!.sql<{ h: number }>(`SELECT EXTRACT(HOUR FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::int AS h`)).rows[0]!.h;
      const tz = h >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
      const l = await local({ tz });
      const fechas = (
        await probe!.sql<{ local: string; utc: string }>(
          `SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS local, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS utc`,
          [tz],
        )
      ).rows[0]!;
      expect(fechas.local).not.toBe(fechas.utc);

      const abiertas = [];
      for (let i = 0; i < 3; i++) {
        const d = await k.diner();
        abiertas.push((await validar(l.o, { codigoQr: await codigo(d, l), cobro: {} })).json().cuenta.id as string);
      }
      const d2 = await k.dinerWithPlan(l.o);
      const cobrada = (
        await validar(l.o, {
          codigoQr: await codigo(d2, l),
          items: [{ plato: l.cola, cantidad: 1 }],
          cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B },
        })
      ).json().cuenta;
      expect(cobrada.estado).toBe('COBRADA');
      // Una cuenta con la fecha UTC (otro día local) no entra.
      await probe!.sql('SET LOCAL session_replication_role = replica');
      await probe!.sql('UPDATE cuenta_cobro SET fecha_local = $2::date WHERE public_id = $1', [abiertas[2], fechas.utc]);
      await probe!.sql('SET LOCAL session_replication_role = origin');

      const todas = await k.as(l.o).get('/v1/caja/cuentas');
      expect(todas.statusCode, todas.body).toBe(200);
      expect(todas.json().fecha).toBe(fechas.local);
      expect(
        todas
          .json()
          .items.map((c: { id: string }) => c.id)
          .sort(),
      ).toEqual([abiertas[0], abiertas[1], cobrada.id].sort());
      expect(todas.json().nextCursor).toBeNull();
      expect(todas.json().items.find((c: { id: string }) => c.id === cobrada.id)).toEqual(await cuenta(l.o, cobrada.id));
      expectOnlyPublicIds(todas.json());

      const abiertasHoy = (await k.as(l.o).get('/v1/caja/cuentas?estado=ABIERTA')).json().items as { id: string; estado: string }[];
      expect(abiertasHoy.map((c) => c.id).sort()).toEqual([abiertas[0], abiertas[1]].sort());
      expect((await k.as(l.o).get('/v1/caja/cuentas?estado=COBRADA&origen=QR')).json().items).toHaveLength(1);
      expect((await k.as(l.o).get('/v1/caja/cuentas?origen=PEDIDO')).json().items).toEqual([]);

      // Páginas de 1: las tres, sin repetir, de la más reciente a la más antigua.
      const vistos: string[] = [];
      let cursor: string | null = null;
      do {
        const pg2 = (await k.as(l.o).get(`/v1/caja/cuentas?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json();
        vistos.push(...pg2.items.map((c: { id: string }) => c.id));
        cursor = pg2.nextCursor;
      } while (cursor);
      expect(vistos.sort()).toEqual([abiertas[0], abiertas[1], cobrada.id].sort());

      for (const q of ['estado=ABIERTAS', 'origen=CONSUMO', 'limit=51', 'cursor=x$y', 'fecha=2026-01-01'])
        expect((await k.as(l.o).get(`/v1/caja/cuentas?${q}`)).statusCode, q).toBe(400);
      const malo = await k.as(l.o).get(`/v1/caja/cuentas?cursor=${Buffer.from('{"t":1}').toString('base64url')}`);
      expect(malo.json().code).toBe('CURSOR_INVALIDO');
    });

    it('sin N+1: el número de consultas no crece con las cuentas de la página', async () => {
      const l = await local();
      const consultas = async () => {
        const spy = vi.spyOn(pg.Client.prototype, 'query');
        try {
          expect((await k.as(l.o).get('/v1/caja/cuentas')).statusCode).toBe(200);
          return spy.mock.calls.length;
        } finally {
          spy.mockRestore();
        }
      };
      const nueva = async () => {
        const d = await k.diner();
        await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.cola, cantidad: 1 }] });
      };
      await nueva();
      const con1 = await consultas();
      for (let i = 0; i < 5; i++) await nueva();
      expect((await k.as(l.o).get('/v1/caja/cuentas')).json().items).toHaveLength(6);
      expect(await consultas()).toBe(con1);
    });
  });

  describe('items y quitar (E.11)', () => {
    async function abierta(opts: { momento?: 'ANTES_DE_SERVIR' } = {}) {
      const l = await local({ momento: opts.momento ?? 'DESPUES_DE_SERVIR' });
      const d = await k.dinerWithPlan(l.o);
      const r = await validar(l.o, { codigoQr: await codigo(d, l), paraLlevar: true, cobro: {} });
      expect(r.json().cuenta, r.body).toMatchObject({ estado: 'ABIERTA', saldoCentavos: R });
      return { l, d, c: r.json().cuenta as { id: string } };
    }

    it('agregar: recotiza todo; un plato repetido revierte su línea y entra con más cantidad; reintento y llave reutilizada', async () => {
      const { l, c } = await abierta();
      const key = randomUUID();
      const r1 = await agregar(l.o, c.id, [{ plato: l.churrasco, cantidad: 1 }], key);
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r1.json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: R + C + R });
      // Reintento: lo mismo, sin otra línea.
      const again = await agregar(l.o, c.id, [{ plato: l.churrasco, cantidad: 1 }], key);
      expect(again.json()).toEqual(r1.json());
      // La misma llave con otra cantidad u otro plato: 409.
      for (const otro of [[{ plato: l.churrasco, cantidad: 2 }], [{ plato: l.cola, cantidad: 1 }]]) {
        const x = await agregar(l.o, c.id, otro, key);
        expect(x.statusCode).toBe(409);
        expect(x.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      }

      const r2 = await agregar(l.o, c.id, [
        { plato: l.churrasco, cantidad: 2 },
        { plato: l.cola, cantidad: 1 },
      ]);
      expect(r2.statusCode, r2.body).toBe(200);
      const cot = r2.json().cotizacion;
      expect(cot).toMatchObject({ subtotalCentavos: P + 3 * C + B, recargoCentavos: R + 3 * R, cubiertoPorPlanCentavos: P });
      expect(r2.json().saldoCentavos).toBe(3 * C + B + 4 * R);
      const ch = cot.lineas.filter((x: { ref: string }) => x.ref === `item:${l.churrasco}`).map((x: { cantidad: number }) => x.cantidad);
      expect(ch).toEqual([1, -1, 3]); // nunca se edita: inversa y línea nueva con el mismo ref
      expect(cot.lineas.filter((x: { fuente: string }) => x.fuente === 'PLAN')).toHaveLength(1);
    });

    it('quitar: revierte la línea entera; el almuerzo del plan no (LINEA_DE_PLAN); ref inexistente → 404; reintento', async () => {
      const { l, c } = await abierta();
      await agregar(l.o, c.id, [
        { plato: l.cola, cantidad: 2 },
        { plato: l.huevo, cantidad: 1 },
      ]);
      const key = randomUUID();
      const q1 = await quitar(l.o, c.id, `item:${l.cola}`, key);
      expect(q1.statusCode, q1.body).toBe(200);
      expect(q1.json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: R + E });
      expect((await quitar(l.o, c.id, `item:${l.cola}`, key)).json()).toEqual(q1.json());
      const otra = await quitar(l.o, c.id, `item:${l.huevo}`, key);
      expect(otra.statusCode).toBe(409);
      expect(otra.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
      // Ya quitada (otra llave): 404.
      const ya = await quitar(l.o, c.id, `item:${l.cola}`);
      expect(ya.statusCode).toBe(404);
      expect(ya.json().code).toBe('LINEA_NO_ENCONTRADA');
      const plan = await quitar(l.o, c.id, 'almuerzo#1');
      expect(plan.statusCode).toBe(409);
      expect(plan.json().code).toBe('LINEA_DE_PLAN');
      expect(
        (await k.as(l.o).post(`/v1/caja/cuentas/${c.id}/lineas/${encodeURIComponent("x'; --")}/quitar`, undefined, randomUUID()))
          .statusCode,
      ).toBe(400);
      // Quitar el último plato deja la cuenta con el recargo del almuerzo del plan.
      const q2 = await quitar(l.o, c.id, `item:${l.huevo}`);
      expect(q2.json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: R });
    });

    it('cuenta sin plan: quitar todas sus líneas la anula; con lo pagado por encima de lo que queda → 409 SALDO_NEGATIVO', async () => {
      const l = await local();
      const d = await k.diner();
      const c = (await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.cola, cantidad: 1 }] })).json().cuenta;
      expect(c.saldoCentavos).toBe(P + B);
      expect((await cobrar(l.o, c.id, { metodoPago: 'EFECTIVO', montoCentavos: 200, saldoEsperadoCentavos: P + B })).statusCode).toBe(200);
      const neg = await quitar(l.o, c.id, 'almuerzo');
      expect(neg.statusCode).toBe(409);
      expect(neg.json()).toMatchObject({ code: 'SALDO_NEGATIVO' });
      const ok = await quitar(l.o, c.id, `item:${l.cola}`);
      expect(ok.json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: P - 200 });

      const d2 = await k.diner();
      const c2 = (await validar(l.o, { codigoQr: await codigo(d2, l), items: [{ plato: l.cola, cantidad: 1 }] })).json().cuenta;
      await quitar(l.o, c2.id, `item:${l.cola}`);
      const fin = await quitar(l.o, c2.id, 'almuerzo');
      expect(fin.json()).toMatchObject({ estado: 'ANULADA', saldoCentavos: 0, cotizacion: { totalCentavos: 0 } });
    });

    it('cuenta cerrada: COBRADA o ANULADA → 409 CUENTA_CERRADA; ANTES_DE_SERVIR con pagos no admite platos', async () => {
      const { l, c } = await abierta();
      expect((await cobrar(l.o, c.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: R })).json().estado).toBe('COBRADA');
      for (const r of [await agregar(l.o, c.id, [{ plato: l.cola, cantidad: 1 }]), await quitar(l.o, c.id, 'almuerzo#1')]) {
        expect(r.statusCode).toBe(409);
        expect(r.json().code).toBe('CUENTA_CERRADA');
      }
      await k.as(l.o).post(`/v1/caja/cuentas/${c.id}/anular`, {}, randomUUID());
      expect((await agregar(l.o, c.id, [{ plato: l.cola, cantidad: 1 }])).json().code).toBe('CUENTA_CERRADA');

      const antes = await abierta({ momento: 'ANTES_DE_SERVIR' });
      await agregar(antes.l.o, antes.c.id, [{ plato: antes.l.cola, cantidad: 1 }]);
      expect(
        (await cobrar(antes.l.o, antes.c.id, { metodoPago: 'EFECTIVO', montoCentavos: 10, saldoEsperadoCentavos: R + B })).statusCode,
      ).toBe(200);
      const no = await agregar(antes.l.o, antes.c.id, [{ plato: antes.l.huevo, cantidad: 1 }]);
      expect(no.statusCode).toBe(409);
      expect(no.json().code).toBe('CUENTA_CERRADA');
    });

    it('platos: agotado → 409, inexistente → 422; también en la cuenta de un pedido (5a)', async () => {
      const { l, c } = await abierta();
      await probe!.sql('UPDATE plato SET agotado_en = CURRENT_TIMESTAMP WHERE public_id = $1', [l.cola]);
      expect((await agregar(l.o, c.id, [{ plato: l.cola, cantidad: 1 }])).json().code).toBe('PLATO_AGOTADO');
      expect((await agregar(l.o, c.id, [{ plato: randomUUID(), cantidad: 1 }])).json().code).toBe('PLATO_NO_DISPONIBLE');
      expect((await agregar(l.o, c.id, [])).statusCode).toBe(400);

      // La cuenta de un pedido para llevar (5a) también admite platos: el almuerzo del plan queda intacto.
      const d = await k.dinerWithPlan(l.o);
      const m = await k
        .as(d)
        .post(
          '/v1/mis/pedidos',
          { restaurante: l.o.restaurante, paraLlevar: true, almuerzo: { platos: [await platoDelAlmuerzo(l)] } },
          randomUUID(),
        );
      expect(m.statusCode, m.body).toBe(201);
      const pc = (await k.as(l.o).post(`/v1/caja/pedidos/${m.json().id}/canjear`, { cobro: {} }, randomUUID())).json().cuenta;
      expect(pc).toMatchObject({ origen: 'PEDIDO', estado: 'ABIERTA', saldoCentavos: R });
      const r = await agregar(l.o, pc.id, [{ plato: l.huevo, cantidad: 2 }]);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ saldoCentavos: R + 2 * E, cotizacion: { cubiertoPorPlanCentavos: P } });
      expect(await saldoPlan(l.o, d.clienteId)).toBe(4);
    });
  });

  describe('cierre de caja: cuentasAbiertas', () => {
    it('informa cantidad y saldo de las ABIERTAS del día; los pagos de cuentas entran una sola vez por método', async () => {
      const l = await local();
      const base = await cierre(l);
      expect(base.cuentasAbiertas).toEqual({ cantidad: 0, saldoCentavos: 0 });
      const nueva = async (body: object) => {
        const d = await k.diner();
        return (await validar(l.o, { codigoQr: await codigo(d, l), ...body })).json().cuenta as { id: string; saldoCentavos: number };
      };
      // 1) Abierta, sin pagos: 350.  2) Abierta con 100 en efectivo: 350 + 100 − 100.  3) Cobrada por transferencia confirmada.
      // 4) Cobrada con DEUNA pendiente (no entra al arqueo, sí a pagosPendientes).  5) Pedido canjeado y cobrado en efectivo.
      const a = await nueva({ cobro: {} });
      const b = await nueva({ items: [{ plato: l.cola, cantidad: 1 }] });
      await cobrar(l.o, b.id, { metodoPago: 'EFECTIVO', montoCentavos: 100, saldoEsperadoCentavos: P + B });
      await nueva({
        cobro: { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: P, referenciaExterna: `T-${randomUUID()}` },
      });
      await nueva({ cobro: { metodoPago: 'DEUNA', saldoEsperadoCentavos: P } });
      const d = await k.dinerWithPlan(l.o);
      const m = await k.as(d).post(
        '/v1/mis/pedidos',
        {
          restaurante: l.o.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [await platoDelAlmuerzo(l)] },
          extras: [{ plato: l.cola, cantidad: 1 }],
        },
        randomUUID(),
      );
      const canje = await k
        .as(l.o)
        .post(`/v1/caja/pedidos/${m.json().id}/canjear`, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B + R } }, randomUUID());
      expect(canje.json().cuenta, canje.body).toMatchObject({ estado: 'COBRADA' });

      const c = await cierre(l);
      expect(c.cuentasAbiertas).toEqual({ cantidad: 2, saldoCentavos: a.saldoCentavos + (P + B - 100) });
      const pos = (metodo: string) => (c.porMetodo.find((x: { metodo: string }) => x.metodo === metodo)?.posCentavos ?? 0) as number;
      const pos0 = (metodo: string) => (base.porMetodo.find((x: { metodo: string }) => x.metodo === metodo)?.posCentavos ?? 0) as number;
      expect(pos('EFECTIVO') - pos0('EFECTIVO')).toBe(100 + B + R);
      expect(pos('TRANSFERENCIA') - pos0('TRANSFERENCIA')).toBe(P);
      expect(pos('DEUNA') - pos0('DEUNA')).toBe(0);
      expect(c.pagosPendientes - base.pagosPendientes).toBe(1);
      // Los totales de siempre no cambian de forma: lo nuevo es solo cuentasAbiertas.
      expect(Object.keys(c).sort()).toEqual([...Object.keys(base)].sort());
      expect(c.totalCentavos - base.totalCentavos).toBe(100 + B + R + P + 1500 /* plan vendido en dinerWithPlan */);
      // Lo mismo suman los pagos confirmados de cuentas del día en la base: nada contado dos veces.
      const enCuentas = (
        await probe!.sql<{ s: string }>(
          `SELECT COALESCE(sum(t.monto_centavos), 0) AS s FROM transaccion_pago t JOIN restaurante r ON r.restaurante_id = t.restaurante_id
            WHERE r.public_id = $1 AND t.cuenta_cobro_id IS NOT NULL AND t.estado = 'CONFIRMADO'`,
          [l.o.restaurante],
        )
      ).rows[0]!.s;
      expect(Number(enCuentas)).toBe(100 + B + R + P);
    });
  });

  describe('roles, tenant, RLS y referencia por restaurante', () => {
    it('cajero lista, agrega y quita; otro local no ve la cuenta (lista vacía, 404); comensal 403; sin sesión 401', async () => {
      const l = await local();
      const cajero = await k.h.cashier(l.o.restaurante);
      const d = await k.dinerWithPlan(l.o);
      const c = (await validar(cajero, { codigoQr: await codigo(d, l), paraLlevar: true, cobro: {} })).json().cuenta;
      expect((await k.as(cajero).get('/v1/caja/cuentas')).json().items.map((x: { id: string }) => x.id)).toEqual([c.id]);
      expect((await agregar(cajero, c.id, [{ plato: l.cola, cantidad: 1 }])).statusCode).toBe(200);
      expect((await quitar(cajero, c.id, `item:${l.cola}`)).statusCode).toBe(200);

      const otro = await local();
      expect((await k.as(otro.o).get('/v1/caja/cuentas')).json().items).toEqual([]);
      for (const r of [await agregar(otro.o, c.id, [{ plato: l.cola, cantidad: 1 }]), await quitar(otro.o, c.id, 'almuerzo#1')]) {
        expect(r.statusCode).toBe(404);
        expect(r.json().code).toBe('CUENTA_NO_ENCONTRADA');
      }
      expect((await k.as({ ...d, restaurante: l.o.restaurante }).get('/v1/caja/cuentas')).statusCode).toBe(403);
      expect((await k.as({}).get('/v1/caja/cuentas')).statusCode).toBe(401);
      expect((await k.as(l.o).post(`/v1/caja/cuentas/${c.id}/items`, { items: [{ plato: l.cola, cantidad: 1 }] })).statusCode).toBe(400); // sin llave
    });

    it('RLS: la cuenta del intento (sin plan) la ve su local y su comensal como bck_api; otro local no; bck_servicio sí', async () => {
      const l = await local();
      const d = await k.diner();
      const c = (await validar(l.o, { codigoQr: await codigo(d, l), items: [{ plato: l.cola, cantidad: 1 }] })).json().cuenta;
      const rid = (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [l.o.restaurante]))
        .rows[0]!.id;
      const otro = await local();
      const otroId = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [otro.o.restaurante])
      ).rows[0]!.id;
      const uid = await k.internalUser(d.usuarioId);
      const ajeno = await k.internalUser((await k.diner()).usuarioId);
      const sqls = [
        'SELECT public_id FROM cuenta_cobro',
        'SELECT linea_id FROM cuenta_cobro_linea',
        'SELECT cuenta_id FROM v_cuenta_saldo',
        'SELECT intento_id FROM intento_escaneo WHERE intento_id IN (SELECT intento_id FROM cuenta_cobro)',
      ];
      for (const sql of sqls) {
        expect(await k.rls({ tenantId: String(otroId) }, sql), sql).toEqual([]);
        expect(await k.rls({ userId: ajeno }, sql), sql).toEqual([]);
        expect((await k.rls({ tenantId: String(rid) }, sql)).length, sql).toBeGreaterThan(0);
      }
      // El comensal lee su cuenta y sus líneas (no los intentos de escaneo, que son del personal).
      expect((await k.rls({ userId: uid }, sqls[0]!)).map((x) => x.public_id)).toEqual([c.id]);
      expect((await k.rls({ userId: uid }, sqls[1]!)).length).toBe(2);
      // La API de otro local no puede escribir líneas en esta cuenta (no la ve).
      await expect(
        k.rls(
          { tenantId: String(otroId) },
          `INSERT INTO cuenta_cobro_linea (cuenta_id, restaurante_id, ref, persona_ref, tipo, fuente, pagador, nombre, cantidad, precio_unitario_centavos,
                                           recargo_unitario_centavos, subtotal_centavos, recargo_centavos, cubierto_centavos, clave_idempotencia)
           SELECT cuenta_id, restaurante_id, 'x', '0', 'EXTRA', 'CAJA', 'PROPIO', 'x', 1, 1, 0, 1, 0, 0, gen_random_uuid() FROM cuenta_cobro WHERE public_id = $1`,
          [c.id],
        ),
      ).resolves.toEqual([]);
      expect(await k.h.db.service(async (s) => (await s.query('SELECT 1 FROM cuenta_cobro WHERE public_id = $1', [c.id])).rowCount)).toBe(
        1,
      );
    });

    it('referencia externa por restaurante: la misma en dos locales se acepta; repetida en el mismo local → 409', async () => {
      const ref = `DEP-${randomUUID()}`;
      const pagar = async (l: Local) => {
        const d = await k.diner();
        return validar(l.o, {
          codigoQr: await codigo(d, l),
          cobro: { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: P, referenciaExterna: ref },
        });
      };
      const a = await local();
      const b = await local();
      expect((await pagar(a)).json().cuenta, 'local A').toMatchObject({ estado: 'COBRADA' });
      const enB = await pagar(b);
      expect(enB.statusCode, enB.body).toBe(200);
      expect(enB.json().cuenta).toMatchObject({ estado: 'COBRADA' });
      const repetida = await pagar(a);
      expect(repetida.statusCode).toBe(409);
      expect(repetida.json().code).toBe('REFERENCIA_PAGO_REPETIDA');
      // Por /cobrar, igual: el 409 del mismo local no crea pago ni deja la cuenta cobrada.
      const d = await k.diner();
      const abierta = (await validar(a.o, { codigoQr: await codigo(d, a), cobro: {} })).json().cuenta;
      const x = await cobrar(a.o, abierta.id, { metodoPago: 'TRANSFERENCIA', saldoEsperadoCentavos: P, referenciaExterna: ref });
      expect(x.json().code).toBe('REFERENCIA_PAGO_REPETIDA');
      expect((await cuenta(a.o, abierta.id)).estado).toBe('ABIERTA');
      const idx = (await probe!.sql<{ d: string }>(`SELECT indexdef AS d FROM pg_indexes WHERE indexname = 'uq_pago_referencia_externa'`))
        .rows[0]!.d;
      expect(idx).toContain('(restaurante_id, metodo_pago_id, referencia_externa)');
      expect(idx).toContain('WHERE ((referencia_externa IS NOT NULL) AND (revierte_a_pago_id IS NULL))');
    });
  });

  /** Un plato del almuerzo de hoy (public_id), para armar un pedido. */
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
