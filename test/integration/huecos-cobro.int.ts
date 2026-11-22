import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Diner, DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const B = 100; // Cola (BEBIDA, menú de hoy)

/**
 * PR 6c (docs/spec-cobros.md E.3, E.4, I-10, I-12): los tres huecos de cobro que dejó el 6b.
 * 1. Canjear un pedido sin `cobro` abre la cuenta ABIERTA si queda saldo (como el QR del 6b), sin SALDO_CAMBIO.
 * 2. El límite SaaS frena el descuento de un plan, no el cobro del almuerzo suelto de quien no tiene plan.
 * 3. Un local ACTIVO no puede dejar el precio del almuerzo en 0 (422 PRECIO_ALMUERZO_REQUERIDO).
 */
describe.skipIf(!probe)('PR 6c: huecos de cobro', () => {
  const k = new DinerKit(probe!, 120);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Quien = { token?: string; restaurante?: string };

  const restauranteId = async (o: Local) =>
    String(
      (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [o.restaurante])).rows[0]!.id,
    );
  /** Ficha del local vinculada a un comensal, sin plan. */
  async function fichaSinPlan(o: Local, d?: Diner) {
    const diner = d ?? (await k.diner());
    const c = (await k.as(o).post('/v1/clientes', { nombre: 'Ficha sin plan' })).json().id as string;
    const link = await k.as(o).post(`/v1/clientes/${c}/vincular`, { correo: diner.correo });
    expect(link.statusCode, link.body).toBe(200);
    return { ...diner, clienteId: c };
  }
  /**
   * Pedido del comensal. `plan`: 'con' (ficha con plan de 5), 'ficha' (ficha sin plan) o 'no' (no es cliente).
   * Por defecto con plan, para llevar, almuerzo (sopa + seco) y una Cola.
   */
  async function pedido(opts: { plan?: 'con' | 'ficha' | 'no'; paraLlevar?: boolean; cola?: boolean; o?: Local } = {}) {
    const o = opts.o ?? (await k.activeOwner());
    const m = await k.menu(o);
    const plan = opts.plan ?? 'con';
    const d: Diner = plan === 'con' ? await k.dinerWithPlan(o) : plan === 'ficha' ? await fichaSinPlan(o) : await k.diner();
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
    return { o, d, p: r.json() };
  }
  const canjear = (who: Quien, id: string, body?: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/pedidos/${id}/canjear`, body, key);
  const validar = (who: Quien, body: object, key = randomUUID()) => k.as(who).post('/v1/caja/validar', body, key);
  const cobrar = (who: Quien, cuenta: string, body: object, key = randomUUID()) =>
    k.as(who).post(`/v1/caja/cuentas/${cuenta}/cobrar`, body, key);
  const saldoPlan = async (o: Quien, c: string) => (await k.as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const filas = async () =>
    (
      await probe!.sql<{ cuentas: string; lineas: string; pagos: string; consumos: string }>(
        `SELECT (SELECT count(*) FROM cuenta_cobro) AS cuentas, (SELECT count(*) FROM cuenta_cobro_linea) AS lineas,
                (SELECT count(*) FROM transaccion_pago WHERE cuenta_cobro_id IS NOT NULL) AS pagos,
                (SELECT count(*) FROM consumo_almuerzo) AS consumos`,
      )
    ).rows[0]!;
  const cuentasDelPedido = async (pedidoPublicId: string) =>
    (
      await probe!.sql<{ id: string }>(
        `SELECT c.public_id AS id FROM cuenta_cobro c JOIN orden_cabecera o ON o.orden_id = c.orden_id WHERE o.public_id = $1`,
        [pedidoPublicId],
      )
    ).rows.map((x) => x.id);
  const intentos = async (clienteId: string) =>
    (
      await probe!.sql<{ resultado: string }>(
        'SELECT resultado::text AS resultado FROM intento_escaneo WHERE cliente_id = $1 ORDER BY intento_id',
        [clienteId],
      )
    ).rows.map((x) => x.resultado);
  /** Plan Bocadoo del local suspendido: la caja responde LIMITE_SAAS a quien tiene plan. */
  const suspender = (o: Local) =>
    probe!.sql(
      `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, fin_ciclo_actual)
       SELECT r.restaurante_id, 1, 'SUSPENDIDA', CURRENT_DATE + 30 FROM restaurante r WHERE r.public_id = $1`,
      [o.restaurante],
    );
  /** Plan Bocadoo con tope de 1 escaneo, ya usado. */
  async function enElTope(o: Local) {
    const plan = await probe!.sql<{ id: string }>(
      `INSERT INTO catalogo_plan_saas (codigo, nombre, limite_escaneos_mes, permite_mesa_grupal, permite_reportes_avanzados, tasa_comision_oferta_flash)
       VALUES ('TOPE_6C', 'Tope 6c', 1, true, true, 7) ON CONFLICT (codigo) DO UPDATE SET limite_escaneos_mes = 1 RETURNING plan_saas_id AS id`,
    );
    await probe!.sql(
      `INSERT INTO plan_saas_precio (plan_saas_id, pais_codigo, moneda_codigo, precio_mensual_centavos, vigente_desde)
       VALUES ($1, 'EC', 'USD', 2900, DATE '2000-01-01') ON CONFLICT DO NOTHING`,
      [plan.rows[0]!.id],
    );
    await probe!.sql(
      `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, escaneos_usados_ciclo_actual, inicio_ciclo_actual, fin_ciclo_actual)
       SELECT r.restaurante_id, $2, 'ACTIVA_PRO', 1, CURRENT_DATE - 10, CURRENT_DATE + 20 FROM restaurante r WHERE r.public_id = $1`,
      [o.restaurante, plan.rows[0]!.id],
    );
  }

  describe('1. POST /v1/caja/pedidos/{id}/canjear sin cobro', () => {
    it('con saldo > 0 (llevar con plan + Cola): abre la cuenta ABIERTA del pedido sin pago; se cobra después por /cobrar', async () => {
      const { o, d, p } = await pedido();
      expect(p.totalCentavos).toBe(B + R);
      const antes = await filas();
      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        yaCanjeado: false,
        almuerzo: { resultado: 'OK', descontado: true },
        porCobrarCentavos: B + R,
        avisos: [],
        cotizacion: {
          estimada: false,
          subtotalCentavos: P + B,
          recargoCentavos: R,
          cubiertoPorPlanCentavos: P,
          saldoPorCobrarCentavos: B + R,
        },
        cuenta: {
          origen: 'PEDIDO',
          estado: 'ABIERTA',
          momentoCobro: 'ANTES_DE_SERVIR',
          debeCobrarseAntesDeServir: true,
          saldoCentavos: B + R,
          pagadoCentavos: 0,
          pagos: [],
        },
      });
      expect(r.json().cotizacion).toEqual(r.json().cuenta.cotizacion);
      expectOnlyPublicIds(r.json());
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      const despues = await filas();
      expect(Number(despues.cuentas) - Number(antes.cuentas)).toBe(1);
      expect(Number(despues.consumos) - Number(antes.consumos)).toBe(1);
      expect(despues.pagos).toBe(antes.pagos);
      expect(await cuentasDelPedido(p.id)).toEqual([r.json().cuenta.id]);

      const c = await cobrar(o, r.json().cuenta.id, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: B + R });
      expect(c.statusCode, c.body).toBe(200);
      expect(c.json()).toMatchObject({ estado: 'COBRADA', pagadoCentavos: B + R, saldoCentavos: 0 });
    });

    it('cuerpo {} (sin la clave cobro) es lo mismo que sin cuerpo; con cobro {} sigue como en 5a', async () => {
      const a = await pedido();
      const r = await canjear(a.o, a.p.id, {});
      expect(r.json()).toMatchObject({ cuenta: { estado: 'ABIERTA', saldoCentavos: B + R } });
      const b = await pedido({ o: a.o });
      const c = await canjear(b.o, b.p.id, { cobro: {} });
      expect(c.json()).toMatchObject({ cuenta: { estado: 'ABIERTA', saldoCentavos: B + R } });
    });

    it('con saldo 0 (plan, para comer aquí, sin extras): sin cuenta, como siempre', async () => {
      const { o, d, p } = await pedido({ paraLlevar: false, cola: false });
      const antes = await filas();
      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        almuerzo: { resultado: 'OK', descontado: true },
        porCobrarCentavos: 0,
        cuenta: null,
        cotizacion: { saldoPorCobrarCentavos: 0, cubiertoPorPlanCentavos: P },
      });
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      const despues = await filas();
      expect({ ...despues, consumos: antes.consumos }).toEqual(antes);
      expect(await cuentasDelPedido(p.id)).toEqual([]);
    });

    it('quien no es cliente del local: cuenta ABIERTA con el almuerzo a P (+ R + Cola), a nombre del comensal', async () => {
      const { o, p } = await pedido({ plan: 'no' });
      const antes = await filas();
      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        almuerzo: { resultado: 'SIN_PLAN', descontado: false },
        porCobrarCentavos: P + B + R,
        cuenta: { origen: 'PEDIDO', estado: 'ABIERTA', saldoCentavos: P + B + R, pagos: [] },
      });
      expect(r.json().cuenta.pagador.nombre).toBeTruthy();
      const despues = await filas();
      expect(Number(despues.cuentas) - Number(antes.cuentas)).toBe(1);
      expect(despues.consumos).toBe(antes.consumos);
    });

    it('sin SALDO_CAMBIO: el plan se agotó entre pedir y canjear → sin cobro abre la cuenta con el saldo nuevo; con cobro {} → 409', async () => {
      const { o, d, p } = await pedido();
      await probe!.sql(`UPDATE suscripcion_plan SET almuerzos_restantes = 0, estado = 'AGOTADA' WHERE cliente_id = $1`, [d.clienteId]);
      const antes = await filas();
      const x = await canjear(o, p.id, { cobro: {} });
      expect(x.statusCode, x.body).toBe(409);
      expect(x.json()).toMatchObject({ code: 'SALDO_CAMBIO', saldoCentavos: P + B + R });
      expect(await filas()).toEqual(antes);

      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        almuerzo: { resultado: 'SIN_SALDO', descontado: false },
        porCobrarCentavos: P + B + R,
        cuenta: { estado: 'ABIERTA', saldoCentavos: P + B + R },
      });
    });

    it('idempotencia: la misma llave repetida → la misma cuenta y nada nuevo; otra llave → yaCanjeado con esa cuenta; otro cuerpo → 409', async () => {
      const { o, d, p } = await pedido();
      const key = randomUUID();
      const r1 = await canjear(o, p.id, undefined, key);
      const tras = await filas();
      const r2 = await canjear(o, p.id, undefined, key);
      expect(r2.statusCode, r2.body).toBe(200);
      expect(r2.json()).toMatchObject({
        yaCanjeado: true,
        almuerzo: { consumoId: r1.json().almuerzo.consumoId },
        cuenta: { id: r1.json().cuenta.id, saldoCentavos: B + R },
        porCobrarCentavos: B + R,
      });
      expect(r2.json().cotizacion).toEqual(r1.json().cotizacion);
      const r3 = await canjear(o, p.id);
      expect(r3.json()).toMatchObject({ yaCanjeado: true, cuenta: { id: r1.json().cuenta.id } });
      expect(await filas()).toEqual(tras);
      expect(await saldoPlan(o, d.clienteId!)).toBe(4);
      expect(await cuentasDelPedido(p.id)).toEqual([r1.json().cuenta.id]);
      const x = await canjear(o, p.id, { cobro: {} }, key);
      expect(x.statusCode, x.body).toBe(409);
      expect(x.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');

      // Sin plan (sin consumo): igual, la llave encuentra la cuenta.
      const s = await pedido({ plan: 'no', o });
      const k2 = randomUUID();
      const a = await canjear(o, s.p.id, undefined, k2);
      const b = await canjear(o, s.p.id, undefined, k2);
      expect(b.json()).toMatchObject({ yaCanjeado: true, cuenta: { id: a.json().cuenta.id, saldoCentavos: P + B + R } });
      expect(await cuentasDelPedido(s.p.id)).toEqual([a.json().cuenta.id]);
      // La llave de un canje no sirve para otro pedido.
      const t = await pedido({ plan: 'no', o });
      const y = await canjear(o, t.p.id, undefined, k2);
      expect(y.statusCode, y.body).toBe(409);
      expect(y.json().code).toBe('IDEMPOTENCY_KEY_REUTILIZADA');
    });

    it('LIMITE_SAAS con plan: el almuerzo queda omitido (I-10) y la cuenta solo lleva la Cola; sin extras, sin cuenta', async () => {
      const a = await pedido();
      await suspender(a.o);
      const r = await canjear(a.o, a.p.id);
      expect(r.json()).toMatchObject({
        almuerzo: { resultado: 'LIMITE_SAAS', descontado: false },
        avisos: [{ codigo: 'LIMITE_SAAS' }],
        cuenta: { estado: 'ABIERTA', saldoCentavos: B },
      });
      expect(await saldoPlan(a.o, a.d.clienteId!)).toBe(5);
      const b = await pedido({ o: a.o, cola: false });
      expect((await canjear(b.o, b.p.id)).json()).toMatchObject({
        almuerzo: { resultado: 'LIMITE_SAAS' },
        cuenta: null,
        porCobrarCentavos: 0,
      });
    });

    it('roles y RLS: el cajero canjea y abre la cuenta; otro local no la ve; el comensal ve la suya; comensal 403 y sin sesión 401', async () => {
      const { o, d, p } = await pedido({ plan: 'ficha' });
      const cajero = await k.h.cashier(o.restaurante);
      expect((await canjear({ token: d.token, restaurante: o.restaurante }, p.id)).statusCode).toBe(403);
      expect((await canjear({}, p.id)).statusCode).toBe(401);
      const otro = await k.activeOwner();
      expect((await canjear(otro, p.id)).statusCode).toBe(404);
      const r = await canjear(cajero, p.id);
      expect(r.statusCode, r.body).toBe(200);
      const c = r.json().cuenta;
      expect(c).toMatchObject({ estado: 'ABIERTA', saldoCentavos: P + B + R });
      expect(await cuentasDelPedido(p.id)).toEqual([c.id]); // los rechazos no abrieron nada
      expect((await k.as(cajero).get(`/v1/caja/cuentas/${c.id}`)).json()).toMatchObject({ id: c.id, origen: 'PEDIDO' });
      expect((await k.as(otro).get(`/v1/caja/cuentas/${c.id}`)).statusCode).toBe(404);

      const sql = 'SELECT public_id FROM cuenta_cobro WHERE public_id = $1';
      expect(await k.rls({ tenantId: await restauranteId(otro) }, sql, [c.id])).toEqual([]);
      expect(await k.rls({ userId: await k.internalUser((await k.diner()).usuarioId) }, sql, [c.id])).toEqual([]);
      expect(await k.rls({ tenantId: await restauranteId(o) }, sql, [c.id])).toHaveLength(1);
      expect(await k.rls({ userId: await k.internalUser(d.usuarioId) }, sql, [c.id])).toHaveLength(1);
      expect(await k.h.db.service(async (s) => (await s.query(sql, [c.id])).rowCount)).toBe(1);
    });
  });

  describe('2. LIMITE_SAAS solo frena el descuento de un plan', () => {
    it('local suspendido: la ficha sin plan paga su almuerzo (SIN_PLAN, cuenta P); con plan, LIMITE_SAAS sin cobro; plan de otro día, a caja', async () => {
      const o = await k.activeOwner();
      await k.h.publishMenu(o);
      await suspender(o);
      const ficha = await fichaSinPlan(o);
      const sin = await validar(o, { clienteId: ficha.clienteId });
      expect(sin.statusCode, sin.body).toBe(200);
      expect(sin.json()).toMatchObject({
        resultado: 'SIN_PLAN',
        descontado: false,
        avisos: [],
        cotizacion: { saldoPorCobrarCentavos: P, lineas: [{ ref: 'almuerzo', fuente: 'CAJA', omitida: null }] },
        cuenta: { estado: 'ABIERTA', saldoCentavos: P },
      });
      expect(await intentos(ficha.clienteId)).toEqual(['SIN_PLAN']);

      const con = await k.dinerWithPlan(o);
      const r = await validar(o, { clienteId: con.clienteId });
      expect(r.json()).toMatchObject({
        resultado: 'LIMITE_SAAS',
        descontado: false,
        cuenta: null,
        cotizacion: { saldoPorCobrarCentavos: 0 },
      });
      expect(await saldoPlan(o, con.clienteId)).toBe(5);
      expect(await intentos(con.clienteId)).toEqual(['LIMITE_SAAS']);

      const dow = (await probe!.sql<{ d: number }>(`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Guayaquil'))::int AS d`))
        .rows[0]!.d;
      const otroDia = await k.dinerWithPlan(o, { diasValidos: [dow === 7 ? 1 : dow + 1] });
      expect((await validar(o, { clienteId: otroDia.clienteId })).json()).toMatchObject({
        resultado: 'DIA_NO_VALIDO',
        cuenta: { estado: 'ABIERTA', saldoCentavos: P },
      });
      expect(await saldoPlan(o, otroDia.clienteId)).toBe(5);
    });

    it('local en su tope: igual; el contador no sube y rechazadosPorLimite solo cuenta al que tenía plan', async () => {
      const o = await k.activeOwner();
      await k.h.publishMenu(o);
      await enElTope(o);
      const ficha = await fichaSinPlan(o);
      expect((await validar(o, { clienteId: ficha.clienteId })).json()).toMatchObject({
        resultado: 'SIN_PLAN',
        cuenta: { saldoCentavos: P },
      });
      const con = await k.dinerWithPlan(o);
      expect((await validar(o, { clienteId: con.clienteId })).json()).toMatchObject({ resultado: 'LIMITE_SAAS', cuenta: null });
      expect((await k.as(o).get('/v1/suscripcion/uso')).json()).toMatchObject({ escaneosUsados: 1, rechazadosPorLimite: 1 });
    });

    it('canje de pedido de una ficha sin plan en un local suspendido: SIN_PLAN y su cuenta con el almuerzo a P', async () => {
      const o = await k.activeOwner();
      await suspender(o);
      const { p } = await pedido({ plan: 'ficha', o });
      const r = await canjear(o, p.id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({
        almuerzo: { resultado: 'SIN_PLAN', descontado: false },
        avisos: [],
        cuenta: { estado: 'ABIERTA', saldoCentavos: P + B + R },
      });
    });

    it('fn_descontar_almuerzo como bck_api (tenant del local) y bck_servicio: misma salida; GRANT sin cambios', async () => {
      const o = await k.activeOwner();
      await suspender(o);
      const rid = await restauranteId(o);
      const personal = (
        await probe!.sql<{ id: string }>('SELECT personal_id AS id FROM personal_restaurante WHERE restaurante_id = $1 LIMIT 1', [rid])
      ).rows[0]!.id;
      const ficha = await fichaSinPlan(o);
      const con = await k.dinerWithPlan(o);
      const sql = `SELECT resultado::text AS resultado, consumo_id, suscripcion_id FROM fn_descontar_almuerzo(app_tenant_id(), $1, $2, $3)`;
      expect(await k.rls({ tenantId: rid }, sql, [ficha.clienteId, personal, randomUUID()])).toEqual([
        { resultado: 'SIN_PLAN', consumo_id: null, suscripcion_id: null },
      ]);
      // LIMITE_SAAS no devuelve el plan (como antes), aunque ahora se lea primero.
      expect(await k.rls({ tenantId: rid }, sql, [con.clienteId, personal, randomUUID()])).toEqual([
        { resultado: 'LIMITE_SAAS', consumo_id: null, suscripcion_id: null },
      ]);
      // Otro tenant no puede descontar en este local; bck_servicio sin tenant tampoco (la función valida el tenant).
      const otro = await k.activeOwner();
      await expect(
        k.rls({ tenantId: await restauranteId(otro) }, sql.replace('app_tenant_id()', rid), [ficha.clienteId, personal, randomUUID()]),
      ).rejects.toThrow(/fuera del tenant/);
      await expect(
        k.h.db.service((s) => s.query(sql.replace('app_tenant_id()', rid), [ficha.clienteId, personal, randomUUID()])),
      ).rejects.toThrow(/fuera del tenant/);
      const acl = (
        await probe!.sql<{ acl: string; secdef: boolean; cfg: string[] }>(
          `SELECT proacl::text AS acl, prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE proname = 'fn_descontar_almuerzo'`,
        )
      ).rows;
      expect(acl).toHaveLength(1);
      expect(acl[0]!.acl).toContain('bocadoo_app=X/');
      expect(acl[0]!.acl).toContain('bocadoo_servicio=X/');
      expect(acl[0]!.acl).not.toMatch(/[{,]=X\//); // sin EXECUTE a PUBLIC
      expect(acl[0]).toMatchObject({ secdef: true, cfg: ['search_path=public, pg_temp'] });
    });
  });

  describe('3. PATCH /v1/restaurante: precio del almuerzo > 0 en un local ACTIVO', () => {
    const precio = async (o: Quien) => (await k.as(o).get('/v1/restaurante')).json().precioAlmuerzoCentavos as number;

    it('ACTIVO: 0 → 422 PRECIO_ALMUERZO_REQUERIDO sin tocar nada; null o vacío → 400; un precio > 0 sí', async () => {
      const o = await k.activeOwner();
      const nombre = (await k.as(o).get('/v1/restaurante')).json().nombre as string;
      const r = await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 0, nombre: 'Otro nombre' });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().code).toBe('PRECIO_ALMUERZO_REQUERIDO');
      expect(await precio(o)).toBe(P);
      expect((await k.as(o).get('/v1/restaurante')).json().nombre).toBe(nombre);
      for (const body of [
        { precioAlmuerzoCentavos: 0 },
        { precioSueltoCentavos: null },
        { precioAlmuerzoCentavos: null },
        { precioSueltoCentavos: '' },
        { precioAlmuerzoCentavos: '' },
        { precioSueltoCentavos: -1 },
      ]) {
        const x = await k.as(o).patch('/v1/restaurante', body);
        expect(x.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(await precio(o)).toBe(P);
      const ok = await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 400 });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await precio(o)).toBe(400);
    });

    it('BORRADOR y PAUSADO aceptan 0, pero no se activan así; el cajero no edita (403) y otro dueño no ve el local', async () => {
      const b = await k.owner();
      expect((await k.as(b).patch('/v1/restaurante', { precioSueltoCentavos: 0 })).statusCode).toBe(200);
      await k.as(b).put('/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '08:00', cierra: '16:00' }] });
      expect((await k.as(b).post('/v1/restaurante/activar')).statusCode).toBe(409);

      const o = await k.activeOwner();
      expect((await k.as(o).post('/v1/restaurante/pausar')).statusCode).toBe(200);
      expect((await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 0 })).statusCode).toBe(200);
      expect((await k.as(o).post('/v1/restaurante/activar')).statusCode).toBe(409);
      expect((await k.as(o).patch('/v1/restaurante', { precioSueltoCentavos: P })).statusCode).toBe(200);
      expect((await k.as(o).post('/v1/restaurante/activar')).statusCode).toBe(200);

      const cajero = await k.h.cashier(o.restaurante);
      expect((await k.as(cajero).patch('/v1/restaurante', { precioSueltoCentavos: 0 })).statusCode).toBe(403);
      const ajeno = await k.owner();
      expect(
        (await k.as({ token: ajeno.token, restaurante: o.restaurante }).patch('/v1/restaurante', { precioSueltoCentavos: 0 })).statusCode,
      ).toBe(403);
      expect(await precio(o)).toBe(P);
    });

    it('Swagger documenta el 422 del PATCH', async () => {
      const doc = (await k.h.app.inject({ method: 'GET', url: '/docs-json', remoteAddress: k.h.ip() })).json();
      expect(doc.paths['/v1/restaurante'].patch.responses['422'].description).toContain('PRECIO_ALMUERZO_REQUERIDO');
    });
  });
});
