import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DinerKit } from './diner-kit';
import { Probe } from './probe';
import { addDays, clientWithPlan, localToday, planTemplate } from './reports-kit';

const probe = Probe.fromEnv();

describe.skipIf(!probe)('Fase 9: suscripción SaaS y uso de escaneos', () => {
  const k = new DinerKit(probe!, 97);
  beforeAll(() => k.start());
  afterAll(() => k.stop());
  beforeEach(() => probe!.begin());
  afterEach(() => probe!.rollback());

  /** Asigna un plan SaaS al local con SQL directo (la API solo lee la suscripción). Devuelve las fechas del ciclo. */
  async function subscribe(
    restaurante: string,
    o: { codigo: string; limite: number | null; estado: string; precio: number; usados?: number; finDias?: number },
  ) {
    const plan = await probe!.sql<{ plan_saas_id: string }>(
      `INSERT INTO catalogo_plan_saas (codigo, nombre, limite_escaneos_mes, permite_mesa_grupal, permite_reportes_avanzados, tasa_comision_oferta_flash)
       VALUES ($1, $2, $3, true, true, 7) ON CONFLICT (codigo) DO UPDATE SET limite_escaneos_mes = EXCLUDED.limite_escaneos_mes RETURNING plan_saas_id`,
      [o.codigo, `Plan ${o.codigo}`, o.limite],
    );
    const id = plan.rows[0]!.plan_saas_id;
    await probe!.sql(
      `INSERT INTO plan_saas_precio (plan_saas_id, pais_codigo, moneda_codigo, precio_mensual_centavos) VALUES ($1, 'EC', 'USD', $2) ON CONFLICT DO NOTHING`,
      [id, o.precio],
    );
    await probe!.sql(
      `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, escaneos_usados_ciclo_actual, inicio_ciclo_actual, fin_ciclo_actual, proximo_cobro)
       SELECT r.restaurante_id, $2, $3::estado_suscripcion_saas_enum, $4,
              (CURRENT_DATE - 10), CURRENT_DATE + $5::int, CASE WHEN $6 > 0 THEN CURRENT_DATE + $5::int END
         FROM restaurante r WHERE r.public_id = $1`,
      [restaurante, id, o.estado, o.usados ?? 0, o.finDias ?? 20, o.precio],
    );
  }

  it('un local sin plan SaaS asignado: SIN_SUSCRIPCION y sin límite', async () => {
    const o = await k.owner();
    expect((await k.as(o).get('/v1/suscripcion')).json()).toEqual({
      estado: 'SIN_SUSCRIPCION',
      plan: null,
      ciclo: null,
      proximoCobro: null,
      limites: { escaneosMes: null, mesaGrupal: false, reportesAvanzados: false },
    });
    expect((await k.as(o).get('/v1/suscripcion/uso')).json()).toEqual({
      ciclo: null,
      escaneosUsados: 0,
      limite: null,
      restantes: null,
      porcentaje: null,
      nivel: 'ILIMITADO',
      rechazadosPorLimite: 0,
    });
  });

  it('plan gratuito sin tope: estado, precio, ciclo y límites; el uso sale ILIMITADO', async () => {
    const o = await k.owner();
    const hoy = await localToday(k, o);
    await subscribe(o.restaurante, { codigo: 'GRATIS_T', limite: null, estado: 'FREEMIUM', precio: 0, usados: 12 });
    const r = (await k.as(o).get('/v1/suscripcion')).json();
    expect(r).toEqual({
      estado: 'FREEMIUM',
      plan: { codigo: 'GRATIS_T', nombre: 'Plan GRATIS_T', precioMensualCentavos: 0, moneda: 'USD' },
      ciclo: { inicio: addDays(hoy, -10), fin: addDays(hoy, 20), diasRestantes: 20, vencido: false },
      proximoCobro: null,
      limites: { escaneosMes: null, mesaGrupal: true, reportesAvanzados: true },
    });
    expect((await k.as(o).get('/v1/suscripcion/uso')).json()).toMatchObject({
      escaneosUsados: 12,
      limite: null,
      restantes: null,
      porcentaje: null,
      nivel: 'ILIMITADO',
    });
  });

  it('plan con tope: el uso sube con cada escaneo válido, avisa al 80 %, y al tope la caja responde LIMITE_SAAS', async () => {
    const o = await k.activeOwner();
    const plan = await planTemplate(k, o, 'Semanal', 5, 1500);
    await subscribe(o.restaurante, { codigo: 'PRO_T', limite: 5, estado: 'ACTIVA_PRO', precio: 2900 });
    expect((await k.as(o).get('/v1/suscripcion')).json()).toMatchObject({
      estado: 'ACTIVA_PRO',
      plan: { precioMensualCentavos: 2900 },
      limites: { escaneosMes: 5 },
    });
    const uso = async () => (await k.as(o).get('/v1/suscripcion/uso')).json();
    expect(await uso()).toMatchObject({ escaneosUsados: 0, limite: 5, restantes: 5, porcentaje: 0, nivel: 'NORMAL' });

    const clientes: string[] = [];
    for (let i = 0; i < 6; i++) clientes.push((await clientWithPlan(k, o, plan)).clienteId);
    const scan = async (i: number) => (await k.as(o).post('/v1/caja/validar', { clienteId: clientes[i] }, crypto.randomUUID())).json();
    for (let i = 0; i < 3; i++) expect((await scan(i)).descontado).toBe(true);
    expect(await uso()).toMatchObject({ escaneosUsados: 3, restantes: 2, porcentaje: 60, nivel: 'NORMAL' });
    expect((await scan(3)).descontado).toBe(true);
    expect(await uso()).toMatchObject({ escaneosUsados: 4, restantes: 1, porcentaje: 80, nivel: 'CERCA_DEL_LIMITE' });
    expect((await scan(4)).descontado).toBe(true);
    expect(await uso()).toMatchObject({
      escaneosUsados: 5,
      restantes: 0,
      porcentaje: 100,
      nivel: 'LIMITE_ALCANZADO',
      rechazadosPorLimite: 0,
    });
    const tope = await scan(5);
    expect(tope).toMatchObject({ resultado: 'LIMITE_SAAS', descontado: false });
    expect(await uso()).toMatchObject({ escaneosUsados: 5, nivel: 'LIMITE_ALCANZADO', rechazadosPorLimite: 1 });
  });

  it('un ciclo ya terminado se marca vencido; el cajero ve el uso pero no la suscripción; un comensal, nada', async () => {
    const o = await k.owner();
    const cajero = await k.h.cashier(o.restaurante);
    const d = await k.diner();
    await subscribe(o.restaurante, { codigo: 'PRO_T', limite: 100, estado: 'MOROSA', precio: 2900, finDias: -3 });
    const s = (await k.as(o).get('/v1/suscripcion')).json();
    expect(s.estado).toBe('MOROSA');
    expect(s.ciclo).toMatchObject({ diasRestantes: 0, vencido: true });
    expect((await k.as(cajero).get('/v1/suscripcion/uso')).statusCode).toBe(200);
    expect((await k.as(cajero).get('/v1/suscripcion')).statusCode).toBe(403);
    for (const url of ['/v1/suscripcion', '/v1/suscripcion/uso']) {
      expect((await k.as({ token: d.token, restaurante: o.restaurante }).get(url)).statusCode, url).toBe(403);
      expect((await k.as({}).get(url)).statusCode, url).toBe(401);
    }
  });

  it('cada local ve solo su suscripción; la API no puede escribirla (la maneja el rol de servicio)', async () => {
    const a = await k.owner();
    const b = await k.owner();
    await subscribe(a.restaurante, { codigo: 'PRO_T', limite: 100, estado: 'ACTIVA_PRO', precio: 2900 });
    expect((await k.as(a).get('/v1/suscripcion')).json().estado).toBe('ACTIVA_PRO');
    expect((await k.as(b).get('/v1/suscripcion')).json().estado).toBe('SIN_SUSCRIPCION');
    const rid = String(
      (await probe!.sql<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [a.restaurante]))
        .rows[0]!.restaurante_id,
    );
    // Sin política de escritura para bck_api: el UPDATE no toca ninguna fila y el INSERT lo rechaza RLS.
    const tocadas = await k.h.db.scope(
      { tenantId: rid },
      async (q) => (await q.query('UPDATE suscripcion_saas_restaurante SET escaneos_usados_ciclo_actual = 99')).rowCount,
    );
    expect(tocadas).toBe(0);
    await expect(
      k.h.db.scope({ tenantId: rid }, (q) =>
        q.query(
          `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, fin_ciclo_actual, vigente)
           SELECT restaurante_id, plan_saas_id, 'ACTIVA_PRO', CURRENT_DATE + 30, false FROM suscripcion_saas_restaurante`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await k.as(a).get('/v1/suscripcion/uso')).json().escaneosUsados).toBe(0);
  });

  it('modelo SaaS: ninguna respuesta de la suscripción lleva un campo de comisión', async () => {
    const o = await k.owner();
    await subscribe(o.restaurante, { codigo: 'PRO_T', limite: 100, estado: 'ACTIVA_PRO', precio: 2900 });
    for (const url of ['/v1/suscripcion', '/v1/suscripcion/uso']) {
      const body = (await k.as(o).get(url)).body;
      expect(body, url).not.toMatch(/comisi|commission|tasa/i);
    }
  });
});
