import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Diner, DinerKit } from './diner-kit';
import type { Probe } from './probe';
import { ScratchDb } from './scratch-db';

const scratch = process.env.PROBE_DATABASE_URL ? await ScratchDb.create() : null;
const P = 350;
const B = 100;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

/**
 * PR 6 con conexiones reales y simultáneas (clon descartable, ver scratch-db.ts): validar la mesa compite con salir y
 * con otra validación por el candado de la mesa (FOR UPDATE) y el de cada miembro (pg_advisory_xact_lock(miembro_id));
 * la misma llave repetida a la vez no duplica descuentos ni cuentas.
 */
describe.skipIf(!scratch)('PR 6: cobro de mesa con peticiones simultáneas', () => {
  const k = new DinerKit(scratch as unknown as Probe, 142);
  beforeAll(() => k.start());
  afterAll(async () => {
    await k.stop();
    await scratch?.drop();
  });

  async function local() {
    const o = await k.activeOwner();
    expect((await k.as(o).patch('/v1/restaurante', { momentoCobro: 'DESPUES_DE_SERVIR' })).statusCode).toBe(200);
    const m = await k.menu(o);
    return { o, cola: m.Cola! };
  }
  type Local = Awaited<ReturnType<typeof local>>;

  /** Mesa CADA_UNO: anfitrión con plan (sin selección: 1 almuerzo) e invitado con plan que pidió solo una Cola (su plan no se toca). */
  async function mesa(l: Local) {
    const host = await k.dinerWithPlan(l.o);
    const guest = await k.dinerWithPlan(l.o);
    const r = await k
      .as(host)
      .post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo: 'CADA_UNO' }, randomUUID());
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    expect((await k.as(guest).post(`/v1/mesas/invitacion/${id}/unirse`, {}, randomUUID())).statusCode).toBe(200);
    expect((await k.as(guest).put(`/v1/mis/mesas/${id}/seleccion`, { extras: [{ plato: l.cola, cantidad: 1 }] })).statusCode).toBe(200);
    return { id, host, guest };
  }

  /** Lo que quedó en la base para la mesa: consumos vivos, cuentas, ítems de selección y miembros que salieron. */
  const estado = (mesaPublicId: string) =>
    k.h.db.service(async (q) => {
      const r = await q.query<{ consumos: number; cuentas: number; items: number; salidos: number; saldos: number[] }>(
        `SELECT (SELECT count(*)::int FROM consumo_almuerzo c WHERE c.mesa_compartida_id = m.mesa_compartida_id AND c.cantidad = 1) AS consumos,
                (SELECT count(*)::int FROM cuenta_cobro c WHERE c.mesa_compartida_id = m.mesa_compartida_id) AS cuentas,
                (SELECT count(*)::int FROM mesa_compartida_miembro_item i WHERE i.mesa_compartida_id = m.mesa_compartida_id) AS items,
                (SELECT count(*)::int FROM mesa_compartida_miembro x WHERE x.mesa_compartida_id = m.mesa_compartida_id AND x.salio_en IS NOT NULL) AS salidos,
                COALESCE((SELECT array_agg(s.saldo_centavos::int ORDER BY c.cuenta_id) FROM cuenta_cobro c JOIN v_cuenta_saldo s USING (cuenta_id)
                           WHERE c.mesa_compartida_id = m.mesa_compartida_id), '{}') AS saldos
           FROM mesa_compartida m WHERE m.public_id = $1`,
        [mesaPublicId],
      );
      return r.rows[0]!;
    });
  const saldoPlan = async (l: Local, d: Diner) =>
    (await k.as(l.o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles as number;

  it('validar y salir a la vez: o sale antes (no se le cobra nada) o la caja valida antes (salir → 409 MESA_CERRADA y se le cobra)', async () => {
    const l = await local();
    const vistos = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const { id, guest } = await mesa(l);
      const [v, s] = await Promise.all([
        k.as(l.o).post(`/v1/caja/mesas/${id}/validar`, undefined, randomUUID()),
        k.as(guest).post(`/v1/mis/mesas/${id}/salir`),
      ]);
      expect(v.statusCode, v.body).toBe(200);
      const fin = await estado(id);
      if (s.statusCode === 200) {
        vistos.add('salio-antes');
        expect(v.json().resultados).toHaveLength(1);
        expect(fin).toMatchObject({ consumos: 1, cuentas: 0, items: 0, salidos: 1 });
      } else {
        vistos.add('validada-antes');
        expect([s.statusCode, s.json().code]).toEqual([409, 'MESA_CERRADA']);
        expect(v.json().resultados).toHaveLength(2);
        expect(v.json().resultados[1]).toMatchObject({ resultado: 'SIN_ALMUERZO', cuentaId: v.json().cuentas[0].id });
        expect(fin).toMatchObject({ consumos: 1, cuentas: 1, items: 1, salidos: 0, saldos: [B] });
      }
      expect(await saldoPlan(l, guest)).toBe(5);
    }
    // Informativo: con 6 intentos suele verse al menos un orden; los dos son válidos.
    expect(vistos.size).toBeGreaterThan(0);
  });

  it('dos cajas validan la misma mesa a la vez (llaves distintas): un solo cobro; la otra ve yaValidada con las mismas cuentas', async () => {
    const l = await local();
    const caja = await k.h.cashier(l.o.restaurante);
    for (let i = 0; i < 3; i++) {
      const { id, host, guest } = await mesa(l);
      const res = await Promise.all(
        [l.o, caja, l.o, caja].map((w) => k.as(w).post(`/v1/caja/mesas/${id}/validar`, undefined, randomUUID())),
      );
      expect(
        res.map((r) => r.statusCode),
        res.map((r) => r.body).join('\n'),
      ).toEqual([200, 200, 200, 200]);
      expect(res.filter((r) => r.json().yaValidada === false)).toHaveLength(1);
      expect(new Set(res.map((r) => JSON.stringify(r.json().cuentas.map((c: { id: string }) => c.id))))).toEqual(
        new Set([JSON.stringify(res[0]!.json().cuentas.map((c: { id: string }) => c.id))]),
      );
      expect(await estado(id)).toMatchObject({ consumos: 1, cuentas: 1, saldos: [B] });
      expect([await saldoPlan(l, host), await saldoPlan(l, guest)]).toEqual([4, 5]);
    }
  });

  it('la misma llave en 4 peticiones simultáneas (reintento doble): un solo descuento y una sola cuenta', async () => {
    const l = await local();
    const { id, host, guest } = await mesa(l);
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => k.as(l.o).post(`/v1/caja/mesas/${id}/validar`, {}, key)));
    expect(
      res.map((r) => r.statusCode),
      res.map((r) => r.body).join('\n'),
    ).toEqual([200, 200, 200, 200]);
    expect(res.filter((r) => r.json().yaValidada === false)).toHaveLength(1);
    expect(new Set(res.map((r) => r.json().cuentas[0]?.id)).size).toBe(1);
    expect(await estado(id)).toMatchObject({ consumos: 1, cuentas: 1, saldos: [B] });
    expect([await saldoPlan(l, host), await saldoPlan(l, guest)]).toEqual([4, 5]);
    // Y otra vez en serie con la misma llave: lo mismo.
    const again = await k.as(l.o).post(`/v1/caja/mesas/${id}/validar`, {}, key);
    expect(again.json()).toMatchObject({ yaValidada: true });
    expect(await estado(id)).toMatchObject({ consumos: 1, cuentas: 1 });
  });

  it('elegir y salir a la vez: nunca queda selección de quien salió', async () => {
    const l = await local();
    for (let i = 0; i < 6; i++) {
      const { id, guest } = await mesa(l);
      const [sel, s] = await Promise.all([
        k.as(guest).put(`/v1/mis/mesas/${id}/seleccion`, { extras: [{ plato: l.cola, cantidad: 3 }] }),
        k.as(guest).post(`/v1/mis/mesas/${id}/salir`),
      ]);
      expect(s.statusCode, s.body).toBe(200);
      expect([200, 409]).toContain(sel.statusCode);
      if (sel.statusCode === 409) expect(sel.json().code).toBe('SALISTE_DE_LA_MESA');
      expect(await estado(id)).toMatchObject({ items: 0, salidos: 1 });
      const v = (await k.as(l.o).post(`/v1/caja/mesas/${id}/validar`, undefined, randomUUID())).json();
      expect(v.cuentas).toEqual([]); // el anfitrión con plan: nada por cobrar
      expect(v.cotizacion.subtotalCentavos).toBe(P);
    }
  });
});
