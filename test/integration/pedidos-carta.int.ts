import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit, expectOnlyPublicIds } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const P = 350;
const R = 25;

describe.skipIf(!probe)('PR 7a: carta fija en pedidos, recargo por unidad y totales de lo guardado', () => {
  const k = new DinerKit(probe!, 98);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  type Local = Awaited<ReturnType<DinerKit['activeOwner']>>;
  type Persona = { token: string; usuarioId: string; clienteId?: string };

  const pedir = (who: Persona, body: object, key = randomUUID()) => k.as(who).post('/v1/mis/pedidos', body, key);
  const cotizar = (who: Persona, body: object) => k.as(who).post('/v1/mis/pedidos/cotizar', body);

  /** Plato de la carta fija (no está en ningún menú del día). Devuelve su public_id. */
  async function plato(o: Local, categoria: string, nombre: string, precioCentavos: number | null = 600) {
    const r = await k.as(o).post('/v1/menu/platos', { categoria, nombre, ...(precioCentavos === null ? {} : { precioCentavos }) });
    expect(r.statusCode, r.body).toBe(201);
    return { gestion: r.json().id as string, publico: await publicId(o, nombre) };
  }
  /** El `id` del dueño (gestión) no es el public_id que usa el comensal: se lee el de la base. */
  async function publicId(o: Local, nombre: string) {
    const r = await probe!.sql<{ public_id: string }>(
      `SELECT p.public_id FROM plato p JOIN restaurante r ON r.restaurante_id = p.restaurante_id WHERE r.public_id = $1 AND p.nombre = $2`,
      [o.restaurante, nombre],
    );
    return r.rows[0]!.public_id;
  }
  async function carta(o: Local) {
    return {
      chivo: (await plato(o, 'A_LA_CARTA', 'Seco de chivo', 600)).publico,
      cola: (await plato(o, 'BEBIDA', 'Cola carta', 100)).publico,
      huevo: (await plato(o, 'EXTRA', 'Huevo carta', 75)).publico,
    };
  }
  const ordenesDe = async (o: Local) =>
    (
      await probe!.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM orden_cabecera c JOIN restaurante r ON r.restaurante_id = c.restaurante_id WHERE r.public_id = $1`,
        [o.restaurante],
      )
    ).rows[0]!.n;
  const detalle = async (pedidoId: string) =>
    (
      await probe!.sql<{
        nombre_plato: string;
        seccion: string | null;
        cantidad: number;
        precio: string;
        recargo: string;
        es_carta: boolean;
      }>(
        `SELECT d.nombre_plato, d.seccion, d.cantidad, d.precio_unitario_centavos AS precio, d.recargo_unitario_centavos AS recargo, d.es_carta
           FROM orden_detalle d JOIN orden_cabecera o ON o.orden_id = d.orden_id WHERE o.public_id = $1 ORDER BY d.orden_detalle_id`,
        [pedidoId],
      )
    ).rows;

  it('pedido solo de carta sin menú publicado: precios congelados, recargo solo del A_LA_CARTA, total = saldo de la cotización', async () => {
    const o = await k.activeOwner(); // sin menú del día publicado
    const c = await carta(o);
    const d = await k.diner();
    const body = {
      restaurante: o.restaurante,
      paraLlevar: true,
      cartaItems: [
        { platoId: c.chivo, cantidad: 1 },
        { platoId: c.cola, cantidad: 2 },
      ],
    };
    const r = await pedir(d, body);
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json();
    expect(p).toMatchObject({
      almuerzo: null,
      extras: [],
      cartaItems: [
        { id: c.chivo, nombre: 'Seco de chivo', categoria: 'A_LA_CARTA', cantidad: 1, precioUnitarioCentavos: 600, subtotalCentavos: 600 },
        { id: c.cola, nombre: 'Cola carta', categoria: 'BEBIDA', cantidad: 2, precioUnitarioCentavos: 100, subtotalCentavos: 200 },
      ],
      recargoLlevarCentavos: R,
      totalCentavos: 800 + R,
    });
    expectOnlyPublicIds(p);
    expect(p.cotizacion.saldoPorCobrarCentavos).toBe(p.totalCentavos);
    expect(p.cotizacion.recargoCentavos).toBe(p.recargoLlevarCentavos);
    expect(p.cotizacion.lineas).toMatchObject([
      { ref: 'carta:0', tipo: 'A_LA_CARTA', fuente: 'CAJA', platoId: c.chivo, recargoUnitarioCentavos: R },
      { ref: 'carta:1', tipo: 'BEBIDA', fuente: 'CAJA', platoId: c.cola, recargoUnitarioCentavos: 0 },
    ]);
    // Lo guardado: precio al pedir y recargo por unidad (solo el A_LA_CARTA lo paga).
    expect(await detalle(p.id)).toEqual([
      { nombre_plato: 'Seco de chivo', seccion: null, cantidad: 1, precio: '600', recargo: String(R), es_carta: true },
      { nombre_plato: 'Cola carta', seccion: null, cantidad: 2, precio: '100', recargo: '0', es_carta: true },
    ]);
    // La cotización de antes de pedir dice lo mismo.
    const q = await cotizar(d, body);
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ saldoPorCobrarCentavos: p.totalCentavos, recargoCentavos: R });
    // Precio congelado: si la carta sube, el pedido ya hecho conserva su precio.
    await probe!.sql(`UPDATE plato SET precio_centavos = 999 WHERE public_id = $1`, [c.chivo]);
    const again = (await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json();
    expect(again).toEqual(p);
    // Con precio y local en la caja del dueño y del cajero.
    const cajero = await k.h.cashier(o.restaurante);
    for (const who of [o, cajero]) {
      const v = (await k.as(who).get(`/v1/caja/pedidos/${p.id}`)).json();
      expect(v.cartaItems).toEqual(p.cartaItems);
      expect(v.cotizacion.lineas).toEqual(p.cotizacion.lineas);
    }
  });

  it('almuerzo con plan + A_LA_CARTA para llevar: cada unidad paga su recargo y totalCentavos = saldo de la cotización', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const c = await carta(o);
    const d = await k.dinerWithPlan(o);
    const body = {
      restaurante: o.restaurante,
      paraLlevar: true,
      almuerzo: { platos: [m['Sopa de quinua'], m['Seco de pollo']] },
      extras: [{ plato: m.Cola, cantidad: 1 }],
      cartaItems: [{ platoId: c.chivo, cantidad: 2 }],
    };
    const q = (await cotizar(d, body)).json();
    const r = await pedir(d, body);
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json();
    // Plan cubre el almuerzo (0); cola 100 (BEBIDA, sin recargo); chivo 2 × 600 con recargo; más el del almuerzo.
    expect(p).toMatchObject({
      almuerzo: { precioCentavos: 0, cubiertoPorPlan: true },
      extras: [{ nombre: 'Cola', subtotalCentavos: 100 }],
      cartaItems: [{ nombre: 'Seco de chivo', cantidad: 2, subtotalCentavos: 1200 }],
      recargoLlevarCentavos: 3 * R, // almuerzo + 2 chivos
      totalCentavos: 100 + 1200 + 3 * R,
    });
    expect(p.cotizacion).toMatchObject({
      recargoCentavos: 3 * R,
      cubiertoPorPlanCentavos: P,
      saldoPorCobrarCentavos: p.totalCentavos,
    });
    expect(q).toMatchObject({ saldoPorCobrarCentavos: p.totalCentavos, recargoCentavos: p.recargoLlevarCentavos });
    // Lo guardado: el recargo del almuerzo va una sola vez (en su primer plato); el de los extras no se duplica.
    const det = await detalle(p.id);
    expect(det.filter((x) => x.seccion !== null).map((x) => x.recargo)).toEqual([String(R), '0']);
    expect(det.filter((x) => x.seccion === null).map((x) => [x.nombre_plato, x.recargo, x.es_carta])).toEqual([
      ['Cola', '0', false],
      ['Seco de chivo', String(R), true],
    ]);
    const sumaRecargo = det.reduce((s, x) => s + x.cantidad * Number(x.recargo), 0);
    expect(sumaRecargo).toBe(p.recargoLlevarCentavos);
    // Sin llevar no hay recargo en ninguna línea.
    await k.as(d).post(`/v1/mis/pedidos/${p.id}/cancelar`);
    const sin = (await pedir(d, { ...body, paraLlevar: false })).json();
    expect(sin).toMatchObject({ recargoLlevarCentavos: 0, totalCentavos: 1300 });
    expect((await detalle(sin.id)).every((x) => x.recargo === '0')).toBe(true);
  });

  it('un extra y un plato de carta pueden ser el mismo plato; los duplicados son renglones aparte; el tope combinado es 10', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const c = await carta(o);
    const d = await k.diner();
    // Mismo plato dos veces en cartaItems y a la vez en extras (menú) y en carta: tres renglones.
    const hoyEnMenuYCarta = m.Cola!; // Cola del menú
    const r = await pedir(d, {
      restaurante: o.restaurante,
      extras: [{ plato: hoyEnMenuYCarta, cantidad: 1 }],
      cartaItems: [
        { platoId: c.cola, cantidad: 1 },
        { platoId: c.cola, cantidad: 2 },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({
      extras: [{ cantidad: 1 }],
      cartaItems: [{ cantidad: 1 }, { cantidad: 2 }],
      totalCentavos: 100 + 100 + 200,
    });
    expect(r.json().cotizacion.lineas.map((l: { ref: string }) => l.ref)).toEqual(['extra:0', 'carta:0', 'carta:1']);

    const d2 = await k.diner();
    const item = { platoId: c.cola, cantidad: 1 };
    const diez = Array.from({ length: 10 }, () => item);
    expect((await pedir(d2, { restaurante: o.restaurante, cartaItems: diez })).statusCode).toBe(201);
    const d3 = await k.diner();
    const once = await pedir(d3, { restaurante: o.restaurante, cartaItems: [...diez, item] });
    expect(once.statusCode).toBe(400);
    expect(once.json().code).toBe('BAD_REQUEST'); // tope de la propia lista
    const combinado = await pedir(d3, {
      restaurante: o.restaurante,
      extras: [{ plato: m.Cola, cantidad: 1 }],
      cartaItems: diez,
    });
    expect(combinado.statusCode).toBe(400);
    expect(combinado.json().code).toBe('PEDIDO_DEMASIADOS_ITEMS');
    expect(
      (await cotizar(d3, { restaurante: o.restaurante, extras: [{ plato: m.Cola, cantidad: 1 }], cartaItems: diez })).json().code,
    ).toBe('PEDIDO_DEMASIADOS_ITEMS');
  });

  it('validaciones de la carta: agotado 409; inexistente, de otro local, inactivo o de ALMUERZO 422; cantidad y formato 400; vacío 400', async () => {
    const o = await k.activeOwner();
    const otro = await k.activeOwner();
    const c = await carta(o);
    const ajeno = (await plato(otro, 'A_LA_CARTA', 'Ajeno', 500)).publico;
    const almuerzo = (await plato(o, 'ALMUERZO', 'Sopa del día', null)).publico;
    const inact = await plato(o, 'BEBIDA', 'Inactiva', 100);
    const inactivo = inact.publico;
    expect((await k.as(o).patch(`/v1/menu/platos/${inact.gestion}`, { activo: false })).statusCode).toBe(200);
    const d = await k.diner();
    const con = (platoId: string, cantidad = 1) => ({ restaurante: o.restaurante, cartaItems: [{ platoId, cantidad }] });

    for (const [id, nombre] of [
      [randomUUID(), 'no existe'],
      [ajeno, 'otro local'],
      [inactivo, 'inactivo'],
      [almuerzo, 'categoría ALMUERZO'],
    ] as const) {
      for (const llamada of [pedir, cotizar]) {
        const x = await llamada(d, con(id));
        expect(x.statusCode, nombre).toBe(422);
        expect(x.json().code, nombre).toBe('PLATO_NO_DISPONIBLE');
      }
    }
    await probe!.sql(`UPDATE plato SET agotado_en = CURRENT_TIMESTAMP WHERE public_id = $1`, [c.chivo]);
    for (const llamada of [pedir, cotizar]) {
      const x = await llamada(d, con(c.chivo));
      expect(x.statusCode).toBe(409);
      expect(x.json().code).toBe('PLATO_AGOTADO');
    }
    // Entradas mal formadas: la whitelist y los límites responden 400.
    for (const mala of [
      con(c.cola, 0),
      con(c.cola, 11),
      con(c.cola, 1.5),
      con('no-es-uuid'),
      { restaurante: o.restaurante, cartaItems: [{ platoId: c.cola, cantidad: 1, precio: 1 }] },
      { restaurante: o.restaurante, cartaItems: 'x' },
    ]) {
      const x = await pedir(d, mala);
      expect(x.statusCode, JSON.stringify(mala)).toBe(400);
      expect(x.json().code).toBe('BAD_REQUEST');
    }
    for (const vacio of [{ restaurante: o.restaurante }, { restaurante: o.restaurante, cartaItems: [] }]) {
      expect((await pedir(d, vacio)).json()).toMatchObject({ status: 400, code: 'PEDIDO_VACIO' });
    }
    // No quedó ningún pedido de estos intentos (nada se guardó a medias).
    expect(await ordenesDe(o)).toBe(0);
  });

  it('el menú del día solo se exige con almuerzo o extras: carta + almuerzo o carta + extras sin menú → 409 MENU_NO_PUBLICADO', async () => {
    const o = await k.activeOwner(); // sin publicar el menú
    const c = await carta(o);
    const d = await k.diner();
    const cartaItems = [{ platoId: c.cola, cantidad: 1 }];
    expect((await cotizar(d, { restaurante: o.restaurante, cartaItems })).statusCode).toBe(200);
    for (const extra of [{ almuerzo: { platos: [randomUUID()] } }, { extras: [{ plato: randomUUID(), cantidad: 1 }] }]) {
      const x = await pedir(d, { restaurante: o.restaurante, cartaItems, ...extra });
      expect(x.statusCode).toBe(409);
      expect(x.json().code).toBe('MENU_NO_PUBLICADO');
    }
    expect((await pedir(d, { restaurante: o.restaurante, cartaItems })).statusCode).toBe(201);
  });

  describe('canje en caja', () => {
    it('pedido solo de carta: no toca el plan, abre la cuenta ABIERTA con el saldo y se cobra por cuentas; servir funciona', async () => {
      const o = await k.activeOwner();
      const c = await carta(o);
      const d = await k.dinerWithPlan(o);
      const p = (
        await pedir(d, {
          restaurante: o.restaurante,
          paraLlevar: true,
          cartaItems: [
            { platoId: c.chivo, cantidad: 1 },
            { platoId: c.cola, cantidad: 1 },
          ],
        })
      ).json();
      expect(p.totalCentavos).toBe(700 + R);
      const antes = (await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles;
      const r = await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID());
      expect(r.statusCode, r.body).toBe(200);
      const x = r.json();
      expect(x).toMatchObject({
        yaCanjeado: false,
        platoNombre: null,
        almuerzo: null,
        porCobrarCentavos: 700 + R,
        pedido: { estado: 'CANJEADA', cartaItems: [{ nombre: 'Seco de chivo' }, { nombre: 'Cola carta' }] },
        cotizacion: { estimada: false, saldoPorCobrarCentavos: 700 + R, cubiertoPorPlanCentavos: 0 },
        cuenta: { estado: 'ABIERTA' },
      });
      expect((await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles).toBe(antes); // el plan no se toca
      expect((await probe!.sql('SELECT count(*)::int AS n FROM consumo_almuerzo WHERE cliente_id = $1', [d.clienteId])).rows[0]).toEqual({
        n: 0,
      });
      const cobro = await k
        .as(o)
        .post(`/v1/caja/cuentas/${x.cuenta.id}/cobrar`, { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 700 + R }, randomUUID());
      expect(cobro.statusCode, cobro.body).toBe(200);
      expect(cobro.json()).toMatchObject({ estado: 'COBRADA' });
      expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/servir`)).json()).toMatchObject({ estado: 'SERVIDA' });
      // Repetir el canje es idempotente: la misma cuenta, nada que descontar.
      expect((await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).json()).toMatchObject({
        yaCanjeado: true,
        almuerzo: null,
        porCobrarCentavos: 700 + R, // el saldo de la cotización de la cuenta, como siempre (no lo pendiente)
        cuenta: { id: x.cuenta.id },
      });
    });

    it('almuerzo + carta: el plan solo cubre el almuerzo; el resto (carta, recargos) queda en la cuenta', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const c = await carta(o);
      const d = await k.dinerWithPlan(o);
      const p = (
        await pedir(d, {
          restaurante: o.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [m['Seco de pollo']] },
          cartaItems: [{ platoId: c.chivo, cantidad: 1 }],
        })
      ).json();
      expect(p.totalCentavos).toBe(600 + 2 * R);
      const antes = (await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles;
      const x = (await k.as(o).post(`/v1/caja/pedidos/${p.id}/canjear`, {}, randomUUID())).json();
      expect(x).toMatchObject({
        almuerzo: { resultado: 'OK', descontado: true },
        porCobrarCentavos: 600 + 2 * R,
        cotizacion: { estimada: false, cubiertoPorPlanCentavos: P, saldoPorCobrarCentavos: 600 + 2 * R },
        cuenta: { estado: 'ABIERTA' },
      });
      expect((await k.as(o).get(`/v1/clientes/${d.clienteId}`)).json().almuerzosDisponibles).toBe(antes - 1); // una sola unidad
      // El canje con `cobro` y el saldo guardado como referencia: sin SALDO_CAMBIO.
      const o2 = await k.activeOwner();
      const m2 = await k.menu(o2);
      const c2 = await carta(o2);
      const d2 = await k.dinerWithPlan(o2);
      const p2 = (
        await pedir(d2, {
          restaurante: o2.restaurante,
          paraLlevar: true,
          almuerzo: { platos: [m2['Seco de pollo']] },
          cartaItems: [{ platoId: c2.chivo, cantidad: 1 }],
        })
      ).json();
      const pago = await k
        .as(o2)
        .post(`/v1/caja/pedidos/${p2.id}/canjear`, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 600 + 2 * R } }, randomUUID());
      expect(pago.statusCode, pago.body).toBe(200);
      expect(pago.json().cuenta).toMatchObject({ estado: 'COBRADA' });
    });

    it('el recargo guardado se respeta aunque el local lo cambie después: el canje no dispara SALDO_CAMBIO', async () => {
      const o = await k.activeOwner();
      const c = await carta(o);
      const d = await k.diner();
      const p = (await pedir(d, { restaurante: o.restaurante, paraLlevar: true, cartaItems: [{ platoId: c.chivo, cantidad: 2 }] })).json();
      expect(p).toMatchObject({ recargoLlevarCentavos: 2 * R, totalCentavos: 1200 + 2 * R });
      await probe!.sql(`UPDATE restaurante SET recargo_para_llevar_centavos = 100 WHERE public_id = $1`, [o.restaurante]);
      const vista = (await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json();
      expect(vista.cotizacion.recargoCentavos).toBe(2 * R);
      const x = await k
        .as(o)
        .post(`/v1/caja/pedidos/${p.id}/canjear`, { cobro: { metodoPago: 'EFECTIVO', saldoEsperadoCentavos: 1200 + 2 * R } }, randomUUID());
      expect(x.statusCode, x.body).toBe(200);
      expect(x.json().cuenta.cotizacion.saldoPorCobrarCentavos).toBe(1200 + 2 * R);
    });
  });

  it('pedidos anteriores (sin recargo por unidad ni es_carta) se leen con la regla vieja y no se reescriben', async () => {
    const o = await k.activeOwner();
    const m = await k.menu(o);
    const d = await k.dinerWithPlan(o);
    const p = (
      await pedir(d, {
        restaurante: o.restaurante,
        paraLlevar: true,
        almuerzo: { platos: [m['Seco de pollo']] },
        extras: [{ plato: m['Huevo frito'], cantidad: 2 }],
      })
    ).json();
    // Se deja como lo escribía el código anterior: sin snapshot de P y sin recargo por unidad.
    await probe!.sql(
      `UPDATE orden_detalle SET recargo_unitario_centavos = 0 WHERE orden_id = (SELECT orden_id FROM orden_cabecera WHERE public_id = $1)`,
      [p.id],
    );
    await probe!.sql(`UPDATE orden_cabecera SET precio_almuerzo_centavos = NULL WHERE public_id = $1`, [p.id]);
    const vista = (await k.as(d).get(`/v1/mis/pedidos/${p.id}`)).json();
    expect(vista).toMatchObject({
      cartaItems: [],
      extras: [{ cantidad: 2, subtotalCentavos: 150 }],
      almuerzo: { precioCentavos: 0, cubiertoPorPlan: true },
      recargoLlevarCentavos: R,
      totalCentavos: 150 + R,
    });
    expect(vista.cotizacion.recargoCentavos).toBe(R); // R del local de hoy, como antes
    expect((await detalle(p.id)).map((x) => x.recargo)).toEqual(['0', '0']); // no se reescribió nada
  });

  describe('ALMUERZO_SIN_PRECIO y PEDIDO_ACTIVO', () => {
    it('local con P = 0 y sin plan: 409 ALMUERZO_SIN_PRECIO en crear y en cotizar; con plan que cubre sí se pide; sin almuerzo no importa', async () => {
      const o = await k.activeOwner();
      const m = await k.menu(o);
      const c = await carta(o);
      // El PATCH bloquea P = 0 en un local ACTIVO (I-12): en la prueba se fija por SQL.
      await probe!.sql(`UPDATE restaurante SET precio_suelto_centavos = 0 WHERE public_id = $1`, [o.restaurante]);
      const sinPlan = await k.diner();
      const body = { restaurante: o.restaurante, almuerzo: { platos: [m['Seco de pollo']] } };
      for (const llamada of [pedir, cotizar]) {
        const x = await llamada(sinPlan, body);
        expect(x.statusCode, x.body).toBe(409);
        expect(x.json().code).toBe('ALMUERZO_SIN_PRECIO');
      }
      expect(await ordenesDe(o)).toBe(0); // no guardó el pedido en 0
      // Sin almuerzo, P no se usa.
      expect((await pedir(sinPlan, { restaurante: o.restaurante, cartaItems: [{ platoId: c.cola, cantidad: 1 }] })).statusCode).toBe(201);
      // Con un plan que lo cubre, sí.
      const conPlan = await k.dinerWithPlan(o);
      expect((await cotizar(conPlan, body)).statusCode).toBe(200);
      const ok = await pedir(conPlan, body);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toMatchObject({ almuerzo: { cubiertoPorPlan: true }, totalCentavos: 0 });
    });

    it('cotizar no responde PEDIDO_ACTIVO; crear sí', async () => {
      const o = await k.activeOwner();
      const c = await carta(o);
      const d = await k.diner();
      const body = { restaurante: o.restaurante, cartaItems: [{ platoId: c.cola, cantidad: 1 }] };
      expect((await pedir(d, body)).statusCode).toBe(201);
      const q = await cotizar(d, body);
      expect(q.statusCode, q.body).toBe(200);
      expect(q.json().saldoPorCobrarCentavos).toBe(100);
      const otra = await pedir(d, body);
      expect(otra.statusCode).toBe(409);
      expect(otra.json().code).toBe('PEDIDO_ACTIVO');
    });
  });
});
