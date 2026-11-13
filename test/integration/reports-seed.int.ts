import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TokenService } from '../../src/auth/token.service';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';

const probe = Probe.fromEnv();
const SLUG = 'la-cuchara-de-san-blas';
const TZ = 'America/Guayaquil';

/**
 * Las cifras de los reportes contra consultas SQL directas sobre el seed demo ("La Cuchara de San Blas": siete
 * semanas de planes, almuerzos, ventas, cobros, cierres de caja y ofertas). Cada consulta de comprobación está
 * escrita aparte del código de la API, por días o por cliente, y la prueba no escribe nada (corre en una transacción
 * del patrón probe que se deshace).
 */
describe.skipIf(!probe)('Fase 9: las cifras de los reportes cuadran con SQL directo sobre el seed demo', () => {
  const k = new DinerKit(probe!, 101);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  async function demo() {
    const r = await probe!.sql<{
      rid: string;
      public_id: string;
      owner_uid: string;
      owner_pub: string;
      hoy: string;
      desde: string;
      zona: string;
    }>(
      `SELECT r.restaurante_id::text AS rid, r.public_id, u.usuario_id::text AS owner_uid, u.public_id AS owner_pub, r.zona_horaria AS zona,
              (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date::text AS hoy,
              LEAST((SELECT min(fecha_local) FROM consumo_almuerzo WHERE restaurante_id = r.restaurante_id),
                    (SELECT min(fecha_local) FROM venta_pos_cabecera WHERE restaurante_id = r.restaurante_id),
                    (SELECT min(fecha_local) FROM transaccion_pago WHERE restaurante_id = r.restaurante_id),
                    (SELECT min((comprada_en AT TIME ZONE r.zona_horaria)::date) FROM suscripcion_plan WHERE restaurante_id = r.restaurante_id))::text AS desde
         FROM restaurante r JOIN personal_restaurante p ON p.restaurante_id = r.restaurante_id AND p.rol = 'DUENO' JOIN usuario u ON u.usuario_id = p.usuario_id
        WHERE r.slug = $1`,
      [SLUG],
    );
    const d = r.rows[0];
    if (!d) throw new Error(`Falta el seed demo (${SLUG}): cárgalo con db/seeds/demo.sql`);
    expect(d.zona).toBe(TZ);
    const token = await k.h.app.get(TokenService).signAccess({ sub: d.owner_pub, uid: d.owner_uid });
    return { ...d, api: k.as({ token, restaurante: d.public_id }) };
  }
  const q = <T extends Record<string, unknown>>(text: string, params: unknown[]) => probe!.sql<T>(text, params).then((r) => r.rows);
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
      out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };
  const by = <T extends { d: string }>(rows: T[]) => new Map(rows.map((r) => [r.d, r]));

  it('resumen diario: cada día del seed coincide con la suma de sus filas, y el efectivo con el cierre de caja sembrado', async () => {
    const s = await demo();
    const consumos = by(
      await q<{ d: string; n: number; llevar: number }>(
        `SELECT fecha_local::text AS d, COALESCE(sum(cantidad), 0)::int AS n, COALESCE(sum(cantidad) FILTER (WHERE para_llevar), 0)::int AS llevar
         FROM consumo_almuerzo WHERE restaurante_id = $1 GROUP BY 1`,
        [s.rid],
      ),
    );
    const pagos = await q<{ d: string; codigo: string; origen: string; monto: string }>(
      `SELECT p.fecha_local::text AS d, m.codigo, CASE WHEN p.suscripcion_id IS NOT NULL THEN 'planes' WHEN p.venta_pos_id IS NOT NULL THEN 'ventas'
                                                        WHEN p.canje_oferta_id IS NOT NULL THEN 'ofertas' ELSE 'pedidos' END AS origen, sum(p.monto_centavos)::text AS monto
         FROM transaccion_pago p JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
        WHERE p.restaurante_id = $1 AND p.estado = 'CONFIRMADO' GROUP BY 1, 2, 3`,
      [s.rid],
    );
    const pos = by(
      await q<{ d: string; tickets: number; total: string; almuerzos: number }>(
        `SELECT v.fecha_local::text AS d, count(*)::int AS tickets, sum(v.total_centavos)::text AS total,
              (SELECT COALESCE(sum(x.cantidad), 0)::int FROM venta_pos_detalle x JOIN venta_pos_cabecera w ON w.venta_pos_id = x.venta_pos_id
                WHERE w.restaurante_id = $1 AND w.fecha_local = v.fecha_local AND x.es_almuerzo) AS almuerzos
         FROM venta_pos_cabecera v WHERE v.restaurante_id = $1 GROUP BY v.fecha_local`,
        [s.rid],
      ),
    );
    const planes = by(
      await q<{ d: string; n: number; monto: string }>(
        `SELECT (comprada_en AT TIME ZONE $2)::date::text AS d, count(*)::int AS n, sum(precio_pagado_centavos)::text AS monto
         FROM suscripcion_plan WHERE restaurante_id = $1 AND origen = 'VENTA' AND estado <> 'ANULADA' GROUP BY 1`,
        [s.rid, TZ],
      ),
    );
    const escaneos = by(
      await q<{ d: string; total: number; validos: number }>(
        `SELECT (creado_en AT TIME ZONE $2)::date::text AS d, count(*)::int AS total, count(*) FILTER (WHERE resultado::text LIKE 'OK%')::int AS validos
         FROM intento_escaneo WHERE restaurante_id = $1 GROUP BY 1`,
        [s.rid, TZ],
      ),
    );
    const ofertas = by(
      await q<{ d: string; u: number; monto: string }>(
        `SELECT (creado_en AT TIME ZONE $2)::date::text AS d, sum(cantidad)::int AS u, sum(monto_centavos)::text AS monto FROM canje_oferta_flash WHERE restaurante_id = $1 GROUP BY 1`,
        [s.rid, TZ],
      ),
    );
    const cierres = by(
      await q<{ d: string; esperado: string }>(
        `SELECT fecha_local::text AS d, efectivo_esperado_centavos::text AS esperado FROM cierre_caja_cabecera WHERE restaurante_id = $1`,
        [s.rid],
      ),
    );

    const range = days(s.desde, s.hoy);
    expect(range.length).toBeGreaterThan(40); // siete semanas de operación
    let conMovimiento = 0;
    let cierresComparados = 0;
    for (const d of range) {
      const r = (await s.api.get(`/v1/reportes/resumen-diario?fecha=${d}`)).json();
      const pd = pagos.filter((p) => p.d === d);
      const sum = (f: (p: (typeof pd)[number]) => boolean) => pd.filter(f).reduce((a, p) => a + Number(p.monto), 0);
      const exp = {
        servidos: consumos.get(d)?.n ?? 0,
        llevar: consumos.get(d)?.llevar ?? 0,
        total: sum(() => true),
        planes: sum((p) => p.origen === 'planes'),
        ventas: sum((p) => p.origen === 'ventas'),
        ofertas: sum((p) => p.origen === 'ofertas'),
        efectivo: sum((p) => p.codigo === 'EFECTIVO'),
      };
      expect(r.fecha).toBe(d);
      expect(r.almuerzos, d).toMatchObject({ servidos: exp.servidos, paraLlevar: exp.llevar });
      expect(r.ingresos.totalCentavos, d).toBe(exp.total);
      expect(r.ingresos.porOrigen, d).toMatchObject({ planes: exp.planes, ventas: exp.ventas, ofertas: exp.ofertas });
      expect(r.ingresos.porMetodo.find((m: { metodo: string }) => m.metodo === 'EFECTIVO')?.centavos ?? 0, d).toBe(exp.efectivo);
      expect(r.ingresos.pendientesPorConfirmar, d).toEqual({ cantidad: 0, centavos: 0 });
      expect(r.ventasPos, d).toEqual({
        tickets: pos.get(d)?.tickets ?? 0,
        reversos: 0,
        totalCentavos: Number(pos.get(d)?.total ?? 0),
        almuerzos: pos.get(d)?.almuerzos ?? 0,
      });
      expect(r.planesVendidos, d).toEqual({ cantidad: planes.get(d)?.n ?? 0, centavos: Number(planes.get(d)?.monto ?? 0) });
      expect(r.ofertas, d).toEqual({ unidades: ofertas.get(d)?.u ?? 0, centavos: Number(ofertas.get(d)?.monto ?? 0) });
      expect(r.escaneos, d).toEqual({
        total: escaneos.get(d)?.total ?? 0,
        validos: escaneos.get(d)?.validos ?? 0,
        rechazados: (escaneos.get(d)?.total ?? 0) - (escaneos.get(d)?.validos ?? 0),
      });
      if (exp.servidos + exp.total > 0) conMovimiento++;
      // El efectivo del resumen es el "efectivo esperado" que el seed guardó al cerrar la caja de ese día.
      if (cierres.has(d)) {
        expect(exp.efectivo, `cierre ${d}`).toBe(Number(cierres.get(d)!.esperado));
        cierresComparados++;
      }
    }
    expect(conMovimiento).toBeGreaterThan(30);
    expect(cierresComparados).toBe(cierres.size);
    expect(cierresComparados).toBeGreaterThan(30);
  });

  it('zona horaria: una compra de plan a las 23:30 locales del seed cuenta en su día local, no en el día UTC', async () => {
    const s = await demo();
    // Se mueve (dentro de la transacción de prueba, que se deshace) una compra real del seed a las 23:30 de su día local:
    // en UTC ya es el día siguiente.
    const plan = (
      await q<{ id: string; d: string }>(
        `SELECT public_id AS id, (comprada_en AT TIME ZONE $2)::date::text AS d FROM suscripcion_plan
        WHERE restaurante_id = $1 AND origen = 'VENTA' AND estado <> 'ANULADA' ORDER BY suscripcion_id LIMIT 1`,
        [s.rid, TZ],
      )
    )[0]!;
    await probe!.sql(`UPDATE suscripcion_plan SET comprada_en = (DATE '${plan.d}' + TIME '23:30') AT TIME ZONE $2 WHERE public_id = $1`, [
      plan.id,
      TZ,
    ]);
    const conteo = async (dia: string, zona: string) =>
      Number(
        (
          await q<{ n: string }>(
            `SELECT count(*)::text AS n FROM suscripcion_plan WHERE restaurante_id = $1 AND origen = 'VENTA' AND estado <> 'ANULADA' AND (comprada_en AT TIME ZONE $3)::date = $2`,
            [s.rid, dia, zona],
          )
        )[0]!.n,
      );
    const utcSiguiente = (await q<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [plan.d]))[0]!.d;
    expect(
      (
        await q<{ d: string }>(`SELECT (comprada_en AT TIME ZONE 'UTC')::date::text AS d FROM suscripcion_plan WHERE public_id = $1`, [
          plan.id,
        ])
      )[0]!.d,
    ).toBe(utcSiguiente);

    const dia = (await s.api.get(`/v1/reportes/resumen-diario?fecha=${plan.d}`)).json().planesVendidos.cantidad;
    expect(dia).toBe(await conteo(plan.d, TZ));
    expect(dia).not.toBe(await conteo(plan.d, 'UTC')); // agrupar por UTC no lo contaría ese día
    const siguiente = (await s.api.get(`/v1/reportes/resumen-diario?fecha=${utcSiguiente}`)).json().planesVendidos.cantidad;
    expect(siguiente).toBe(await conteo(utcSiguiente, TZ));
    const rango = (await s.api.get(`/v1/reportes/ventas-planes?desde=${plan.d}&hasta=${plan.d}`)).json();
    expect(rango.porDia.map((x: { fecha: string }) => x.fecha)).toEqual([plan.d]);
    expect(rango.total.vendidos).toBe(dia);
  });

  it('ventas de planes: totales, por plan y por día coinciden con SQL sobre todo el rango del seed', async () => {
    const s = await demo();
    const r = (await s.api.get(`/v1/reportes/ventas-planes?desde=${s.desde}&hasta=${s.hoy}`)).json();
    const porPlan = await q<{ nombre: string; vendidos: number; anulados: number; ingreso: string; totales: string; usados: string }>(
      `SELECT nombre_plan AS nombre, count(*) FILTER (WHERE estado <> 'ANULADA')::int AS vendidos, count(*) FILTER (WHERE estado = 'ANULADA')::int AS anulados,
              COALESCE(sum(precio_pagado_centavos) FILTER (WHERE estado <> 'ANULADA'), 0)::text AS ingreso,
              COALESCE(sum(almuerzos_totales) FILTER (WHERE estado <> 'ANULADA'), 0)::text AS totales,
              COALESCE(sum(almuerzos_totales - almuerzos_restantes) FILTER (WHERE estado <> 'ANULADA'), 0)::text AS usados
         FROM suscripcion_plan WHERE restaurante_id = $1 AND origen = 'VENTA' GROUP BY 1 ORDER BY COALESCE(sum(precio_pagado_centavos) FILTER (WHERE estado <> 'ANULADA'), 0) DESC, 1`,
      [s.rid],
    );
    expect(porPlan.length).toBeGreaterThan(1);
    expect(r.porPlan).toEqual(
      porPlan.map((p) => ({
        nombre: p.nombre,
        vendidos: p.vendidos,
        anulados: p.anulados,
        ingresoCentavos: Number(p.ingreso),
        almuerzosVendidos: Number(p.totales),
        almuerzosConsumidos: Number(p.usados),
      })),
    );
    expect(r.total).toEqual({
      vendidos: porPlan.reduce((a, p) => a + p.vendidos, 0),
      anulados: porPlan.reduce((a, p) => a + p.anulados, 0),
      ingresoCentavos: porPlan.reduce((a, p) => a + Number(p.ingreso), 0),
    });
    const porDia = await q<{ fecha: string; vendidos: number; ingresoCentavos: string }>(
      `SELECT (comprada_en AT TIME ZONE $2)::date::text AS fecha, count(*)::int AS vendidos, sum(precio_pagado_centavos)::text AS "ingresoCentavos"
         FROM suscripcion_plan WHERE restaurante_id = $1 AND origen = 'VENTA' AND estado <> 'ANULADA' GROUP BY 1 ORDER BY 1`,
      [s.rid, TZ],
    );
    expect(r.porDia).toEqual(porDia.map((x) => ({ fecha: x.fecha, vendidos: x.vendidos, ingresoCentavos: Number(x.ingresoCentavos) })));
    expect(r.porDia.reduce((a: number, d: { ingresoCentavos: number }) => a + d.ingresoCentavos, 0)).toBe(r.total.ingresoCentavos);
  });

  it('horas pico: coinciden con SQL por hora y con la vista vw_consumo_por_hora del esquema; la suma es la de los resúmenes diarios', async () => {
    const s = await demo();
    const r = (await s.api.get(`/v1/reportes/horas-pico?desde=${s.desde}&hasta=${s.hoy}`)).json();
    const consumo = new Map(
      (
        await q<{ h: number; n: number }>(
          `SELECT extract(hour FROM creado_en AT TIME ZONE $2)::int AS h, count(*)::int AS n FROM consumo_almuerzo WHERE restaurante_id = $1 AND cantidad = 1 GROUP BY 1`,
          [s.rid, TZ],
        )
      ).map((x) => [x.h, x.n]),
    );
    const ventas = new Map(
      (
        await q<{ h: number; n: number }>(
          `SELECT extract(hour FROM creado_en AT TIME ZONE $2)::int AS h, count(*)::int AS n FROM venta_pos_cabecera WHERE restaurante_id = $1 AND revierte_a_venta_pos_id IS NULL GROUP BY 1`,
          [s.rid, TZ],
        )
      ).map((x) => [x.h, x.n]),
    );
    const vista = new Map(
      (
        await q<{ h: number; n: number }>(
          `SELECT hora_local::int AS h, sum(almuerzos)::int AS n FROM vw_consumo_por_hora WHERE restaurante_id = $1 GROUP BY 1`,
          [s.rid],
        )
      ).map((x) => [x.h, x.n]),
    );
    expect(r.porHora).toHaveLength(24);
    for (const h of r.porHora as { hora: number; almuerzos: number; ventas: number; total: number }[]) {
      expect(h.almuerzos, `hora ${h.hora}`).toBe(consumo.get(h.hora) ?? 0);
      expect(h.almuerzos, `vista ${h.hora}`).toBe(vista.get(h.hora) ?? 0);
      expect(h.ventas, `ventas ${h.hora}`).toBe(ventas.get(h.hora) ?? 0);
      expect(h.total).toBe(h.almuerzos + h.ventas);
    }
    const max = Math.max(...r.porHora.map((h: { total: number }) => h.total));
    expect(r.horaPico).toBe(r.porHora.find((h: { total: number }) => h.total === max).hora);
    expect(max).toBeGreaterThan(0);
    // La suma por hora es la suma de los almuerzos de los resúmenes diarios del mismo rango.
    let servidos = 0;
    for (const d of days(s.desde, s.hoy)) servidos += (await s.api.get(`/v1/reportes/resumen-diario?fecha=${d}`)).json().almuerzos.servidos;
    expect(r.totalAlmuerzos).toBe(servidos);
    expect(r.totalAlmuerzos).toBe(
      Number(
        (
          await q<{ n: string }>(`SELECT COALESCE(sum(cantidad), 0)::text AS n FROM consumo_almuerzo WHERE restaurante_id = $1`, [s.rid])
        )[0]!.n,
      ),
    );
  });

  it('almuerzos pendientes: igual que vw_pasivo_almuerzos menos los planes ACTIVA que ya pasaron su último día', async () => {
    const s = await demo();
    const r = (await s.api.get('/v1/reportes/almuerzos-pendientes')).json();
    const vista = (
      await q<{ clientes: string; almuerzos: string; pasivo: string }>(
        `SELECT clientes_con_saldo::text AS clientes, almuerzos_pendientes::text AS almuerzos, pasivo_centavos::text AS pasivo FROM vw_pasivo_almuerzos WHERE restaurante_id = $1`,
        [s.rid],
      )
    )[0]!;
    const vencidos = (
      await q<{ almuerzos: string; pasivo: string }>(
        `SELECT COALESCE(sum(almuerzos_restantes), 0)::text AS almuerzos, COALESCE(sum(almuerzos_restantes * precio_unitario_centavos), 0)::text AS pasivo
         FROM suscripcion_plan WHERE restaurante_id = $1 AND estado = 'ACTIVA' AND vence_el < $2::date`,
        [s.rid, s.hoy],
      )
    )[0]!;
    expect(r.fecha).toBe(s.hoy);
    expect(r.total.almuerzos).toBe(Number(vista.almuerzos) - Number(vencidos.almuerzos));
    expect(r.total.pasivoCentavos).toBe(Number(vista.pasivo) - Number(vencidos.pasivo));
    // Por plan y por bloque de vencimiento suman el total.
    expect(r.porPlan.reduce((a: number, p: { almuerzos: number }) => a + p.almuerzos, 0)).toBe(r.total.almuerzos);
    expect(r.porVencimiento.reduce((a: number, b: { pasivoCentavos: number }) => a + b.pasivoCentavos, 0)).toBe(r.total.pasivoCentavos);
    // Y cada bloque contra SQL con las fronteras de cada rango.
    const bloque = async (a: number, b: number) =>
      (
        await q<{ planes: number; almuerzos: string }>(
          `SELECT count(*)::int AS planes, COALESCE(sum(almuerzos_restantes), 0)::text AS almuerzos FROM suscripcion_plan
          WHERE restaurante_id = $1 AND estado = 'ACTIVA' AND vence_el - $2::date BETWEEN $3 AND $4`,
          [s.rid, s.hoy, a, b],
        )
      )[0]!;
    const esperados = [await bloque(0, 0), await bloque(1, 3), await bloque(4, 7), await bloque(8, 100000)];
    expect(r.porVencimiento.map((b: { planes: number; almuerzos: number }) => ({ planes: b.planes, almuerzos: b.almuerzos }))).toEqual(
      esperados.map((e) => ({ planes: e.planes, almuerzos: Number(e.almuerzos) })),
    );
    expect(r.total.almuerzos).toBeGreaterThan(0);
  });

  it('clientes a quienes escribirles: el mismo conjunto y los mismos motivos que reglas aplicadas cliente por cliente', async () => {
    const s = await demo();
    const filas = await q<{
      id: string;
      nombre: string;
      vence: string | null;
      restantes: string;
      visita: string | null;
      compra: string | null;
    }>(
      `SELECT c.cliente_id::text AS id, c.nombre,
              (SELECT min(p.vence_el)::text FROM suscripcion_plan p WHERE p.cliente_id = c.cliente_id AND p.estado = 'ACTIVA' AND p.almuerzos_restantes > 0 AND p.vence_el >= $2::date) AS vence,
              (SELECT COALESCE(sum(p.almuerzos_restantes), 0)::text FROM suscripcion_plan p WHERE p.cliente_id = c.cliente_id AND p.estado = 'ACTIVA' AND p.almuerzos_restantes > 0 AND p.vence_el >= $2::date) AS restantes,
              (SELECT max(k.fecha_local)::text FROM consumo_almuerzo k WHERE k.cliente_id = c.cliente_id AND k.cantidad = 1
                  AND k.consumo_id NOT IN (SELECT revierte_a_consumo_id FROM consumo_almuerzo WHERE revierte_a_consumo_id IS NOT NULL)) AS visita,
              (SELECT max((p.comprada_en AT TIME ZONE $3)::date)::text FROM suscripcion_plan p WHERE p.cliente_id = c.cliente_id AND p.estado <> 'ANULADA') AS compra
         FROM cliente_restaurante c WHERE c.restaurante_id = $1 AND c.activo`,
      [s.rid, s.hoy, TZ],
    );
    const dias = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
    const esperar = (v: number, sv: number, rn: number) => {
      const out = new Map<string, { motivos: string[]; restantes: number; vence: string | null; visita: string | null; dias: number }>();
      for (const f of filas) {
        if (!f.compra) continue; // nunca compró un plan
        const act = [f.visita, f.compra]
          .filter((x): x is string => !!x)
          .sort()
          .at(-1)!;
        const vigente = f.vence !== null;
        const motivos: string[] = [];
        if (vigente && dias(f.vence!, s.hoy) <= v) motivos.push('POR_VENCER');
        if (vigente && dias(s.hoy, act) >= sv) motivos.push('SIN_VENIR');
        if (!vigente && dias(s.hoy, act) <= rn) motivos.push('PARA_RENOVAR');
        if (motivos.length)
          out.set(f.id, { motivos, restantes: Number(f.restantes), vence: f.vence, visita: f.visita, dias: dias(s.hoy, act) });
      }
      return out;
    };
    for (const [v, sv, rn] of [
      [3, 7, 30],
      [10, 14, 60],
      [1, 3, 1],
    ] as const) {
      const exp = esperar(v, sv, rn);
      const r = (
        await s.api.get(`/v1/reportes/clientes-a-contactar?limit=100&diasVencer=${v}&diasSinVenir=${sv}&diasRenovar=${rn}`)
      ).json();
      expect(r.total, `umbrales ${v}/${sv}/${rn}`).toBe(exp.size);
      expect(new Map(r.items.map((i: { clienteId: string }) => [i.clienteId, i])).size).toBe(exp.size);
      for (const i of r.items as {
        clienteId: string;
        motivos: string[];
        almuerzosRestantes: number;
        venceEl: string | null;
        ultimaVisita: string | null;
        diasSinActividad: number;
      }[]) {
        const e = exp.get(i.clienteId)!;
        expect(e, `cliente ${i.clienteId} no debería aparecer`).toBeDefined();
        expect(i).toMatchObject({
          motivos: e.motivos,
          almuerzosRestantes: e.restantes,
          venceEl: e.vence,
          ultimaVisita: e.visita,
          diasSinActividad: e.dias,
        });
      }
    }
    // Con los umbrales por defecto el seed produce al menos un cliente de cada tipo de aviso útil.
    const base = (await s.api.get('/v1/reportes/clientes-a-contactar?limit=100')).json();
    expect(base.total).toBeGreaterThan(0);
  });

  it('ranking de platos, ofertas y uso de escaneos del seed cuadran con SQL', async () => {
    const s = await demo();
    // Ranking: el seed no registra platos en las ventas sueltas y su único pedido sigue EN_CAMINO (no cuenta). Se canjea
    // ese pedido dentro de la transacción de prueba para que el ranking tenga qué sumar.
    const ventasConPlato = Number(
      (
        await q<{ n: string }>(`SELECT count(*)::text AS n FROM venta_pos_detalle WHERE restaurante_id = $1 AND plato_id IS NOT NULL`, [
          s.rid,
        ])
      )[0]!.n,
    );
    expect(ventasConPlato).toBe(0);
    const pedidos = `SELECT p.public_id AS id, p.nombre, sum(d.cantidad)::int AS u, sum(d.cantidad * d.precio_unitario_centavos)::text AS ing
         FROM orden_detalle d JOIN orden_cabecera o ON o.orden_id = d.orden_id JOIN plato p ON p.plato_id = d.plato_id
        WHERE o.restaurante_id = $1 AND o.estado IN ('CANJEADA', 'SERVIDA') GROUP BY 1, 2 ORDER BY 3 DESC, 2, 1`;
    const ranking = async () =>
      (await s.api.get(`/v1/reportes/ranking-platos?desde=${s.desde}&hasta=${s.hoy}&limit=50`)).json().items as {
        plato: { id: string; nombre: string };
        unidades: number;
        ingresoCentavos: number;
      }[];
    expect(await ranking()).toEqual([]);
    expect(await q(pedidos, [s.rid])).toEqual([]);
    await probe!.sql(`UPDATE orden_cabecera SET estado = 'CANJEADA', canjeada_en = CURRENT_TIMESTAMP WHERE restaurante_id = $1`, [s.rid]);
    const esperado = await q<{ id: string; nombre: string; u: number; ing: string }>(pedidos, [s.rid]);
    expect(esperado.length).toBeGreaterThan(0);
    expect(
      (await ranking()).map((i) => ({ id: i.plato.id, nombre: i.plato.nombre, u: i.unidades, ing: String(i.ingresoCentavos) })),
    ).toEqual(esperado);

    // Ofertas: lo canjeado de cada una es stock_total - stock_restante, y es la suma de sus canjes.
    const ofertas = (await s.api.get('/v1/ofertas?limit=50')).json();
    const filas = await q<{ id: string; total: number; restante: number; canjeadas: string; monto: string; activa: boolean }>(
      `SELECT o.public_id AS id, o.stock_total AS total, o.stock_restante AS restante, COALESCE(sum(c.cantidad), 0)::text AS canjeadas, COALESCE(sum(c.monto_centavos), 0)::text AS monto, o.activa
         FROM oferta_flash o LEFT JOIN canje_oferta_flash c ON c.oferta_flash_id = o.oferta_flash_id WHERE o.restaurante_id = $1 GROUP BY o.oferta_flash_id`,
      [s.rid],
    );
    expect(ofertas.items).toHaveLength(filas.length);
    for (const f of filas) {
      const api = ofertas.items.find((o: { id: string }) => o.id === f.id);
      expect(api).toMatchObject({ stockTotal: f.total, stockRestante: f.restante, canjeadas: Number(f.canjeadas) });
      expect(Number(f.canjeadas)).toBe(f.total - f.restante);
    }
    const resumenes = days(s.desde, s.hoy);
    let unidades = 0;
    let centavos = 0;
    for (const d of resumenes) {
      const o = (await s.api.get(`/v1/reportes/resumen-diario?fecha=${d}`)).json().ofertas;
      unidades += o.unidades;
      centavos += o.centavos;
    }
    expect(unidades).toBe(filas.reduce((a, f) => a + Number(f.canjeadas), 0));
    expect(centavos).toBe(filas.reduce((a, f) => a + Number(f.monto), 0));

    // Uso de escaneos: el contador del ciclo es la cantidad de almuerzos servidos desde su inicio.
    const uso = (await s.api.get('/v1/suscripcion/uso')).json();
    const servidos = Number(
      (
        await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM consumo_almuerzo c WHERE c.restaurante_id = $1 AND c.fecha_local >= $2::date`,
          [s.rid, uso.ciclo.inicio],
        )
      )[0]!.n,
    );
    expect(uso.escaneosUsados).toBe(servidos);
    expect(uso.limite).toBeNull();
    expect(uso.nivel).toBe('ILIMITADO');
  });
});
