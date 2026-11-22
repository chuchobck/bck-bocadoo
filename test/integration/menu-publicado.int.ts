import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();

type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;

describe.skipIf(!probe)('Menú publicado: pase y canje en caja', () => {
  const k = new DinerKit(probe!, 101);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  const despublicar = (o: Local) => k.as(o).post('/v1/menu/hoy/despublicar');
  const publicar = (o: Local) => k.as(o).post('/v1/menu/hoy/publicar');
  const codigo = (d: { token: string }, restaurante?: string) =>
    k.as(d).get(`/v1/pase/codigo${restaurante ? `?restaurante=${restaurante}` : ''}`);
  const validar = (o: Local, body: object, key = randomUUID()) => k.as(o).post('/v1/caja/validar', body, key);
  const saldo = async (o: Local, c: string) => (await k.as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const intentos = async (o: Local) =>
    Number(
      (
        await probe!.sql<{ n: string }>(
          `SELECT count(*) AS n FROM intento_escaneo i JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1`,
          [o.restaurante],
        )
      ).rows[0]!.n,
    );
  const noPublicado = { status: 409, code: 'MENU_NO_PUBLICADO' };

  it('GET /v1/pase/codigo con restaurante: con el menú publicado emite; sin publicar → 409 MENU_NO_PUBLICADO (problem+json)', async () => {
    const o = await k.activeOwner();
    await k.menu(o);
    const d = await k.diner();
    expect((await codigo(d, o.restaurante)).statusCode).toBe(200);

    await despublicar(o);
    const r = await codigo(d, o.restaurante);
    expect(r.statusCode).toBe(409);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.json()).toMatchObject(noPublicado);
    // GET /v1/pase?restaurante= emite el mismo código: misma regla.
    expect((await k.as(d).get(`/v1/pase?restaurante=${o.restaurante}`)).json()).toMatchObject(noPublicado);

    await publicar(o);
    expect((await codigo(d, o.restaurante)).statusCode).toBe(200);
    // Un local que no existe sigue siendo 404 (no se confunde con menú sin publicar).
    expect((await codigo(d, randomUUID())).json()).toMatchObject({ status: 404, code: 'RESTAURANTE_NO_ENCONTRADO' });
  });

  it('POST /v1/caja/validar: publicado descuenta; sin publicar → 409, no descuenta ni registra intento; vale por QR y manual', async () => {
    const o = await k.activeOwner();
    await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const qr = async () => (await codigo(d, o.restaurante)).json().codigo as string;

    const ok = await validar(o, { clienteId: d.clienteId });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ descontado: true, platoNombre: null });
    expect(await saldo(o, d.clienteId)).toBe(4);

    const codigoQr = await qr();
    await despublicar(o);
    const antes = await intentos(o);
    for (const body of [{ clienteId: d.clienteId }, { codigoQr }]) {
      const r = await validar(o, body);
      expect(r.statusCode).toBe(409);
      expect(r.headers['content-type']).toContain('application/problem+json');
      expect(r.json()).toMatchObject(noPublicado);
    }
    expect(await saldo(o, d.clienteId)).toBe(4);
    expect(await intentos(o)).toBe(antes);

    await publicar(o);
    // La primera validación fue hace segundos: otra del mismo comensal sería DUPLICADO (ventana de 60 s). Se envejece.
    await k.backdateLunch(ok.json().consumo.id, 2);
    expect((await validar(o, { codigoQr: await qr() }, randomUUID())).json()).toMatchObject({ resultado: 'OK', descontado: true });
  });

  it('un pedido preordenado antes de despublicar SÍ se canjea; un canje directo por QR sin preorden no', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const sinPreorden = await k.dinerWithPlan(o);
    const p = (
      await k
        .as(d)
        .post(
          '/v1/mis/pedidos',
          { restaurante: o.restaurante, almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] } },
          randomUUID(),
        )
    ).json();
    expect(p.estado).toBe('EN_CAMINO');

    await despublicar(o);
    // Sin preorden: bloqueado.
    expect((await validar(o, { clienteId: sinPreorden.clienteId })).json()).toMatchObject(noPublicado);
    // Con preorden: se canjea y el canje trae el nombre del plato.
    const r = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      yaCanjeado: false,
      platoNombre: 'Sopa de quinua + Seco de pollo',
      almuerzo: { resultado: 'OK', descontado: true },
    });
    expect(await saldo(o, d.clienteId)).toBe(4);
    // Repetirlo sigue funcionando y conserva el nombre.
    const again = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
    expect(again.json()).toMatchObject({ yaCanjeado: true, platoNombre: 'Sopa de quinua + Seco de pollo' });
  });

  it('pedido solo con extras: platoNombre es null', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.diner();
    const p = (
      await k.as(d).post('/v1/mis/pedidos', { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }] }, randomUUID())
    ).json();
    const r = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
    expect(r.json()).toMatchObject({ platoNombre: null, almuerzo: null });
  });

  it('aislamiento por tenant: el menú publicado de otro local no habilita el mío, ni al revés', async () => {
    const a = await k.activeOwner();
    const b = await k.activeOwner();
    await k.menu(a);
    await k.menu(b);
    const d = await k.dinerWithPlan(a);
    const e = await k.dinerWithPlan(b);

    await despublicar(a); // b sigue publicado
    expect((await validar(a, { clienteId: d.clienteId })).json()).toMatchObject(noPublicado);
    expect((await validar(b, { clienteId: e.clienteId })).json()).toMatchObject({ descontado: true });
    expect((await codigo(d, a.restaurante)).json()).toMatchObject(noPublicado);
    expect((await codigo(d, b.restaurante)).statusCode).toBe(200);

    // El dueño de A no puede apoyarse en el menú de B enviando el id del otro local: RLS lo trata como un local ajeno.
    const cruzado = await k
      .as({ token: a.token, restaurante: b.restaurante })
      .post('/v1/caja/validar', { clienteId: e.clienteId }, randomUUID());
    expect(cruzado.statusCode).toBeGreaterThanOrEqual(400);
    expect(cruzado.json().code).not.toBe('OK');
    expect(await saldo(b, e.clienteId)).toBe(4);

    // Directo en SQL como bck_api: el menú es de lectura pública (vitrina, política `lectura_publica`), pero la
    // escritura sigue aislada por tenant: desde A no se puede despublicar el menú de B.
    const idDe = async (publicId: string) =>
      String(
        (await probe!.sql<{ id: string }>('SELECT restaurante_id AS id FROM restaurante WHERE public_id = $1', [publicId])).rows[0]!.id,
      );
    const [idA, idB] = [await idDe(a.restaurante), await idDe(b.restaurante)];
    const tocadas = await k.h.db.scope(
      { tenantId: idA },
      async (q) => (await q.query('UPDATE menu_diario_cabecera SET publicado_en = NULL WHERE restaurante_id = $1', [idB])).rowCount,
    );
    expect(tocadas).toBe(0);
    const aun = await probe!.sql<{ n: string }>(
      'SELECT count(*) AS n FROM menu_diario_cabecera WHERE restaurante_id = $1 AND publicado_en IS NOT NULL',
      [idB],
    );
    expect(Number(aun.rows[0]!.n)).toBe(1);
  });

  it('decide por la fecha local del restaurante, no por la del servidor', async () => {
    const o = await k.activeOwner();
    await k.menu(o); // publicado para el "hoy" de la zona actual del local
    const d = await k.dinerWithPlan(o);
    const hoyDe = async (tz: string) =>
      (await probe!.sql<{ d: string }>(`SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS d`, [tz])).rows[0]!.d;
    const actual = (await k.as(o).get('/v1/menu/hoy')).json().fecha as string;
    // Kiritimati (UTC+14) y Pago Pago (UTC-11) van 25 h aparte: al menos una tiene otro "hoy" que el del menú.
    const otra = (await hoyDe('Pacific/Kiritimati')) !== actual ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
    expect(await hoyDe(otra)).not.toBe(actual);

    await probe!.sql(`UPDATE restaurante SET zona_horaria = $2 WHERE public_id = $1`, [o.restaurante, otra]);
    expect((await validar(o, { clienteId: d.clienteId })).json()).toMatchObject(noPublicado);
    expect((await codigo(d, o.restaurante)).json()).toMatchObject(noPublicado);
  });

  it('sin `restaurante` el código no es de un local: se emite igual (la regla se aplica al canjear)', async () => {
    const o = await k.activeOwner();
    const d = await k.dinerWithPlan(o);
    expect((await codigo(d)).statusCode).toBe(200);
    expect((await validar(o, { codigoQr: (await codigo(d)).json().codigo })).json()).toMatchObject(noPublicado);
  });
});
