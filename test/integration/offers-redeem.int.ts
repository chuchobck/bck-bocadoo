import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { offer } from './offers-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: canje de ofertas con control de stock', () => {
  const k = new DinerKit(probe!, 92);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const publish = async (o: Parameters<DinerKit['as']>[0], extra: object = {}) => {
    const r = await k.as(o).post('/v1/ofertas', offer(extra), randomUUID());
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const redeem = (o: Parameters<DinerKit['as']>[0], id: string, body: object = { metodoPago: 'EFECTIVO' }, key = randomUUID()) =>
    k.as(o).post(`/v1/ofertas/${id}/canjear`, body, key);

  it('canjear descuenta el stock y registra el cobro confirmado por el precio de la oferta', async () => {
    const o = await k.activeOwner();
    const id = await publish(o, { stock: 3 });
    const r = await redeem(o, id, { cantidad: 2, metodoPago: 'EFECTIVO' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      cantidad: 2,
      montoCentavos: 900,
      moneda: 'USD',
      metodoPago: 'EFECTIVO',
      comensalId: null,
      oferta: { id, stockTotal: 3, stockRestante: 1, canjeadas: 2, estado: 'VIGENTE' },
    });
    expectOnlyPublicIds(r.json());
    const pago = await probe!.sql<{ monto: string; estado: string; fecha: string }>(
      `SELECT p.monto_centavos AS monto, p.estado, p.fecha_local::text AS fecha
         FROM transaccion_pago p JOIN canje_oferta_flash c ON c.canje_id = p.canje_oferta_id
         JOIN restaurante r ON r.restaurante_id = c.restaurante_id WHERE r.public_id = $1`,
      [o.restaurante],
    );
    expect(pago.rows).toEqual([{ monto: '900', estado: 'CONFIRMADO', fecha: expect.any(String) }]);
    // El cobro entra al arqueo de caja del día (efectivo esperado).
    const hoy = (
      await probe!.sql<{ d: string }>(
        `SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date::text AS d FROM restaurante WHERE public_id = $1`,
        [o.restaurante],
      )
    ).rows[0]!.d;
    const cierre = await k.as(o).get(`/v1/caja/cierre/${hoy}`);
    expect(cierre.json().efectivoEsperadoCentavos, cierre.body).toBe(900);
  });

  it('se agota: el último canje llega a 0, el siguiente es OFERTA_AGOTADA y uno que pide de más es STOCK_INSUFICIENTE', async () => {
    const o = await k.activeOwner();
    const id = await publish(o, { stock: 3 });
    const demasiado = await redeem(o, id, { cantidad: 4, metodoPago: 'EFECTIVO' });
    expect(demasiado.json()).toMatchObject({ status: 409, code: 'STOCK_INSUFICIENTE' });
    expect((await redeem(o, id, { cantidad: 3, metodoPago: 'DEUNA' })).statusCode).toBe(201);
    const agotada = await redeem(o, id);
    expect(agotada.json()).toMatchObject({ status: 409, code: 'OFERTA_AGOTADA' });
    const lista = (await k.as(o).get('/v1/ofertas')).json().items[0];
    expect(lista).toMatchObject({ stockRestante: 0, canjeadas: 3, estado: 'AGOTADA' });
    // Un canje rechazado no deja cobro ni canje.
    const own = await probe!.sql<{ c: number }>(
      `SELECT count(*)::int AS c FROM canje_oferta_flash c JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1`,
      [o.restaurante],
    );
    expect(own.rows[0]!.c).toBe(1);
  });

  it('cerrada, vencida o aún no iniciada: 409 con su código, y no se descuenta nada', async () => {
    const o = await k.activeOwner();
    const cerrada = await publish(o);
    await k.as(o).post(`/v1/ofertas/${cerrada}/cerrar`);
    expect((await redeem(o, cerrada)).json()).toMatchObject({ status: 409, code: 'OFERTA_CERRADA' });
    const vencida = await publish(o);
    await probe!.sql(
      `UPDATE oferta_flash SET inicia_en = inicia_en - interval '3 hours', expira_en = expira_en - interval '3 hours' WHERE public_id = $1`,
      [vencida],
    );
    expect((await redeem(o, vencida)).json()).toMatchObject({ status: 409, code: 'OFERTA_EXPIRADA' });
    const futura = await publish(o);
    await probe!.sql(
      `UPDATE oferta_flash SET inicia_en = inicia_en + interval '1 hour', expira_en = expira_en + interval '2 hours' WHERE public_id = $1`,
      [futura],
    );
    expect((await redeem(o, futura)).json()).toMatchObject({ status: 409, code: 'OFERTA_NO_INICIADA' });
    for (const id of [cerrada, vencida, futura]) {
      const s = await probe!.sql<{ stock_restante: number }>('SELECT stock_restante FROM oferta_flash WHERE public_id = $1', [id]);
      expect(s.rows[0]!.stock_restante).toBe(5);
    }
  });

  it('misma Idempotency-Key → mismo canje y un solo descuento; la llave de otra oferta → 409', async () => {
    const o = await k.activeOwner();
    const a = await publish(o);
    const b = await publish(o);
    const key = randomUUID();
    const r1 = await redeem(o, a, { metodoPago: 'EFECTIVO' }, key);
    const r2 = await redeem(o, a, { metodoPago: 'EFECTIVO' }, key);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().id).toBe(r1.json().id);
    expect(r2.json().oferta.stockRestante).toBe(4);
    expect((await redeem(o, b, { metodoPago: 'EFECTIVO' }, key)).json()).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUTILIZADA',
    });
    expect((await k.as(o).post(`/v1/ofertas/${a}/canjear`, { metodoPago: 'EFECTIVO' })).json().code).toBe('IDEMPOTENCY_KEY_INVALIDA');
    const stock = await probe!.sql<{ stock_restante: number }>('SELECT stock_restante FROM oferta_flash WHERE public_id = $1', [a]);
    expect(stock.rows[0]!.stock_restante).toBe(4);
  });

  it('un comensal con cuenta se identifica por public_id; uno inexistente → 404; entradas inválidas → 400', async () => {
    const o = await k.activeOwner();
    const id = await publish(o);
    const d = await k.diner();
    const ok = await redeem(o, id, { metodoPago: 'TRANSFERENCIA', comensalId: d.usuarioId });
    expect(ok.json()).toMatchObject({ comensalId: d.usuarioId, metodoPago: 'TRANSFERENCIA' });
    const c = await probe!.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM canje_oferta_flash c JOIN usuario u USING (usuario_id) WHERE u.public_id = $1`,
      [d.usuarioId],
    );
    expect(c.rows[0]!.n).toBe(1);
    expect((await redeem(o, id, { metodoPago: 'EFECTIVO', comensalId: randomUUID() })).json()).toMatchObject({
      status: 404,
      code: 'COMENSAL_NO_ENCONTRADO',
    });
    for (const mala of [
      { metodoPago: 'BITCOIN' },
      { metodoPago: 'EFECTIVO', cantidad: 0 },
      { metodoPago: 'EFECTIVO', cantidad: 11 },
      { metodoPago: 'EFECTIVO', monto: 1 },
      {},
    ]) {
      expect((await redeem(o, id, mala)).statusCode, JSON.stringify(mala)).toBe(400);
    }
    expect((await k.as(o).post('/v1/ofertas/no-es-uuid/canjear', { metodoPago: 'EFECTIVO' }, randomUUID())).statusCode).toBe(400);
  });

  it('cajero y dueño canjean; un comensal no; el canje de otro local es un 404 y no toca su stock', async () => {
    const o = await k.activeOwner();
    const otro = await k.activeOwner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    const id = await publish(o);
    expect((await redeem(cajero, id)).statusCode).toBe(201);
    expect((await redeem({ token: d.token, restaurante: o.restaurante }, id)).statusCode).toBe(403);
    expect((await redeem({}, id)).statusCode).toBe(401);
    expect((await redeem(otro, id)).json()).toMatchObject({ status: 404, code: 'OFERTA_NO_ENCONTRADA' });
    expect((await k.as(o).get('/v1/ofertas')).json().items[0]).toMatchObject({ stockRestante: 4, canjeadas: 1 });
  });

  it('el canje es de solo inserción: la API no puede borrarlo ni editarlo, y no hay rastro de comisión', async () => {
    const o = await k.activeOwner();
    const id = await publish(o);
    await redeem(o, id);
    const rid = (
      await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [o.restaurante])
    ).rows[0]!.restaurante_id;
    await expect(
      k.h.db.scope({ tenantId: String(rid) }, (q) => q.query('UPDATE canje_oferta_flash SET cantidad = 9')),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(k.h.db.scope({ tenantId: String(rid) }, (q) => q.query('DELETE FROM canje_oferta_flash'))).rejects.toMatchObject({
      code: '42501',
    });
    const com = await probe!.sql(
      `SELECT 1 FROM libro_comision_bocadoo l JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1`,
      [o.restaurante],
    );
    expect(com.rowCount).toBe(0);
  });
});
