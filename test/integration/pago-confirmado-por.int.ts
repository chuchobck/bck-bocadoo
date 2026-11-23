import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './harness';
import { DinerKit } from './diner-kit';
import { offer } from './offers-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350; // precio suelto del local activo del kit

/**
 * Auditoría de seguridad, PR «cajero confirma pagos» (migración 20261122210000_pago_confirmado_por):
 * el cajero conserva `pagoConfirmado`, pero con `referenciaExterna` obligatoria en transferencia/Deuna; todo pago que
 * queda CONFIRMADO guarda quién (usuario, rol, momento) y el cierre lo separa por cajero, dueño y sin registro.
 */
describe.skipIf(!probe)('Cajero confirma pagos: referencia obligatoria y quién confirmó', () => {
  const k = new DinerKit(probe!, 99);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Quien = { token?: string; restaurante?: string };
  const cajero = (o: Actor) => k.h.cashier(o.restaurante);
  const cliente = async (o: Actor) => (await k.as(o).post('/v1/clientes', { nombre: 'Cliente pagos' })).json().id as string;
  const venderPlan = (who: Quien, c: string, planId: string, body: object, key = randomUUID()) =>
    k.as(who).post(`/v1/clientes/${c}/planes`, { planId, ...body }, key);
  const venderPos = (who: Quien, body: object, key = randomUUID()) =>
    k.as(who).post('/v1/caja/ventas', { items: [{ tipo: 'ALMUERZO', cantidad: 1 }], ...body }, key);
  const cierre = async (who: Quien) => {
    const r = await k.as(who).get('/v1/caja/cierre/hoy');
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const metodo = (c: { porMetodo: { metodo: string }[] }, m: string) => c.porMetodo.find((x) => x.metodo === m);
  /** Quién confirmó un pago, por su public_id (lectura directa, rol privilegiado). */
  const quien = async (pagoPublicId: string) =>
    (
      await probe!.sql<{ estado: string; usuario: string | null; rol: string | null; en: Date | null; ref: string | null }>(
        `SELECT estado, confirmado_por_usuario_id::text AS usuario, confirmado_por_rol::text AS rol, confirmado_en AS en,
                referencia_externa AS ref
           FROM transaccion_pago WHERE public_id = $1`,
        [pagoPublicId],
      )
    ).rows[0]!;
  const pagosDelLocal = async (o: Actor) =>
    Number(
      (
        await probe!.sql<{ n: string }>(
          'SELECT count(*) AS n FROM transaccion_pago p JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1',
          [o.restaurante],
        )
      ).rows[0]!.n,
    );
  /** Simula un pago de antes de la migración: sin quién confirmó (los triggers se apagan solo aquí; el ROLLBACK lo deshace). */
  const comoAntiguo = async (pagoPublicId: string) => {
    await probe!.sql('SET LOCAL session_replication_role = replica');
    await probe!.sql(
      'UPDATE transaccion_pago SET confirmado_por_usuario_id = NULL, confirmado_por_rol = NULL, confirmado_en = NULL WHERE public_id = $1',
      [pagoPublicId],
    );
    await probe!.sql('SET LOCAL session_replication_role = origin');
  };

  describe('venta de plan', () => {
    it('cajero confirma una TRANSFERENCIA con referencia → CONFIRMADO con su usuario y rol', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const r = await venderPlan(c, await cliente(o), await k.plan(o), {
        metodoPago: 'TRANSFERENCIA',
        pagoConfirmado: true,
        referenciaExterna: 'TR-0001',
      });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().pago).toMatchObject({ estado: 'CONFIRMADO' });
      expect(await quien(r.json().pago.id)).toEqual({
        estado: 'CONFIRMADO',
        usuario: await k.internalUser(c.usuarioId),
        rol: 'CAJERO',
        en: expect.any(Date),
        ref: 'TR-0001',
      });
    });

    it('cajero confirma TRANSFERENCIA o DEUNA sin referencia → 422 REFERENCIA_PAGO_REQUERIDA y no se crea nada', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const cli = await cliente(o);
      const plan = await k.plan(o);
      for (const metodoPago of ['TRANSFERENCIA', 'DEUNA']) {
        const r = await venderPlan(c, cli, plan, { metodoPago, pagoConfirmado: true });
        expect(r.statusCode, r.body).toBe(422);
        expect(r.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REQUERIDA' });
      }
      expect(await pagosDelLocal(o)).toBe(0);
      expect((await k.as(o).get(`/v1/clientes/${cli}`)).json().planes).toEqual([]);
    });

    it('cajero sin pagoConfirmado: queda PENDIENTE como antes, sin referencia y sin quién confirmó', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const r = await venderPlan(c, await cliente(o), await k.plan(o), { metodoPago: 'DEUNA' });
      expect(r.statusCode, r.body).toBe(201);
      expect(await quien(r.json().pago.id)).toMatchObject({ estado: 'PENDIENTE', usuario: null, rol: null, en: null });
    });

    it('referencia repetida en el local → 409 REFERENCIA_PAGO_REPETIDA (antes CONFLICT)', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const plan = await k.plan(o);
      const body = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, referenciaExterna: 'TR-REPETIDA' };
      expect((await venderPlan(c, await cliente(o), plan, body)).statusCode).toBe(201);
      const r = await venderPlan(c, await cliente(o), plan, body);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REPETIDA' });
    });

    it('el dueño confirma sin referencia, al vender y después con /pagos/{id}/confirmar; el cajero no puede confirmar después', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const plan = await k.plan(o);
      const directo = await venderPlan(o, await cliente(o), plan, { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true });
      expect(directo.statusCode, directo.body).toBe(201);
      const dueno = await k.internalUser(o.usuarioId);
      expect(await quien(directo.json().pago.id)).toMatchObject({ estado: 'CONFIRMADO', usuario: dueno, rol: 'DUENO', ref: null });

      const pendiente = (await venderPlan(c, await cliente(o), plan, { metodoPago: 'DEUNA' })).json();
      expect((await k.as(c).post(`/v1/pagos/${pendiente.pago.id}/confirmar`)).statusCode).toBe(403);
      const conf = await k.as(o).post(`/v1/pagos/${pendiente.pago.id}/confirmar`);
      expect(conf.statusCode, conf.body).toBe(200);
      expect(await quien(pendiente.pago.id)).toMatchObject({ estado: 'CONFIRMADO', usuario: dueno, rol: 'DUENO', en: expect.any(Date) });
      // Repetir no cambia quién confirmó; rechazar uno pendiente no guarda a nadie.
      expect((await k.as(o).post(`/v1/pagos/${pendiente.pago.id}/confirmar`)).statusCode).toBe(200);
      const otro = (await venderPlan(c, await cliente(o), plan, { metodoPago: 'DEUNA' })).json();
      expect((await k.as(o).post(`/v1/pagos/${otro.pago.id}/rechazar`)).statusCode).toBe(200);
      expect(await quien(otro.pago.id)).toMatchObject({ estado: 'RECHAZADO', usuario: null, rol: null, en: null });
    });

    it('efectivo no cambia: el cajero no necesita referencia y queda CONFIRMADO a su nombre', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const r = await venderPlan(c, await cliente(o), await k.plan(o), { metodoPago: 'EFECTIVO' });
      expect(r.statusCode, r.body).toBe(201);
      expect(await quien(r.json().pago.id)).toMatchObject({ estado: 'CONFIRMADO', rol: 'CAJERO', ref: null });
    });

    it('reintento con la misma Idempotency-Key devuelve la misma venta y no crea otro pago', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const cli = await cliente(o);
      const plan = await k.plan(o);
      const key = randomUUID();
      const body = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, referenciaExterna: 'TR-REINTENTO' };
      const a = await venderPlan(c, cli, plan, body, key);
      const b = await venderPlan(c, cli, plan, body, key);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(b.json().id).toBe(a.json().id);
      expect(await pagosDelLocal(o)).toBe(1);
    });
  });

  describe('venta suelta, cuenta de cobro y canje de oferta', () => {
    it('POS: sin referencia → 422; con referencia → CONFIRMADO a nombre del cajero; repetida → 409 REFERENCIA_PAGO_REPETIDA', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const sin = await venderPos(c, { metodoPago: 'DEUNA', pagoConfirmado: true });
      expect(sin.statusCode, sin.body).toBe(422);
      expect(sin.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REQUERIDA' });
      expect(await pagosDelLocal(o)).toBe(0);
      const con = await venderPos(c, { metodoPago: 'DEUNA', pagoConfirmado: true, referenciaExterna: 'DU-1' });
      expect(con.statusCode, con.body).toBe(201);
      expect(await quien(con.json().pago.id)).toMatchObject({ estado: 'CONFIRMADO', rol: 'CAJERO', ref: 'DU-1' });
      const rep = await venderPos(o, { metodoPago: 'DEUNA', pagoConfirmado: true, referenciaExterna: 'DU-1' });
      expect(rep.statusCode, rep.body).toBe(409);
      expect(rep.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REPETIDA' });
      // El dueño, sin referencia, sí.
      expect((await venderPos(o, { metodoPago: 'DEUNA', pagoConfirmado: true })).statusCode).toBe(201);
    });

    it('cuenta: cobrar sin referencia → 422 y la cuenta sigue ABIERTA; validar con cobro sin referencia → 422 sin descontar ni abrir cuenta', async () => {
      const o = await k.activeOwner();
      await k.menu(o);
      const c = await cajero(o);
      const cli = await cliente(o);
      const v = await k.as(c).post('/v1/caja/validar', { clienteId: cli }, randomUUID());
      expect(v.statusCode, v.body).toBe(200);
      const cuenta = v.json().cuenta.id as string;
      const cobro = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, saldoEsperadoCentavos: P };
      const sin = await k.as(c).post(`/v1/caja/cuentas/${cuenta}/cobrar`, cobro, randomUUID());
      expect(sin.statusCode, sin.body).toBe(422);
      expect(sin.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REQUERIDA' });
      expect((await k.as(c).get(`/v1/caja/cuentas/${cuenta}`)).json()).toMatchObject({ estado: 'ABIERTA', saldoCentavos: P, pagos: [] });
      const con = await k.as(c).post(`/v1/caja/cuentas/${cuenta}/cobrar`, { ...cobro, referenciaExterna: 'TR-CUENTA' }, randomUUID());
      expect(con.statusCode, con.body).toBe(200);
      expect(con.json()).toMatchObject({ estado: 'COBRADA' });
      expect(await quien(con.json().pagos[0].id)).toMatchObject({ estado: 'CONFIRMADO', rol: 'CAJERO', ref: 'TR-CUENTA' });

      // En el mismo paso de validar: la transacción entera se deshace (ni cuenta, ni pago).
      const cli2 = await cliente(o);
      const antes = await pagosDelLocal(o);
      const v2 = await k.as(c).post('/v1/caja/validar', { clienteId: cli2, cobro }, randomUUID());
      expect(v2.statusCode, v2.body).toBe(422);
      expect(v2.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REQUERIDA' });
      expect(await pagosDelLocal(o)).toBe(antes);
      const rastro = await probe!.sql<{ cuentas: number; consumos: number }>(
        `SELECT (SELECT count(*)::int FROM cuenta_cobro WHERE cliente_id = $1) AS cuentas,
                (SELECT count(*)::int FROM consumo_almuerzo WHERE cliente_id = $1) AS consumos`,
        [cli2],
      );
      expect(rastro.rows[0]).toEqual({ cuentas: 0, consumos: 0 });
    });

    it('canje de oferta: el cajero con TRANSFERENCIA necesita referencia; con ella queda a su nombre; repetida → 409; efectivo y dueño no la necesitan', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const pub = await k.as(o).post('/v1/ofertas', offer({ stock: 5 }), randomUUID());
      expect(pub.statusCode, pub.body).toBe(201);
      const id = pub.json().id as string;
      const canjear = (who: Quien, body: object) => k.as(who).post(`/v1/ofertas/${id}/canjear`, body, randomUUID());

      const sin = await canjear(c, { metodoPago: 'TRANSFERENCIA' });
      expect(sin.statusCode, sin.body).toBe(422);
      expect(sin.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REQUERIDA' });
      expect((await k.as(o).get('/v1/ofertas')).json().items[0]).toMatchObject({ stockRestante: 5 });

      const con = await canjear(c, { metodoPago: 'TRANSFERENCIA', referenciaExterna: 'TR-OFERTA' });
      expect(con.statusCode, con.body).toBe(201);
      const pago = await probe!.sql<{ rol: string; ref: string; estado: string }>(
        `SELECT p.confirmado_por_rol::text AS rol, p.referencia_externa AS ref, p.estado FROM transaccion_pago p
           JOIN canje_oferta_flash x ON x.canje_id = p.canje_oferta_id WHERE x.public_id = $1`,
        [con.json().id],
      );
      expect(pago.rows).toEqual([{ rol: 'CAJERO', ref: 'TR-OFERTA', estado: 'CONFIRMADO' }]);

      const rep = await canjear(o, { metodoPago: 'TRANSFERENCIA', referenciaExterna: 'TR-OFERTA' });
      expect(rep.statusCode, rep.body).toBe(409);
      expect(rep.json()).toMatchObject({ code: 'REFERENCIA_PAGO_REPETIDA' });
      expect((await canjear(c, { metodoPago: 'EFECTIVO' })).statusCode).toBe(201);
      expect((await canjear(o, { metodoPago: 'DEUNA' })).statusCode).toBe(201);
    });
  });

  describe('cierre de caja', () => {
    it('separa lo confirmado por cajero, dueño y sin registro; los reversos restan del original; efectivoEsperado y totales no cambian', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const plan = await k.plan(o); // 1500
      const tr = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true };

      await venderPlan(c, await cliente(o), plan, { metodoPago: 'EFECTIVO' }); // efectivo +1500 cajero
      await venderPos(o, { metodoPago: 'EFECTIVO' }); // efectivo +350 dueño
      const deshacer = (await venderPos(c, { metodoPago: 'EFECTIVO' })).json(); // efectivo +350 cajero …
      expect((await k.as(o).post(`/v1/caja/ventas/${deshacer.id}/deshacer`, undefined, randomUUID())).statusCode).toBe(200); // … −350 (del cajero)
      await venderPlan(c, await cliente(o), plan, { ...tr, referenciaExterna: 'TR-C1' }); // transferencia +1500 cajero
      const pendiente = (await venderPlan(c, await cliente(o), plan, { metodoPago: 'TRANSFERENCIA' })).json();
      await k.as(o).post(`/v1/pagos/${pendiente.pago.id}/confirmar`); // transferencia +1500 dueño
      const antiguo = (await venderPos(o, { ...tr })).json(); // transferencia +350, como pago de antes (sin registro)
      await comoAntiguo(antiguo.pago.id);
      await venderPlan(c, await cliente(o), plan, { metodoPago: 'DEUNA' }); // pendiente: no suma

      const a = await cierre(o);
      expect(a).toMatchObject({ efectivoEsperadoCentavos: 1500 + 350, totalCentavos: 1850 + 3350, pagosPendientes: 1 });
      expect(metodo(a, 'EFECTIVO')).toMatchObject({
        totalCentavos: 1850,
        confirmadoPorCajeroCentavos: 1500,
        confirmadoPorDuenoCentavos: 350,
        confirmadoSinRegistroCentavos: 0,
      });
      expect(metodo(a, 'TRANSFERENCIA')).toMatchObject({
        totalCentavos: 3350,
        confirmadoPorCajeroCentavos: 1500,
        confirmadoPorDuenoCentavos: 1500,
        confirmadoSinRegistroCentavos: 350,
      });
      for (const m of a.porMetodo)
        expect(m.confirmadoPorCajeroCentavos + m.confirmadoPorDuenoCentavos + m.confirmadoSinRegistroCentavos).toBe(m.totalCentavos);
      // Lo que ve el cajero es lo mismo, y el cierre guarda el mismo efectivo esperado de siempre.
      expect(await cierre(c)).toEqual(a);
      const cerrado = await k.as(c).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: 1850 });
      expect(cerrado.statusCode, cerrado.body).toBe(201);
      expect(cerrado.json().cierre).toMatchObject({ efectivoEsperadoCentavos: 1850, diferenciaCentavos: 0 });
    });
  });

  describe('aislamiento entre locales', () => {
    it('la misma referencia vale en otro local; cada cierre ve solo lo suyo; ni el cajero ni el dueño tocan pagos ajenos', async () => {
      const a = await k.activeOwner();
      const b = await k.activeOwner();
      const ca = await cajero(a);
      const cb = await cajero(b);
      const body = { metodoPago: 'TRANSFERENCIA', pagoConfirmado: true, referenciaExterna: 'TR-COMPARTIDA' };
      const pa = await venderPlan(ca, await cliente(a), await k.plan(a), body);
      const pb = await venderPlan(cb, await cliente(b), await k.plan(b), body);
      expect([pa.statusCode, pb.statusCode]).toEqual([201, 201]);
      expect(metodo(await cierre(a), 'TRANSFERENCIA')).toMatchObject({ totalCentavos: 1500, confirmadoPorCajeroCentavos: 1500 });
      expect(metodo(await cierre(b), 'TRANSFERENCIA')).toMatchObject({ totalCentavos: 1500, confirmadoPorCajeroCentavos: 1500 });

      // El cajero de A no opera en B; el dueño de B no confirma un pago de A (404).
      const ajeno = await venderPlan({ token: ca.token, restaurante: b.restaurante }, await cliente(b), await k.plan(b), body);
      expect(ajeno.statusCode).toBe(403);
      const pendienteA = (await venderPlan(ca, await cliente(a), await k.plan(a), { metodoPago: 'DEUNA' })).json();
      expect((await k.as(b).post(`/v1/pagos/${pendienteA.pago.id}/confirmar`)).statusCode).toBe(404);
      expect(await quien(pendienteA.pago.id)).toMatchObject({ estado: 'PENDIENTE', rol: null });

      // RLS como bck_api: con el tenant de B no se ve el pago de A ni quién lo confirmó.
      const tenantB = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id::text AS id FROM restaurante WHERE public_id = $1', [b.restaurante])
      ).rows[0]!.id;
      const visto = await k.rls(
        { tenantId: tenantB, userId: await k.internalUser(b.usuarioId) },
        'SELECT confirmado_por_rol FROM transaccion_pago WHERE public_id = $1',
        [pa.json().pago.id],
      );
      expect(visto).toEqual([]);
    });
  });

  describe('barreras de la base', () => {
    it('como bck_api no se reescribe quién confirmó un pago CONFIRMADO, ni se marca quién en uno que no queda CONFIRMADO', async () => {
      const o = await k.activeOwner();
      const c = await cajero(o);
      const plan = await k.plan(o);
      const conf = (await venderPlan(c, await cliente(o), plan, { metodoPago: 'EFECTIVO' })).json();
      const pend = (await venderPlan(c, await cliente(o), plan, { metodoPago: 'DEUNA' })).json();
      const tenant = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id::text AS id FROM restaurante WHERE public_id = $1', [o.restaurante])
      ).rows[0]!.id;
      const ctx = { tenantId: tenant, userId: await k.internalUser(o.usuarioId) };
      await expect(
        k.rls(ctx, `UPDATE transaccion_pago SET confirmado_por_rol = 'DUENO' WHERE public_id = $1`, [conf.pago.id]),
      ).rejects.toMatchObject({ code: '23001' }); // restrict_violation: un pago CONFIRMADO no cambia
      await expect(
        k.rls(
          ctx,
          `UPDATE transaccion_pago SET confirmado_por_usuario_id = app_user_id(), confirmado_por_rol = 'DUENO', confirmado_en = now()
            WHERE public_id = $1`,
          [pend.pago.id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'ck_pago_confirmado_por' }); // sigue PENDIENTE
      expect(await quien(conf.pago.id)).toMatchObject({ rol: 'CAJERO' });
      expect(await quien(pend.pago.id)).toMatchObject({ estado: 'PENDIENTE', rol: null });
    });
  });
});
