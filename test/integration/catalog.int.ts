import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Actor, Harness, unique } from './harness';

describe('Vitrina pública: búsqueda, detalle, menú de hoy, planes y ocupación', () => {
  const h = new Harness(73);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const own = (who: Actor) => ({
    patch: (url: string, payload?: object) => h.call('PATCH', url, { token: who.token, restaurante: who.restaurante, payload }),
    put: (url: string, payload?: object) => h.call('PUT', url, { token: who.token, restaurante: who.restaurante, payload }),
    post: (url: string, payload?: object) => h.call('POST', url, { token: who.token, restaurante: who.restaurante, payload }),
  });
  const pub = (url: string) => h.call('GET', url); // sin token ni encabezado de restaurante

  /** Dueño con local ya ACTIVO (precio, horario todo el día y zona). */
  async function activeLocal(nombre: string, extra: object = {}) {
    const o = await h.owner(nombre);
    await own(o).patch('/v1/restaurante', { precioSueltoCentavos: 350, zonaId: 1, puestos: 10, ...extra });
    await own(o).put('/v1/restaurante/horarios', {
      horarios: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ diaSemana: d, abre: '00:00', cierra: '23:59' })),
    });
    const act = await own(o).post('/v1/restaurante/activar');
    expect(act.statusCode).toBe(200);
    return { ...o, slug: act.json().slug as string };
  }

  it('es público: no pide token y solo muestra restaurantes ACTIVOS', async () => {
    const tag = unique();
    const a = await activeLocal(`Vitrina ${tag} Activo`);
    const borrador = await h.owner(`Vitrina ${tag} Borrador`);
    const pausado = await activeLocal(`Vitrina ${tag} Pausado`);
    await own(pausado).post('/v1/restaurante/pausar');
    const res = await pub(`/v1/restaurantes?q=${encodeURIComponent(`Vitrina ${tag}`)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { nombre: string }) => i.nombre)).toEqual([`Vitrina ${tag} Activo`]);
    expect((await pub(`/v1/restaurantes/${a.slug}`)).statusCode).toBe(200);
    expect((await pub('/v1/restaurantes/no-existe')).statusCode).toBe(404);
    expect((await pub('/v1/restaurantes/' + 'x'.repeat(90))).statusCode).toBe(404);
    expect((await pub('/v1/restaurantes/Mal_Slug!')).statusCode).toBe(404);
    // Borrador y pausado: ni en la búsqueda ni por slug.
    const slugBorrador = (await h.call('GET', '/v1/restaurante', { token: borrador.token, restaurante: borrador.restaurante })).json().slug;
    const slugPausado = (await h.call('GET', '/v1/restaurante', { token: pausado.token, restaurante: pausado.restaurante })).json().slug;
    expect((await pub(`/v1/restaurantes/${slugBorrador}`)).statusCode).toBe(404);
    expect((await pub(`/v1/restaurantes/${slugPausado}`)).statusCode).toBe(404);
  });

  it('solo expone datos públicos: sin ids internos, correos ni datos del dueño', async () => {
    const tag = unique();
    const o = await activeLocal(`Vitrina ${tag} Datos`);
    const list = await pub(`/v1/restaurantes?q=${tag}`);
    const detail = await pub(`/v1/restaurantes/${o.slug}`);
    for (const body of [list.body, detail.body]) {
      expect(body).not.toContain(o.correo);
      expect(body).not.toMatch(/restaurante_id|usuario_id|password|token|personal/i);
    }
    expect(list.json().items[0]).toMatchObject({
      id: o.restaurante,
      slug: o.slug,
      precioSueltoCentavos: 350,
      monedaCodigo: 'USD',
      zona: { id: 1, nombre: 'Frente a la PUCE' },
    });
  });

  it('paginación por cursor: páginas de 2, sin repetir ni saltar; máximo 50', async () => {
    const tag = unique();
    for (const n of [1, 2, 3, 4, 5]) await activeLocal(`Pagina ${tag} ${n}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await pub(`/v1/restaurantes?q=${tag}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((i: { nombre: string }) => i.nombre));
      cursor = res.json().nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => `Pagina ${tag} ${n}`));
    expect((await pub('/v1/restaurantes?limit=51')).statusCode).toBe(400);
    expect((await pub('/v1/restaurantes?limit=0')).statusCode).toBe(400);
    expect((await pub('/v1/restaurantes?limit=abc')).statusCode).toBe(400);
    expect((await pub('/v1/restaurantes?cursor=basura')).statusCode).toBe(400);
    expect((await pub('/v1/restaurantes?zonaId=1;DROP')).statusCode).toBe(400);
    expect((await pub('/v1/restaurantes?limit=50')).statusCode).toBe(200);
  });

  it('filtros: texto sin importar mayúsculas, % y _ literales, zona, ciudad y etiqueta', async () => {
    const tag = unique();
    await activeLocal(`Filtro ${tag} Verde`, { etiquetas: ['vegetariano'], zonaId: 2 });
    await activeLocal(`Filtro ${tag} Rojo`, { etiquetas: ['marisco'], zonaId: 3 });
    const names = async (qs: string) => (await pub(`/v1/restaurantes?${qs}`)).json().items.map((i: { nombre: string }) => i.nombre);
    expect(await names(`q=filtro ${tag.toUpperCase()} VERDE`)).toEqual([`Filtro ${tag} Verde`]);
    expect(await names(`q=${tag}&zonaId=3`)).toEqual([`Filtro ${tag} Rojo`]);
    expect(await names(`q=${tag}&etiqueta=vegetariano`)).toEqual([`Filtro ${tag} Verde`]);
    expect((await names(`q=${tag}&ciudadId=1`)).length).toBe(2);
    expect(await names(`q=${tag}&ciudadId=2`)).toEqual([]);
    // Los comodines del usuario no se interpretan: "%" no devuelve todo.
    expect(await names('q=%25')).toEqual([]);
    expect(await names('q=_')).toEqual([]);
    expect(await names(`q=${encodeURIComponent("' OR '1'='1")}`)).toEqual([]);
  });

  it('el ILIKE del nombre puede resolverse con el índice trigram (EXPLAIN)', async () => {
    // Con pocas filas el planificador prefiere otros caminos; se aísla el predicado del nombre y se desactiva el recorrido
    // secuencial para comprobar que el índice trigram sirve para este patrón (con muchos locales lo elige por costo).
    const plan = await h.db.scope({ readOnly: true }, async (q) => {
      await q.query('SET LOCAL enable_seqscan = off');
      const r = await q.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT restaurante_id FROM restaurante WHERE nombre ILIKE '%cuchara%'`);
      return r.rows.map((x) => x['QUERY PLAN']).join(' | ');
    });
    expect(plan).toContain('idx_restaurante_nombre_trgm');
  });

  it('detalle: horarios, planes visibles y menú de hoy solo si está publicado', async () => {
    const o = await activeLocal(`Detalle ${unique()} Local`);
    const dish = async (nombre: string, extra: object = {}) =>
      (await own(o).post('/v1/menu/platos', { categoria: 'ALMUERZO', nombre, ...extra })).json().id as string;
    const sopa = await dish('Sopa de quinua');
    const seco = await dish('Seco de pollo', { precioCentavos: 400, descripcion: 'Con arroz' });
    await own(o).put('/v1/menu/hoy', {
      items: [
        { platoId: sopa, seccion: 'SOPA' },
        { platoId: seco, seccion: 'FUERTE', porciones: 5 },
      ],
    });
    await h.db.service((q) =>
      q.query(
        `INSERT INTO plantilla_plan (restaurante_id, tipo, nombre, almuerzos, precio_centavos, vigencia_dias, visible_en_marketplace, activo)
         SELECT restaurante_id, 'SEMANAL', x.nombre, 5, x.precio, 7, x.visible, x.activo FROM restaurante r,
           (VALUES ('Plan semanal', 1500, true, true), ('Plan oculto', 1000, false, true), ('Plan apagado', 900, true, false)) AS x(nombre, precio, visible, activo)
          WHERE r.public_id = $1`,
        [o.restaurante],
      ),
    );
    // Borrador del menú: no se ve.
    const draft = (await pub(`/v1/restaurantes/${o.slug}`)).json();
    expect(draft.menuHoy).toMatchObject({ publicado: false, secciones: [] });
    expect(draft.horarios).toHaveLength(7);
    expect(draft.planes).toEqual([
      {
        id: expect.stringMatching(/^[1-9][0-9]*$/),
        tipo: 'SEMANAL',
        nombre: 'Plan semanal',
        almuerzos: 5,
        precioCentavos: 1500,
        vigenciaDias: 7,
        diasValidos: [1, 2, 3, 4, 5],
        incluye: [],
      },
    ]);

    await own(o).post('/v1/menu/hoy/publicar');
    const items = (await h.call('GET', '/v1/menu/hoy', { token: o.token, restaurante: o.restaurante })).json().items;
    await own(o).patch(`/v1/menu/hoy/items/${items.find((i: { nombre: string }) => i.nombre === 'Seco de pollo').id}/agotado`, {
      agotado: true,
    });
    const live = (await pub(`/v1/restaurantes/${o.slug}`)).json();
    expect(live.menuHoy.publicado).toBe(true);
    expect(live.menuHoy.secciones.map((s: { seccion: string }) => s.seccion)).toEqual(['SOPA', 'FUERTE']);
    expect(live.menuHoy.secciones[1].platos[0]).toEqual({
      nombre: 'Seco de pollo',
      descripcion: 'Con arroz',
      fotoUrl: null,
      etiquetas: [],
      precioCentavos: 400,
      agotado: true,
    });
    // Al despublicar vuelve a desaparecer.
    await own(o).post('/v1/menu/hoy/despublicar');
    expect((await pub(`/v1/restaurantes/${o.slug}`)).json().menuHoy.publicado).toBe(false);
  });

  it('abiertoAhora respeta el horario en la zona horaria del local', async () => {
    const o = await activeLocal(`Abierto ${unique()} Local`);
    expect((await pub(`/v1/restaurantes/${o.slug}`)).json().abiertoAhora).toBe(true);
    await own(o).put('/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '03:00', cierra: '03:01' }] });
    const day = await h.db.service((q) =>
      q.query<{ d: number; t: string }>(
        `SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Guayaquil'))::int AS d, to_char(now() AT TIME ZONE 'America/Guayaquil', 'HH24:MI') AS t`,
      ),
    );
    const closedNow = !(day.rows[0]!.d === 1 && day.rows[0]!.t === '03:00');
    expect((await pub(`/v1/restaurantes/${o.slug}`)).json().abiertoAhora).toBe(!closedNow);
  });

  it('ocupación: LIBRE, sube con las ventas de los últimos 25 min y "Local lleno" manual fuerza LLENO', async () => {
    const o = await activeLocal(`Ocupacion ${unique()} Local`, { puestos: 10 });
    const occ = async () => (await pub(`/v1/restaurantes/${o.slug}`)).json().ocupacion;
    expect(await occ()).toEqual({ nivel: 'LIBRE', porcentaje: 0, lleno: false });
    const sale = (minutosAtras: number, ticket: number, total = 350) =>
      h.db.service((q) =>
        q.query(
          `INSERT INTO venta_pos_cabecera (restaurante_id, fecha_local, ticket, total_centavos, moneda_codigo, personal_id, clave_idempotencia, creado_en)
           SELECT r.restaurante_id, CURRENT_DATE, $2, $3, 'USD', p.personal_id, $4, now() - make_interval(mins => $5)
             FROM restaurante r JOIN personal_restaurante p ON p.restaurante_id = r.restaurante_id WHERE r.public_id = $1`,
          [o.restaurante, ticket, total, randomUUID(), minutosAtras],
        ),
      );
    for (let t = 1; t <= 5; t++) await sale(5, t); // 5 de 10 puestos
    expect(await occ()).toEqual({ nivel: 'MODERADO', porcentaje: 50, lleno: false });
    await sale(40, 6); // hace 40 min: ya no cuenta
    expect((await occ()).porcentaje).toBe(50);
    for (let t = 7; t <= 10; t++) await sale(1, t); // 9 de 10
    expect(await occ()).toEqual({ nivel: 'LLENO', porcentaje: 90, lleno: true });
    // Reset: cuenta manual
    const o2 = await activeLocal(`Ocupacion ${unique()} Manual`);
    const slug2 = o2.slug;
    expect((await pub(`/v1/restaurantes/${slug2}`)).json().ocupacion.nivel).toBe('LIBRE');
    await own(o2).post('/v1/restaurante/lleno', { lleno: true });
    expect((await pub(`/v1/restaurantes/${slug2}`)).json().ocupacion).toMatchObject({ nivel: 'LLENO', lleno: true });
    await own(o2).post('/v1/restaurante/lleno', { lleno: false });
    expect((await pub(`/v1/restaurantes/${slug2}`)).json().ocupacion.nivel).toBe('LIBRE');
    // "Local lleno" vencido: expira solo.
    await h.db.service((q) =>
      q.query(`UPDATE restaurante SET lleno_manual_hasta = now() - interval '1 minute' WHERE public_id = $1`, [o2.restaurante]),
    );
    expect((await pub(`/v1/restaurantes/${slug2}`)).json().ocupacion.nivel).toBe('LIBRE');
  });

  it('la función de ocupación solo devuelve conteos y no sirve para leer ventas ajenas', async () => {
    const r = await h.db.scope({ readOnly: true }, (q) => q.query('SELECT * FROM fn_ocupacion_local(1)'));
    expect(Object.keys(r.rows[0]!).sort()).toEqual(['lleno_manual', 'personas', 'puestos']);
    await expect(h.db.scope({ readOnly: true }, (q) => q.query('SELECT count(*) FROM venta_pos_cabecera'))).resolves.toMatchObject({
      rows: [{ count: '0' }],
    });
  });
});
