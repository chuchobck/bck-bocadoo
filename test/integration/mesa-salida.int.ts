import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_DAYS, DinerKit } from './diner-kit';
import { unique } from './harness';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * Salir de una mesa y plan del pagador para la cotización del comensal (docs/spec-cobros.md E.6, E.7, F.2 y H.1;
 * migración 20261121150200_mesa_salida_ofertas). Aún no hay endpoints: se llama a las funciones como bck_api.
 */
describe.skipIf(!probe)('Mesa compartida: fn_salir_mesa y fn_plan_pagador_mesa', () => {
  const k = new DinerKit(probe!, 111);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Persona = { token: string; usuarioId: string };

  async function mesa(o: Local, host: Persona, invitados: Persona[], modo: 'CADA_UNO' | 'INVITO_YO' = 'CADA_UNO') {
    const r = await k.as(host).post('/v1/mis/mesas', { restaurante: o.restaurante, horaLlegada: inMinutes(30), modo }, randomUUID());
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    for (const g of invitados) expect((await k.as(g).post(`/v1/mesas/invitacion/${id}/unirse`, {}, randomUUID())).statusCode).toBe(200);
    const interna = (await probe!.sql<{ id: string }>('SELECT mesa_compartida_id AS id FROM mesa_compartida WHERE public_id = $1', [id]))
      .rows[0]!.id;
    const miembro = async (p: Persona) =>
      (
        await probe!.sql<{ id: string }>(
          'SELECT x.miembro_id AS id FROM mesa_compartida_miembro x JOIN usuario u USING (usuario_id) WHERE x.mesa_compartida_id = $1 AND u.public_id = $2',
          [interna, p.usuarioId],
        )
      ).rows[0]!.id;
    return { id, interna, miembro };
  }

  const yo = async (p: Persona) => ({ userId: await k.internalUser(p.usuarioId) });
  const salir = async (p: Persona, mesaId: string) =>
    (await k.rls<{ r: string }>(await yo(p), 'SELECT fn_salir_mesa($1) AS r', [mesaId]))[0]!.r;
  const items = async (mesaInterna: string) =>
    (
      await probe!.sql<{ n: number }>('SELECT count(*)::int AS n FROM mesa_compartida_miembro_item WHERE mesa_compartida_id = $1', [
        mesaInterna,
      ])
    ).rows[0]!.n;
  const cola = (ids: Record<string, string>) => ({ extras: [{ plato: ids['Cola']!, cantidad: 2 }] });

  describe('fn_salir_mesa', () => {
    it('un invitado sale: marca salio_en, borra solo su selección y repetir no cambia nada', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const host = await k.diner();
      const guest = await k.diner();
      const m = await mesa(o, host, [guest]);
      for (const p of [host, guest]) expect((await k.as(p).put(`/v1/mis/mesas/${m.id}/seleccion`, cola(ids))).statusCode).toBe(200);
      expect(await items(m.interna)).toBe(2);

      expect(await salir(guest, m.id)).toBe('SALIO');
      const fila = (
        await probe!.sql<{ salio_en: Date | null }>('SELECT salio_en FROM mesa_compartida_miembro WHERE miembro_id = $1', [
          await m.miembro(guest),
        ])
      ).rows[0]!;
      expect(fila.salio_en).toBeInstanceOf(Date);
      expect(await items(m.interna)).toBe(1); // la del anfitrión sigue
      expect(await salir(guest, m.id)).toBe('YA_SALIO');
      const otra = (
        await probe!.sql<{ salio_en: Date }>('SELECT salio_en FROM mesa_compartida_miembro WHERE miembro_id = $1', [await m.miembro(guest)])
      ).rows[0]!;
      expect(otra.salio_en).toEqual(fila.salio_en);
      // El código de hoy no se entera: la vista de la mesa sigue respondiendo.
      expect((await k.as(host).get(`/v1/mis/mesas/${m.id}`)).statusCode).toBe(200);
    });

    it('no miembro, mesa inexistente, anfitrión, mesa validada o cancelada: no sale y no borra nada', async () => {
      const o = await k.activeOwner();
      const ids = await k.menu(o);
      const host = await k.diner();
      const guest = await k.diner();
      const m = await mesa(o, host, [guest]);
      expect((await k.as(guest).put(`/v1/mis/mesas/${m.id}/seleccion`, cola(ids))).statusCode).toBe(200);

      expect(await salir(await k.diner(), m.id)).toBe('NO_ENCONTRADA');
      expect(await salir(guest, randomUUID())).toBe('NO_ENCONTRADA');
      expect(await salir(host, m.id)).toBe('ANFITRION_NO_PUEDE_SALIR');
      // Sin usuario en la sesión (solo tenant) no corre.
      const restaurante = (
        await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [o.restaurante])
      ).rows[0]!.id;
      await expect(k.rls({ tenantId: restaurante }, 'SELECT fn_salir_mesa($1)', [m.id])).rejects.toThrow(/usuario en la sesión/);

      const caja = await k.h.cashier(o.restaurante);
      expect((await k.as(caja).post(`/v1/caja/mesas/${m.id}/validar`, undefined, randomUUID())).statusCode).toBe(200);
      expect(await salir(guest, m.id)).toBe('MESA_CERRADA');

      const otra = await mesa(o, host, [guest]);
      expect((await k.as(host).post(`/v1/mis/mesas/${otra.id}/cancelar`)).statusCode).toBe(200);
      expect(await salir(guest, otra.id)).toBe('MESA_CERRADA');

      expect(await items(m.interna)).toBe(1);
      const salidos = await probe!.sql(
        'SELECT 1 FROM mesa_compartida_miembro WHERE salio_en IS NOT NULL AND mesa_compartida_id IN ($1, $2)',
        [m.interna, otra.interna],
      );
      expect(salidos.rowCount).toBe(0);
      // Ni el personal (que sí puede actualizar miembros por tenant_total) marca como salido al anfitrión.
      await expect(
        k.rls({ tenantId: restaurante }, 'UPDATE mesa_compartida_miembro SET salio_en = now() WHERE miembro_id = $1', [
          await m.miembro(host),
        ]),
      ).rejects.toThrow(/ck_miembro_anfitrion_no_sale/);
    });
  });

  describe('fn_plan_pagador_mesa', () => {
    const plan = (o: Local, almuerzos: number, diasValidos = ALL_DAYS) =>
      k.dinerWithPlan(o, { nombre: `Plan ${unique()}`, almuerzos, diasValidos });
    const disponibles = async (quien: Persona, mesaInterna: string, miembro: string) => {
      const filas = await k.rls(await yo(quien), 'SELECT fn_plan_pagador_mesa($1, $2) AS n', [mesaInterna, miembro]);
      expect(filas).toHaveLength(1);
      expect(Object.keys(filas[0]!)).toEqual(['n']); // solo el entero, nada más del plan ni del cliente
      return filas[0]!.n as number | null;
    };

    it('CADA_UNO: el anfitrión ve el de cada miembro; el invitado solo el suyo; no miembros y otras mesas no obtienen nada', async () => {
      const o = await k.activeOwner();
      const host = await plan(o, 5);
      const guest = await plan(o, 7);
      const sinPlan = await k.diner();
      const m = await mesa(o, host, [guest, sinPlan]);
      const [mHost, mGuest, mSinPlan] = [await m.miembro(host), await m.miembro(guest), await m.miembro(sinPlan)];

      expect(await disponibles(host, m.interna, mHost)).toBe(5);
      expect(await disponibles(host, m.interna, mGuest)).toBe(3); // 7 reales, acotado a los 3 miembros: no es su plan
      expect(await disponibles(host, m.interna, mSinPlan)).toBe(0);
      expect(await disponibles(guest, m.interna, mGuest)).toBe(7); // el propio pagador ve el valor real
      expect(await disponibles(guest, m.interna, mHost)).toBeNull(); // misma visibilidad que la selección (E.6)
      expect(await disponibles(guest, m.interna, mSinPlan)).toBeNull();
      expect(await disponibles(await k.diner(), m.interna, mHost)).toBeNull();

      // Otra mesa (de otro local): sus miembros no se filtran por la mía ni al revés.
      const o2 = await k.activeOwner();
      const ajeno = await plan(o2, 4);
      const m2 = await mesa(o2, ajeno, []);
      const mAjeno = await m2.miembro(ajeno);
      expect(await disponibles(host, m.interna, mAjeno)).toBeNull();
      expect(await disponibles(host, m2.interna, mAjeno)).toBeNull();
      expect(await disponibles(ajeno, m2.interna, mAjeno)).toBe(4);
      expect(await disponibles(ajeno, m.interna, mHost)).toBeNull();
      expect(await disponibles(ajeno, m2.interna, mHost)).toBeNull();

      // Quien salió deja de preguntar y de ser preguntado.
      expect(await salir(guest, m.id)).toBe('SALIO');
      expect(await disponibles(guest, m.interna, mGuest)).toBeNull();
      expect(await disponibles(host, m.interna, mGuest)).toBeNull();
    });

    it('INVITO_YO: el pagador es el anfitrión; el invitado recibe el saldo acotado a los miembros de la mesa, el anfitrión el real', async () => {
      const o = await k.activeOwner();
      const host = await plan(o, 20);
      const guest = await plan(o, 2); // su propio plan no cuenta: paga el anfitrión
      const otro = await k.diner();
      const m = await mesa(o, host, [guest, otro], 'INVITO_YO');
      expect(await disponibles(guest, m.interna, await m.miembro(guest))).toBe(3); // LEAST(20, 3 miembros)
      expect(await disponibles(otro, m.interna, await m.miembro(otro))).toBe(3);
      expect(await disponibles(host, m.interna, await m.miembro(guest))).toBe(20);
      expect(await disponibles(host, m.interna, await m.miembro(host))).toBe(20);
      expect(await disponibles(guest, m.interna, await m.miembro(host))).toBeNull();
      // Quien sale ya no cuenta en el tope.
      expect(await salir(otro, m.id)).toBe('SALIO');
      expect(await disponibles(guest, m.interna, await m.miembro(guest))).toBe(2);

      // Plan del anfitrión con 1 almuerzo en una mesa de 3: el invitado recibe 1 (el tope nunca sube el valor).
      const o2 = await k.activeOwner();
      const host2 = await plan(o2, 1);
      const g1 = await k.diner();
      const g2 = await k.diner();
      const m2 = await mesa(o2, host2, [g1, g2], 'INVITO_YO');
      expect(await disponibles(g1, m2.interna, await m2.miembro(g1))).toBe(1);
      expect(await disponibles(host2, m2.interna, await m2.miembro(g2))).toBe(1);
    });

    it('cuenta como fn_descontar_almuerzo: solo planes que valen hoy (dias_validos) y del local de la mesa', async () => {
      const o = await k.activeOwner();
      const hoy = (
        await probe!.sql<{ d: number }>(
          'SELECT EXTRACT(ISODOW FROM (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria))::int AS d FROM restaurante WHERE public_id = $1',
          [o.restaurante],
        )
      ).rows[0]!.d;
      const host = await plan(o, 5);
      const otroDia = await plan(
        o,
        4,
        ALL_DAYS.filter((d) => d !== hoy),
      );
      // Un plan en OTRO local no suma en esta mesa.
      const otroLocal = await k.activeOwner();
      const conPlanAfuera = await plan(otroLocal, 6);
      const m = await mesa(o, host, [otroDia, conPlanAfuera]);
      expect(await disponibles(host, m.interna, await m.miembro(otroDia))).toBe(0);
      expect(await disponibles(host, m.interna, await m.miembro(conPlanAfuera))).toBe(0);
      expect(await disponibles(host, m.interna, await m.miembro(host))).toBe(5);
      // Un almuerzo descontado baja el número.
      await k.lunch(o, host.clienteId);
      expect(await disponibles(host, m.interna, await m.miembro(host))).toBe(4);
    });

    it('sin usuario en la sesión no corre; id de mesa inexistente → NULL', async () => {
      const o = await k.activeOwner();
      const host = await plan(o, 5);
      const m = await mesa(o, host, []);
      await expect(k.rls({}, 'SELECT fn_plan_pagador_mesa($1, $2)', [m.interna, await m.miembro(host)])).rejects.toThrow(
        /usuario en la sesión/,
      );
      expect(await disponibles(host, '999999999', await m.miembro(host))).toBeNull();
    });
  });

  it('endurecimiento: SECURITY DEFINER con search_path fijo, sin EXECUTE para PUBLIC ni para el rol de servicio', async () => {
    const r = await probe!.sql<{ f: string; secdef: boolean; config: string[]; publico: boolean; app: boolean; servicio: boolean }>(
      `SELECT p.oid::regprocedure::text AS f, p.prosecdef AS secdef, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS publico,
              has_function_privilege('bocadoo_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('bocadoo_servicio', p.oid, 'EXECUTE') AS servicio
         FROM pg_proc p WHERE p.proname IN ('fn_salir_mesa', 'fn_plan_pagador_mesa') ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      {
        f: 'fn_plan_pagador_mesa(bigint,bigint)',
        secdef: true,
        config: ['search_path=public, pg_temp'],
        publico: false,
        app: true,
        servicio: false,
      },
      { f: 'fn_salir_mesa(uuid)', secdef: true, config: ['search_path=public, pg_temp'], publico: false, app: true, servicio: false },
    ]);
  });
});
