import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

type Ctx = { userId?: string; tenantId?: string };

/**
 * Cuentas de cobro (docs/spec-cobros.md F.1, F.4 y F.5; migración 20261121150000_cuentas_cobro). Todavía no hay
 * endpoints: se prueba la base directo, como bck_api sujeto a RLS (k.rls) y como bck_servicio (db.service).
 */
describe.skipIf(!probe)('Cuentas de cobro: tablas, libro de líneas, transiciones y RLS', () => {
  const k = new DinerKit(probe!, 110);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const one = async <T extends object>(sql: string, params?: unknown[]) =>
    (await probe!.sql<T & Record<string, unknown>>(sql, params)).rows[0]!;

  /** Local activo con su dueño (contexto de personal), un comensal con plan y un almuerzo ya descontado. */
  async function escenario() {
    const o = await k.activeOwner();
    const diner = await k.dinerWithPlan(o);
    const consumoPublic = await k.lunch(o, diner.clienteId);
    const { restaurante_id: restauranteId, moneda_codigo: moneda } = await one<{ restaurante_id: string; moneda_codigo: string }>(
      'SELECT restaurante_id, moneda_codigo FROM restaurante WHERE public_id = $1',
      [o.restaurante],
    );
    const dueno = await k.internalUser(o.usuarioId);
    const usuario = await k.internalUser(diner.usuarioId);
    const ids = await one<{ personal_id: string; cliente_id: string; consumo_id: string; suscripcion_id: string }>(
      `SELECT p.personal_id, c.cliente_id, x.consumo_id, x.suscripcion_id
         FROM personal_restaurante p, cliente_restaurante c, consumo_almuerzo x
        WHERE p.restaurante_id = $1 AND p.usuario_id = $2 AND c.restaurante_id = $1 AND c.usuario_id = $3 AND x.public_id = $4`,
      [restauranteId, dueno, usuario, consumoPublic],
    );
    const personal: Ctx = { userId: dueno, tenantId: restauranteId };
    return { o, restauranteId, moneda, personal, comensal: { userId: usuario } as Ctx, usuario, ...ids };
  }
  type Escenario = Awaited<ReturnType<typeof escenario>>;

  /** Crea una cuenta como el personal del local (tenant_total). Origen: el consumo del escenario. */
  async function cuenta(e: Escenario, origen: { consumo_id?: string } = { consumo_id: e.consumo_id }) {
    const r = await k.rls<{ cuenta_id: string }>(
      e.personal,
      `INSERT INTO cuenta_cobro (restaurante_id, consumo_id, cliente_id, usuario_id, nombre_pagador, momento_cobro, moneda_codigo,
                                 clave_idempotencia, huella, personal_id, fecha_local)
       SELECT r.restaurante_id, $2, $3, $4, 'Ana', r.momento_cobro, r.moneda_codigo,
              gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $5, CURRENT_DATE
         FROM restaurante r WHERE r.restaurante_id = $1
       RETURNING cuenta_id`,
      [e.restauranteId, origen.consumo_id ?? null, e.cliente_id, e.usuario, e.personal_id],
    );
    return r[0]!.cuenta_id;
  }

  /** Inserta una línea; por defecto una bebida de 100 cobrada en caja. */
  function linea(ctx: Ctx, e: Escenario, cuentaId: string, valores: Record<string, unknown> = {}) {
    const fila: Record<string, unknown> = {
      cuenta_id: cuentaId,
      restaurante_id: e.restauranteId,
      ref: randomUUID(),
      persona_ref: 'p0',
      tipo: 'BEBIDA',
      fuente: 'CAJA',
      nombre: 'Cola',
      cantidad: 1,
      precio_unitario_centavos: 100,
      recargo_unitario_centavos: 0,
      subtotal_centavos: 100,
      recargo_centavos: 0,
      cubierto_centavos: 0,
      clave_idempotencia: randomUUID(),
      ...valores,
    };
    const cols = Object.keys(fila);
    return k.rls<{ linea_id: string }>(
      ctx,
      `INSERT INTO cuenta_cobro_linea (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING linea_id`,
      Object.values(fila),
    );
  }

  const estado = async (cuentaId: string) =>
    (await one<{ estado: string }>('SELECT estado FROM cuenta_cobro WHERE cuenta_id = $1', [cuentaId])).estado;

  it('el personal crea y lee las cuentas de su local; otro local no ve cuentas, líneas ni saldos, ni escribe en ellas', async () => {
    const a = await escenario();
    const b = await escenario();
    const c = await cuenta(a);
    await linea(a.personal, a, c);

    const cuantas = (ctx: Ctx) =>
      k
        .rls<{ c: number; l: number; s: number }>(
          ctx,
          `SELECT (SELECT count(*) FROM cuenta_cobro)::int AS c, (SELECT count(*) FROM cuenta_cobro_linea)::int AS l,
                  (SELECT count(*) FROM v_cuenta_saldo)::int AS s`,
        )
        .then((r) => r[0]);
    expect(await cuantas(a.personal)).toEqual({ c: 1, l: 1, s: 1 });
    expect(await cuantas(b.personal)).toEqual({ c: 0, l: 0, s: 0 });
    expect(await cuantas({ userId: b.usuario })).toEqual({ c: 0, l: 0, s: 0 }); // otro comensal tampoco

    // Otro local no escribe: ni una línea con el restaurante ajeno (RLS) ni con el suyo apuntando a la cuenta ajena (FK).
    await expect(linea(b.personal, a, c)).rejects.toThrow(/row-level security/);
    await expect(linea(b.personal, { ...a, restauranteId: b.restauranteId }, c)).rejects.toThrow(/fk_linea_cuenta/);
    const upd = await k.rls(
      b.personal,
      `UPDATE cuenta_cobro SET estado = 'ANULADA', anulada_en = now() WHERE cuenta_id = $1 RETURNING cuenta_id`,
      [c],
    );
    expect(upd).toEqual([]);
    expect(await estado(c)).toBe('ABIERTA');
  });

  it('comensal: lee solo sus cuentas y sus líneas; no inserta ni actualiza', async () => {
    const a = await escenario();
    const c = await cuenta(a);
    await linea(a.personal, a, c);
    const otro = await k.internalUser((await k.diner()).usuarioId);

    expect(await k.rls(a.comensal, 'SELECT cuenta_id FROM cuenta_cobro')).toEqual([{ cuenta_id: c }]);
    expect(await k.rls(a.comensal, 'SELECT count(*)::int AS n FROM cuenta_cobro_linea')).toEqual([{ n: 1 }]);
    expect(await k.rls({ userId: otro }, 'SELECT count(*)::int AS n FROM cuenta_cobro')).toEqual([{ n: 0 }]);
    expect(await k.rls({ userId: otro }, 'SELECT count(*)::int AS n FROM cuenta_cobro_linea')).toEqual([{ n: 0 }]);

    // No inserta cuentas ni líneas, ni siquiera a su propio nombre.
    await expect(cuenta({ ...a, personal: a.comensal })).rejects.toThrow(/row-level security/);
    await expect(linea(a.comensal, a, c)).rejects.toThrow(/row-level security/);
    // No actualiza: su cuenta no es visible para UPDATE (comensal_lee es solo SELECT).
    const upd = await k.rls(
      a.comensal,
      `UPDATE cuenta_cobro SET estado = 'COBRADA', cobrada_en = now() WHERE cuenta_id = $1 RETURNING cuenta_id`,
      [c],
    );
    expect(upd).toEqual([]);
    expect(await estado(c)).toBe('ABIERTA');
    await expect(k.rls(a.comensal, 'DELETE FROM cuenta_cobro_linea')).rejects.toThrow(/permission denied/);
  });

  it('cuenta_cobro_linea es de solo inserción: UPDATE y DELETE fallan para la API y para el rol de servicio', async () => {
    const a = await escenario();
    const c = await cuenta(a);
    const [{ linea_id: l }] = (await linea(a.personal, a, c)) as [{ linea_id: string }];

    await expect(k.rls(a.personal, 'UPDATE cuenta_cobro_linea SET nombre = $2 WHERE linea_id = $1', [l, 'Otra'])).rejects.toThrow(
      /permission denied/,
    );
    await expect(k.rls(a.personal, 'DELETE FROM cuenta_cobro_linea WHERE linea_id = $1', [l])).rejects.toThrow(/permission denied/);
    await expect(
      k.h.db.service((q) => q.query('UPDATE cuenta_cobro_linea SET nombre = $2 WHERE linea_id = $1', [l, 'Otra'])),
    ).rejects.toThrow(/solo-inserción/);
    await expect(k.h.db.service((q) => q.query('DELETE FROM cuenta_cobro_linea WHERE linea_id = $1', [l]))).rejects.toThrow(
      /solo-inserción/,
    );
    expect((await one<{ nombre: string }>('SELECT nombre FROM cuenta_cobro_linea WHERE linea_id = $1', [l])).nombre).toBe('Cola');
  });

  it('transiciones: ABIERTA → COBRADA → ABIERTA → ANULADA; ANULADA es terminal; nada más cambia ni se borra', async () => {
    const a = await escenario();
    const c = await cuenta(a);
    const set = (id: string, sql: string) =>
      k.rls(a.personal, `UPDATE cuenta_cobro SET ${sql} WHERE cuenta_id = $1 RETURNING estado`, [id]);
    const invalida = /transición de estado inválida/;

    await expect(set(c, `estado = 'ABIERTA'`)).rejects.toThrow(invalida);
    expect(await set(c, `estado = 'COBRADA', cobrada_en = now()`)).toEqual([{ estado: 'COBRADA' }]);
    await expect(set(c, `estado = 'COBRADA'`)).rejects.toThrow(invalida);
    expect(await set(c, `estado = 'ABIERTA', cobrada_en = NULL`)).toEqual([{ estado: 'ABIERTA' }]); // pago rechazado
    await expect(set(c, `estado = 'COBRADA'`)).rejects.toThrow(/ck_cuenta_cobrada/); // COBRADA exige cobrada_en
    await expect(set(c, `estado = 'ANULADA'`)).rejects.toThrow(/ck_cuenta_anulada/); // ANULADA exige anulada_en
    expect(
      await k.rls(
        a.personal,
        `UPDATE cuenta_cobro SET estado = 'ANULADA', anulada_en = now(), anulada_por_personal_id = $2, motivo_anulacion = 'error de caja'
          WHERE cuenta_id = $1 RETURNING estado`,
        [c, a.personal_id],
      ),
    ).toEqual([{ estado: 'ANULADA' }]);
    for (const sql of [
      `estado = 'ABIERTA', anulada_en = NULL`,
      `estado = 'COBRADA', cobrada_en = now(), anulada_en = NULL`,
      `estado = 'ANULADA'`,
    ])
      await expect(set(c, sql)).rejects.toThrow(invalida);
    expect(await estado(c)).toBe('ANULADA');

    // COBRADA → ANULADA también vale. Anulada la primera, el mismo consumo admite otra cuenta (índice parcial).
    const c2 = await cuenta(a);
    await expect(cuenta(a)).rejects.toThrow(/uq_cuenta_por_consumo/);
    expect(await set(c2, `estado = 'COBRADA', cobrada_en = now()`)).toEqual([{ estado: 'COBRADA' }]);
    expect(await set(c2, `estado = 'ANULADA', anulada_en = now()`)).toEqual([{ estado: 'ANULADA' }]);

    // Columnas fuera del estado: la API no tiene permiso; el rol de servicio choca con el trigger. Nadie borra.
    await expect(set(c2, `nombre_pagador = 'Otro'`)).rejects.toThrow(/permission denied/);
    await expect(k.rls(a.personal, 'DELETE FROM cuenta_cobro WHERE cuenta_id = $1', [c2])).rejects.toThrow(/permission denied/);
    await expect(
      k.h.db.service((q) => q.query(`UPDATE cuenta_cobro SET nombre_pagador = 'Otro' WHERE cuenta_id = $1`, [c])),
    ).rejects.toThrow(/solo cambia su estado/);
    await expect(k.h.db.service((q) => q.query('DELETE FROM cuenta_cobro WHERE cuenta_id = $1', [c]))).rejects.toThrow(/no admite DELETE/);
  });

  it('origen de la cuenta: exactamente uno; una mesa exige el miembro pagador', async () => {
    const a = await escenario();
    await expect(cuenta(a, {})).rejects.toThrow(/ck_cuenta_origen_unico/);
    await expect(
      k.rls(
        a.personal,
        `INSERT INTO cuenta_cobro (restaurante_id, consumo_id, orden_id, nombre_pagador, momento_cobro, moneda_codigo, clave_idempotencia, huella,
                                   personal_id, fecha_local)
         VALUES ($1, $2, NULL, 'Ana', 'ANTES_DE_SERVIR', $4, gen_random_uuid(), repeat('a', 64), $3, CURRENT_DATE)`,
        [a.restauranteId, a.consumo_id, a.personal_id, a.moneda],
      ),
    ).resolves.toEqual([]);
    await expect(
      k.rls(
        a.personal,
        `INSERT INTO cuenta_cobro (restaurante_id, mesa_compartida_id, nombre_pagador, momento_cobro, moneda_codigo, clave_idempotencia, huella,
                                   personal_id, fecha_local)
         VALUES ($1, 1, 'Ana', 'ANTES_DE_SERVIR', $3, gen_random_uuid(), repeat('a', 64), $2, CURRENT_DATE)`,
        [a.restauranteId, a.personal_id, a.moneda],
      ),
    ).rejects.toThrow(/ck_cuenta_mesa_con_miembro/);
  });

  it('CHECKs de las líneas: PLAN exige ALMUERZO, cantidad 1 y consumo; las omitidas van en 0; los montos cuadran; un solo reverso', async () => {
    const a = await escenario();
    const c = await cuenta(a);
    const plan = { tipo: 'ALMUERZO', fuente: 'PLAN', nombre: 'Almuerzo', consumo_id: a.consumo_id, precio_unitario_centavos: 350 };
    const ins = (v: Record<string, unknown>) => linea(a.personal, a, c, v);

    await expect(ins({ ...plan, cantidad: 1, subtotal_centavos: 350, cubierto_centavos: 350 })).resolves.toHaveLength(1);
    await expect(ins({ ...plan, cantidad: 2, subtotal_centavos: 700, cubierto_centavos: 700 })).rejects.toThrow(/ck_linea_plan/);
    await expect(ins({ ...plan, consumo_id: null, subtotal_centavos: 350, cubierto_centavos: 350 })).rejects.toThrow(/ck_linea_plan/);
    await expect(ins({ ...plan, tipo: 'EXTRA', subtotal_centavos: 350, cubierto_centavos: 350 })).rejects.toThrow(/ck_linea_plan/);
    await expect(ins({ ...plan, subtotal_centavos: 350, cubierto_centavos: 0 })).rejects.toThrow(/ck_linea_montos/); // PLAN cubre todo

    // Omitidas: conservan cantidad y precio, montos en 0, siempre CAJA.
    await expect(
      ins({ tipo: 'ALMUERZO', omitida: 'DUPLICADO', precio_unitario_centavos: 350, subtotal_centavos: 0, cubierto_centavos: 0 }),
    ).resolves.toHaveLength(1);
    await expect(
      ins({ omitida: 'PLATO_AGOTADO', cantidad: 3, recargo_unitario_centavos: 25, subtotal_centavos: 0, recargo_centavos: 0 }),
    ).resolves.toHaveLength(1);
    await expect(ins({ omitida: 'PLATO_AGOTADO', subtotal_centavos: 100 })).rejects.toThrow(/ck_linea_omitida/);
    await expect(ins({ ...plan, omitida: 'LIMITE_SAAS', subtotal_centavos: 0, cubierto_centavos: 0 })).rejects.toThrow(/ck_linea_omitida/);

    // Montos de una línea cobrada.
    await expect(ins({ cantidad: 2, subtotal_centavos: 150 })).rejects.toThrow(/ck_linea_montos/);
    await expect(ins({ recargo_unitario_centavos: 25, recargo_centavos: 0 })).rejects.toThrow(/ck_linea_montos/);
    await expect(ins({ cubierto_centavos: 100 })).rejects.toThrow(/ck_linea_montos/);
    await expect(ins({ tipo: 'OFERTA', fuente: 'OFERTA' })).rejects.toThrow(/ck_linea_oferta/);
    await expect(ins({ cantidad: 0, subtotal_centavos: 0 })).rejects.toThrow(/violates check constraint/); // cantidad <> 0

    // Reverso: fila inversa enlazada, una sola por línea y de la misma cuenta.
    const [{ linea_id: l }] = (await ins({ cantidad: 2, subtotal_centavos: 200 })) as [{ linea_id: string }];
    await expect(ins({ cantidad: -2, subtotal_centavos: -200 })).rejects.toThrow(/ck_linea_reverso/);
    await expect(ins({ revierte_a_linea_id: l })).rejects.toThrow(/ck_linea_reverso/);
    await expect(ins({ cantidad: -2, subtotal_centavos: -200, revierte_a_linea_id: l })).resolves.toHaveLength(1);
    await expect(ins({ cantidad: -2, subtotal_centavos: -200, revierte_a_linea_id: l })).rejects.toThrow(/uq_linea_un_solo_reverso/);

    // La misma clave de idempotencia no entra dos veces.
    const clave = randomUUID();
    await ins({ clave_idempotencia: clave });
    await expect(ins({ clave_idempotencia: clave })).rejects.toThrow(/uq_linea_clave/);
  });

  it('pagos de una cuenta: transaccion_pago.cuenta_cobro_id cuenta como origen único; v_cuenta_saldo descuenta los no rechazados', async () => {
    const a = await escenario();
    const c = await cuenta(a);
    await linea(a.personal, a, c, {
      tipo: 'A_LA_CARTA',
      cantidad: 2,
      precio_unitario_centavos: 500,
      subtotal_centavos: 1000,
      recargo_unitario_centavos: 25,
      recargo_centavos: 50,
    });
    const pago = (origen: string, monto: number, estadoPago = 'CONFIRMADO') =>
      k.rls<{ pago_id: string }>(
        a.personal,
        `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, ${origen}, cobrado_por_personal_id,
                                       fecha_local, clave_idempotencia)
         SELECT $1, (SELECT metodo_pago_id FROM metodo_pago WHERE codigo = 'EFECTIVO' LIMIT 1), $2, $6, $3::estado_pago_enum, $4, $5, CURRENT_DATE, gen_random_uuid()
         RETURNING pago_id`,
        [a.restauranteId, monto, estadoPago, origen === 'cuenta_cobro_id' ? c : a.suscripcion_id, a.personal_id, a.moneda],
      );

    // Con cuenta y otro origen a la vez: falla la CHECK nueva (ya no la de la baseline).
    await expect(
      k.rls(
        a.personal,
        `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, cuenta_cobro_id, suscripcion_id,
                                       cobrado_por_personal_id, fecha_local, clave_idempotencia)
         SELECT $1, metodo_pago_id, 100, $5, $2, $3, $4, CURRENT_DATE, gen_random_uuid() FROM metodo_pago WHERE codigo = 'EFECTIVO' LIMIT 1`,
        [a.restauranteId, c, a.suscripcion_id, a.personal_id, a.moneda],
      ),
    ).rejects.toThrow(/ck_pago_origen_unico/);
    await expect(pago('suscripcion_id', 100)).resolves.toHaveLength(1); // los orígenes de siempre siguen valiendo

    const saldo = async (ctx: Ctx) =>
      (await k.rls(ctx, 'SELECT por_cobrar_centavos, pagado_centavos, saldo_centavos FROM v_cuenta_saldo WHERE cuenta_id = $1', [c]))[0];
    expect(await saldo(a.personal)).toEqual({ por_cobrar_centavos: '1050', pagado_centavos: '0', saldo_centavos: '1050' });
    await pago('cuenta_cobro_id', 600);
    const [{ pago_id: pendiente }] = (await pago('cuenta_cobro_id', 450, 'PENDIENTE')) as [{ pago_id: string }];
    expect(await saldo(a.personal)).toEqual({ por_cobrar_centavos: '1050', pagado_centavos: '1050', saldo_centavos: '0' });
    await k.rls(a.personal, `UPDATE transaccion_pago SET estado = 'RECHAZADO' WHERE pago_id = $1`, [pendiente]);
    expect(await saldo(a.personal)).toEqual({ por_cobrar_centavos: '1050', pagado_centavos: '600', saldo_centavos: '450' });

    // security_invoker: el comensal ve su cuenta en la vista, pero no los pagos (transaccion_pago no tiene política de
    // comensal), así que su "saldo" no descuenta lo pagado. Hallazgo para el PR 5 (docs/estado.md).
    expect(await saldo(a.comensal)).toEqual({ por_cobrar_centavos: '1050', pagado_centavos: '0', saldo_centavos: '1050' });
  });
});
