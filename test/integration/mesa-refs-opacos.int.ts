import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { llaveQr } from '../../src/auth/qr-secret.service';
import { calcularRef, subclaveRefs } from '../../src/cobro/refs-mesa';
import { type Diner, DinerKit } from './diner-kit';
import { unique } from './harness';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;
const C = 600; // Churrasco (A_LA_CARTA, carta fija)
const B = 100; // Cola (BEBIDA, menú de hoy)
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const REF = /^[A-Za-z0-9_-]{22}$/;

/**
 * PR 9: ningún `miembro_id` real sale en una respuesta. Cada miembro trae `ref` (HMAC de mesa + miembro, 22 caracteres)
 * y ese mismo ref reemplaza al id en `personaRef`, `pagadorRef`, `lineas[].ref`, `avisos[].lineaRef` y las cuentas de
 * mesa, para el comensal, el anfitrión y la caja. Patrón probe: cada prueba termina en ROLLBACK.
 */
describe.skipIf(!probe)('PR 9: ids opacos de los miembros de una mesa', () => {
  const k = new DinerKit(probe!, 149);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Quien = { token: string; restaurante?: string };
  type Persona = Diner & { clienteId?: string };
  type Cot = {
    lineas: { ref: string; personaRef: string; pagadorRef: string }[];
    porPagador: { pagadorRef: string }[];
    avisos: { lineaRef: string | null }[];
    subtotalCentavos: number;
    recargoCentavos: number;
    totalCentavos: number;
    cubiertoPorPlanCentavos: number;
    saldoPorCobrarCentavos: number;
  };
  type Miembro = { ref: string; soyYo?: boolean; esAnfitrion: boolean; salio: boolean; cotizacion: Cot | null };
  type Cuenta = { id: string; saldoCentavos: number; cotizacion: Cot };

  async function local() {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const ch = await k.as(o).post('/v1/menu/platos', { nombre: 'Churrasco', categoria: 'A_LA_CARTA', precioCentavos: C });
    expect(ch.statusCode, ch.body).toBe(201);
    const churrasco = (await probe!.sql<{ id: string }>('SELECT public_id AS id FROM plato WHERE plato_id = $1', [ch.json().id])).rows[0]!
      .id;
    return { o, seco: m['Seco de pollo']!, cola: m.Cola!, churrasco };
  }
  type Local = Awaited<ReturnType<typeof local>>;

  const conPlan = (l: Local): Promise<Persona> => k.dinerWithPlan(l.o, { nombre: `Plan ${unique()}`, almuerzos: 5 });
  const ok = <T>(r: { statusCode: number; body: string; json: () => T }, status = 200): T => {
    expect(r.statusCode, r.body).toBe(status);
    return r.json();
  };
  const elegir = (p: Quien, mesaId: string, sel: { almuerzo?: string[]; extras?: [string, number][] }) =>
    k.as(p).put(`/v1/mis/mesas/${mesaId}/seleccion`, {
      ...(sel.almuerzo && { almuerzo: { platos: sel.almuerzo } }),
      ...(sel.extras && { extras: sel.extras.map(([plato, cantidad]) => ({ plato, cantidad })) }),
    });
  const totales = (c: Cot) => [c.subtotalCentavos, c.recargoCentavos, c.totalCentavos, c.cubiertoPorPlanCentavos, c.saldoPorCobrarCentavos];

  /** Ids internos de la mesa y sus miembros (incluye los que salieron), para buscarlos en las respuestas. */
  async function internos(mesaPublicId: string) {
    const r = await probe!.sql<{ mesa: string; miembro: string }>(
      `SELECT m.mesa_compartida_id::text AS mesa, x.miembro_id::text AS miembro
         FROM mesa_compartida m JOIN mesa_compartida_miembro x USING (mesa_compartida_id) WHERE m.public_id = $1 ORDER BY x.miembro_id`,
      [mesaPublicId],
    );
    return { mesa: r.rows[0]!.mesa, miembros: r.rows.map((x) => x.miembro) };
  }

  /**
   * PRUEBA CENTRAL: recorre la respuesta entera y falla si algún string es un miembro_id real o empieza por `<id>:` (el
   * prefijo de `lineas[].ref` y `avisos[].lineaRef`).
   */
  function sinMiembroIds(valor: unknown, ids: string[], ruta = '$'): void {
    if (typeof valor === 'string') {
      for (const id of ids) {
        expect(valor, `${ruta} expone el miembro_id ${id}`).not.toBe(id);
        expect(valor.startsWith(`${id}:`), `${ruta} = ${valor} empieza por el miembro_id ${id}`).toBe(false);
      }
      return;
    }
    if (Array.isArray(valor)) return valor.forEach((v, i) => sinMiembroIds(v, ids, `${ruta}[${i}]`));
    if (valor && typeof valor === 'object') for (const [c, v] of Object.entries(valor)) sinMiembroIds(v, ids, `${ruta}.${c}`);
  }

  /** Mesa CADA_UNO: A (plan) elige Seco + Cola; B (sin plan, para llevar) solo el Churrasco; C entra y sale. */
  async function mesaCadaUno(l: Local) {
    const [a, b, c] = [await conPlan(l), await k.diner(), await k.diner()];
    const respuestas: { nombre: string; body: unknown }[] = [];
    const guardar = <T>(nombre: string, body: T): T => (respuestas.push({ nombre, body }), body);
    const m = guardar(
      'comensal: crear',
      ok<{ id: string }>(
        await k.as(a).post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo: 'CADA_UNO' }, randomUUID()),
        201,
      ),
    );
    guardar('comensal: unirse B', ok(await k.as(b).post(`/v1/mesas/invitacion/${m.id}/unirse`, { paraLlevar: true }, randomUUID())));
    guardar('comensal: unirse C', ok(await k.as(c).post(`/v1/mesas/invitacion/${m.id}/unirse`, {}, randomUUID())));
    guardar('comensal: salir C', ok(await k.as(c).post(`/v1/mis/mesas/${m.id}/salir`)));
    guardar('comensal: selección A', ok(await elegir(a, m.id, { almuerzo: [l.seco], extras: [[l.cola, 1]] })));
    guardar('comensal: selección B', ok(await elegir(b, m.id, { extras: [[l.churrasco, 1]] })));
    return { id: m.id, a, b, c, respuestas, guardar };
  }

  it('PRUEBA CENTRAL: ninguna respuesta de mesa (comensal, anfitrión, caja, validar, cuentas, cotizaciones) trae un miembro_id real', async () => {
    const l = await local();
    const caja = await k.h.cashier(l.o.restaurante);
    const t = await mesaCadaUno(l);
    const { guardar } = t;
    guardar('anfitrión: GET mesa', ok(await k.as(t.a).get(`/v1/mis/mesas/${t.id}`)));
    guardar('anfitrión: mis mesas', ok(await k.as(t.a).get('/v1/mis/mesas')));
    guardar('invitado: GET mesa', ok(await k.as(t.b).get(`/v1/mis/mesas/${t.id}`)));
    guardar('invitado que salió: GET mesa', ok(await k.as(t.c).get(`/v1/mis/mesas/${t.id}`)));
    guardar('caja: vista previa', ok(await k.as(caja).get(`/v1/caja/mesas/${t.id}`)));
    const key = randomUUID();
    const v = guardar(
      'caja: validar',
      ok<{ cuentas: Cuenta[]; avisos: unknown[] }>(await k.as(caja).post(`/v1/caja/mesas/${t.id}/validar`, undefined, key)),
    );
    guardar('caja: validar (reintento)', ok(await k.as(caja).post(`/v1/caja/mesas/${t.id}/validar`, undefined, key)));
    guardar('caja: validar (otra llave)', ok(await k.as(l.o).post(`/v1/caja/mesas/${t.id}/validar`, {}, randomUUID())));
    guardar('anfitrión: GET mesa validada', ok(await k.as(t.a).get(`/v1/mis/mesas/${t.id}`)));
    guardar('caja: vista validada', ok(await k.as(caja).get(`/v1/caja/mesas/${t.id}`)));
    guardar('caja: cuentas del día', ok(await k.as(caja).get('/v1/caja/cuentas')));
    guardar('caja: cuentas MESA', ok(await k.as(l.o).get('/v1/caja/cuentas?origen=MESA')));
    expect(v.cuentas).toHaveLength(2);
    for (const c of v.cuentas) guardar(`caja: cuenta ${c.id}`, ok(await k.as(caja).get(`/v1/caja/cuentas/${c.id}`)));
    const [primera, segunda] = v.cuentas as [Cuenta, Cuenta];
    guardar(
      'caja: cobrar',
      ok(
        await k
          .as(caja)
          .post(
            `/v1/caja/cuentas/${primera.id}/cobrar`,
            { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: primera.saldoCentavos },
            randomUUID(),
          ),
      ),
    );
    guardar('caja: anular', ok(await k.as(l.o).post(`/v1/caja/cuentas/${segunda.id}/anular`, { motivo: 'prueba' }, randomUUID())));

    // Mesa INVITO_YO: el anfitrión paga lo del invitado (pagadorRef ≠ personaRef).
    const h = await conPlan(l);
    const g = await k.diner();
    const m2 = ok<{ id: string }>(
      await k.as(h).post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo: 'INVITO_YO' }, randomUUID()),
      201,
    );
    guardar('INVITO_YO: unirse', ok(await k.as(g).post(`/v1/mesas/invitacion/${m2.id}/unirse`, {}, randomUUID())));
    guardar('INVITO_YO: selección invitado', ok(await elegir(g, m2.id, { extras: [[l.cola, 1]] })));
    guardar('INVITO_YO: anfitrión', ok(await k.as(h).get(`/v1/mis/mesas/${m2.id}`)));
    guardar('INVITO_YO: invitado', ok(await k.as(g).get(`/v1/mis/mesas/${m2.id}`)));
    guardar('INVITO_YO: caja vista', ok(await k.as(caja).get(`/v1/caja/mesas/${m2.id}`)));
    guardar('INVITO_YO: validar', ok(await k.as(caja).post(`/v1/caja/mesas/${m2.id}/validar`, undefined, randomUUID())));

    const ids = [...(await internos(t.id)).miembros, ...(await internos(m2.id)).miembros];
    expect(ids.length).toBe(5);
    expect(t.respuestas.length).toBeGreaterThan(25);
    for (const r of t.respuestas) sinMiembroIds(r.body, ids, r.nombre);
  });

  it('miembros[].ref = personaRef/pagadorRef; estable entre llamadas y vistas; distinto entre miembros y entre mesas; es el HMAC del spec', async () => {
    const l = await local();
    const t = await mesaCadaUno(l);
    const anfitrion = ok<{ miembros: Miembro[] }>(await k.as(t.a).get(`/v1/mis/mesas/${t.id}`));
    const otraVez = ok<{ miembros: Miembro[] }>(await k.as(t.a).get(`/v1/mis/mesas/${t.id}`));
    const invitado = ok<{ miembros: Miembro[] }>(await k.as(t.b).get(`/v1/mis/mesas/${t.id}`));
    const caja = ok<{ miembros: Miembro[]; cotizacion: Cot }>(await k.as(l.o).get(`/v1/caja/mesas/${t.id}`));
    const refs = anfitrion.miembros.map((m) => m.ref);
    expect(refs).toHaveLength(3); // incluye a C, que salió
    for (const r of refs) expect(r).toMatch(REF);
    expect(new Set(refs).size).toBe(3);
    expect(otraVez.miembros.map((m) => m.ref)).toEqual(refs);
    expect(new Set(invitado.miembros.map((m) => m.ref))).toEqual(new Set(refs));
    expect(new Set(caja.miembros.map((m) => m.ref))).toEqual(new Set(refs));

    // Es exactamente el HMAC del spec con la llave del QR (aquí la de desarrollo: las pruebas no tienen QR_SECRET_KEY).
    const int = await internos(t.id);
    const subclave = subclaveRefs(llaveQr({ QR_SECRET_KEY: process.env.QR_SECRET_KEY }));
    expect(new Set(int.miembros.map((id) => calcularRef(subclave, int.mesa, id)))).toEqual(new Set(refs));

    // CADA_UNO: cada línea es de su miembro y la paga él mismo; el prefijo de cada ref de línea es su ref.
    for (const vista of [anfitrion, caja])
      for (const m of vista.miembros.filter((x) => x.cotizacion)) {
        for (const ln of m.cotizacion!.lineas) {
          expect([ln.personaRef, ln.pagadorRef]).toEqual([m.ref, m.ref]);
          expect(ln.ref.startsWith(`${m.ref}:`)).toBe(true);
        }
        expect(m.cotizacion!.porPagador.map((p) => p.pagadorRef)).toEqual([m.ref]);
      }
    const yo = invitado.miembros.find((m) => m.soyYo)!;
    expect(yo.cotizacion!.lineas.every((ln) => ln.personaRef === yo.ref)).toBe(true);

    // Las cuentas de validar y de /caja/cuentas usan el mismo ref.
    const v = ok<{ cuentas: Cuenta[]; miembros: Miembro[] }>(
      await k.as(l.o).post(`/v1/caja/mesas/${t.id}/validar`, undefined, randomUUID()),
    );
    expect(v.miembros.map((m) => m.ref)).toEqual(caja.miembros.map((m) => m.ref));
    for (const c of v.cuentas) {
      const de = new Set(c.cotizacion.lineas.map((ln) => ln.personaRef));
      expect(de.size).toBe(1);
      expect(refs).toContain([...de][0]);
      expect(c.cotizacion.porPagador.map((p) => p.pagadorRef)).toEqual([...de]);
      expect(ok<Cuenta>(await k.as(l.o).get(`/v1/caja/cuentas/${c.id}`)).cotizacion).toEqual(c.cotizacion);
    }

    // INVITO_YO: el anfitrión paga la Cola del invitado; otra mesa → otros refs.
    const h = await conPlan(l);
    const g = await k.diner();
    const m2 = ok<{ id: string }>(
      await k.as(h).post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo: 'INVITO_YO' }, randomUUID()),
      201,
    );
    ok(await k.as(g).post(`/v1/mesas/invitacion/${m2.id}/unirse`, {}, randomUUID()));
    ok(await elegir(g, m2.id, { extras: [[l.cola, 1]] }));
    const vista2 = ok<{ miembros: Miembro[] }>(await k.as(h).get(`/v1/mis/mesas/${m2.id}`));
    const [refH, refG] = [vista2.miembros.find((m) => m.esAnfitrion)!.ref, vista2.miembros.find((m) => !m.esAnfitrion)!.ref];
    expect(refs).not.toContain(refH);
    expect(refs).not.toContain(refG);
    const cola = vista2.miembros.find((m) => !m.esAnfitrion)!.cotizacion!.lineas[0]!;
    expect([cola.personaRef, cola.pagadorRef]).toEqual([refG, refH]);
    const v2 = ok<{ cuentas: Cuenta[] }>(await k.as(l.o).post(`/v1/caja/mesas/${m2.id}/validar`, undefined, randomUUID()));
    expect(v2.cuentas).toHaveLength(1);
    expect(v2.cuentas[0]!.cotizacion.porPagador.map((p) => p.pagadorRef)).toEqual([refH]);
    // La cuenta del anfitrión lleva su almuerzo (cubierto por el plan) y la Cola del invitado: todo lo paga él.
    expect(v2.cuentas[0]!.cotizacion.lineas.map((ln) => [ln.personaRef, ln.pagadorRef])).toEqual([
      [refH, refH],
      [refG, refH],
    ]);
  });

  it('montos idénticos a los de antes del PR 9 (CADA_UNO con carta y para llevar; INVITO_YO)', async () => {
    const l = await local();
    const t = await mesaCadaUno(l);
    const previa = ok<{ cotizacion: Cot }>(await k.as(l.o).get(`/v1/caja/mesas/${t.id}`));
    // A: almuerzo del plan (P) + Cola (B). B: Churrasco (C) + recargo para llevar (R), sin almuerzo. C salió.
    const esperado = [P + B + C, R, P + B + C + R, P, B + C + R];
    expect(totales(previa.cotizacion)).toEqual(esperado);
    const v = ok<{ cotizacion: Cot; cuentas: Cuenta[]; descontados: number; porCobrar: number }>(
      await k.as(l.o).post(`/v1/caja/mesas/${t.id}/validar`, undefined, randomUUID()),
    );
    expect(totales(v.cotizacion)).toEqual(esperado);
    expect(v).toMatchObject({ descontados: 1, porCobrar: 0 });
    expect(v.cuentas.map((c) => c.saldoCentavos).sort((x, y) => x - y)).toEqual([B, C + R]);

    const h = await conPlan(l);
    const g = await k.diner();
    const m2 = ok<{ id: string }>(
      await k.as(h).post('/v1/mis/mesas', { restaurante: l.o.restaurante, horaLlegada: inMinutes(30), modo: 'INVITO_YO' }, randomUUID()),
      201,
    );
    ok(await k.as(g).post(`/v1/mesas/invitacion/${m2.id}/unirse`, {}, randomUUID()));
    ok(await elegir(g, m2.id, { extras: [[l.cola, 1]] }));
    const v2 = ok<{ cotizacion: Cot; cuentas: Cuenta[] }>(await k.as(l.o).post(`/v1/caja/mesas/${m2.id}/validar`, undefined, randomUUID()));
    // Anfitrión sin selección: 1 almuerzo del plan; la Cola del invitado la paga el anfitrión.
    expect(totales(v2.cotizacion)).toEqual([P + B, 0, P + B, P, B]);
    expect(v2.cuentas.map((c) => c.saldoCentavos)).toEqual([B]);
  });
});
