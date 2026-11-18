import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolFactory } from '../../src/db/db.service';
import { PassEventBus, type PassEvent } from '../../src/pass-events/bus';
import { Actor, Harness, unique } from './harness';

/**
 * Eventos del pase con la base real: qué emite la caja y cuándo. El stream SSE en sí se prueba sin base
 * (test/pass-events-sse.spec.ts); aquí se escucha el bus directamente.
 */

/** Pools reales; con `failCommit` el COMMIT de una transacción que desconto un almuerzo falla (y se deshace). */
let failCommit = false;
const wrapped = new WeakSet<pg.PoolClient>();
const failingCommitPools: PoolFactory = (connectionString, max) => {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client) as (text: string, params?: unknown[]) => Promise<pg.QueryResult>;
      let desconto = false;
      (client as unknown as { query: typeof query }).query = async (text, params) => {
        if (/^BEGIN/.test(text)) desconto = false;
        if (text.includes('fn_descontar_almuerzo')) desconto = true;
        if (text === 'COMMIT' && failCommit && desconto) {
          await query('ROLLBACK');
          throw new Error('COMMIT fallido (simulado)');
        }
        return query(text, params);
      };
    }
    return client;
  };
  return pool;
};

describe('Eventos del pase (bus) con la caja real', () => {
  const h = new Harness(77);
  beforeAll(() => h.start({ poolFactory: failingCommitPools }));
  afterAll(() => h.stop());

  const as = (who: { token: string; restaurante?: string }) => {
    const send = (method: 'GET' | 'POST', url: string, payload?: object, key?: string) =>
      h.app.inject({
        method,
        url,
        payload,
        remoteAddress: h.ip(),
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(who.restaurante && { 'x-restaurant-id': who.restaurante }),
          ...(key && { 'idempotency-key': key }),
        },
      });
    return {
      get: (url: string) => send('GET', url),
      post: (url: string, payload?: object, key?: string) => send('POST', url, payload, key),
    };
  };
  const internalUser = async (publicId: string) =>
    String(
      (await h.db.service((q) => q.query<{ usuario_id: string }>('SELECT usuario_id FROM usuario WHERE public_id = $1', [publicId])))
        .rows[0]!.usuario_id,
    );
  /** Comensal con cuenta, cliente del local con un plan de 5 almuerzos, y lo que le llega por el bus. */
  async function diner(o: Actor) {
    const d = await h.diner();
    const p = (
      await as(o).post('/v1/planes', {
        tipo: 'SEMANAL',
        nombre: 'Semanal',
        almuerzos: 5,
        precioCentavos: 1500,
        vigenciaDias: 7,
        diasValidos: [1, 2, 3, 4, 5, 6, 7],
      })
    ).json().id as string;
    const c = (await as(o).post('/v1/clientes', { nombre: `Cliente ${unique()}` })).json().id as string;
    await as(o).post(`/v1/clientes/${c}/planes`, { planId: p, metodoPago: 'EFECTIVO' }, randomUUID());
    expect((await as(o).post(`/v1/clientes/${c}/vincular`, { correo: d.correo })).statusCode).toBe(200);
    const eventos: PassEvent[] = [];
    h.app.get(PassEventBus).subscribe(await internalUser(d.usuarioId), (e) => eventos.push(e));
    return { ...d, clienteId: c, eventos };
  }
  const codigo = async (d: { token: string }, restaurante: string) =>
    (await as(d).get(`/v1/pase/codigo?restaurante=${restaurante}`)).json().codigo as string;

  it('validar → CANJE_REGISTRADO solo al comensal; reintento y doble escaneo no repiten; deshacer → CANJE_REVERTIDO', async () => {
    const o = await h.owner('Eventos Local');
    await h.publishMenu(o);
    const ana = await diner(o);
    const otro = await diner(o);

    const key = randomUUID();
    const res = await as(o).post('/v1/caja/validar', { codigoQr: await codigo(ana, o.restaurante) }, key);
    expect(res.json()).toMatchObject({ resultado: 'OK', almuerzosRestantes: 4 });
    const consumoId = res.json().consumo.id as string;
    expect(ana.eventos).toEqual([
      {
        tipo: 'CANJE_REGISTRADO',
        consumoId,
        restauranteNombre: 'Eventos Local',
        saldoRestante: 4,
        platoNombre: null,
        hora: res.json().consumo.creadoEn,
      },
    ]);
    expect(otro.eventos).toEqual([]);

    // Reintento con la misma clave: misma respuesta, sin evento nuevo.
    expect((await as(o).post('/v1/caja/validar', { codigoQr: await codigo(ana, o.restaurante) }, key)).json().consumo.id).toBe(consumoId);
    // Segundo escaneo (otra clave) antes de 60 s: DUPLICADO, sin evento.
    const dup = await as(o).post('/v1/caja/validar', { codigoQr: await codigo(ana, o.restaurante) }, randomUUID());
    expect(dup.json()).toMatchObject({ resultado: 'DUPLICADO', descontado: false, almuerzosRestantes: 4 });
    expect(ana.eventos).toHaveLength(1);

    expect((await as(o).post(`/v1/caja/consumos/${consumoId}/deshacer`)).json()).toEqual({ id: consumoId, revertido: true });
    expect(ana.eventos[1]).toMatchObject({ tipo: 'CANJE_REVERTIDO', consumoId, restauranteNombre: 'Eventos Local', saldoRestante: 5 });
    // Deshacer otra vez (idempotente) no repite el evento.
    await as(o).post(`/v1/caja/consumos/${consumoId}/deshacer`);
    expect(ana.eventos).toHaveLength(2);
    expect(otro.eventos).toEqual([]);
  });

  it('si el COMMIT falla no sale ningún evento y el saldo no cambia', async () => {
    const o = await h.owner('Eventos Commit');
    await h.publishMenu(o);
    const ana = await diner(o);
    failCommit = true;
    try {
      const res = await as(o).post('/v1/caja/validar', { clienteId: ana.clienteId }, randomUUID());
      expect(res.statusCode).toBe(500);
    } finally {
      failCommit = false;
    }
    expect(ana.eventos).toEqual([]);
    expect((await as(o).get(`/v1/clientes/${ana.clienteId}`)).json().almuerzosDisponibles).toBe(5);
    // Ya sin falla, el mismo canje sí avisa.
    expect((await as(o).post('/v1/caja/validar', { clienteId: ana.clienteId }, randomUUID())).json().resultado).toBe('OK');
    expect(ana.eventos).toEqual([expect.objectContaining({ tipo: 'CANJE_REGISTRADO', saldoRestante: 4 })]);
  });
});
