import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { Actor, Harness, unique } from './harness';
import { Probe } from './probe';

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Hacia afuera solo public_id: todo campo `id` o `…Id` de la respuesta es un UUID (o null), nunca un id interno. */
export function expectOnlyPublicIds(value: unknown, path = '$'): void {
  if (Array.isArray(value)) return value.forEach((v, i) => expectOnlyPublicIds(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (/(^id$|Id$|_id$)/.test(key)) {
      expect(v === null || (typeof v === 'string' && UUID.test(v)), `${path}.${key} = ${JSON.stringify(v)} no es un public_id`).toBe(true);
    }
    expectOnlyPublicIds(v, `${path}.${key}`);
  }
}

/** Comensal con cuenta. `clienteId` es el id de su ficha en un local (solo lo usa el personal). */
export interface Diner {
  correo: string;
  token: string;
  usuarioId: string;
  clienteId?: string;
}

/**
 * Ayudantes de la fase 8 sobre la API real, con el patrón probe: todo lo que estas pruebas escriben se deshace al
 * terminar cada prueba (ver probe.ts).
 */
export class DinerKit {
  readonly h: Harness;
  constructor(
    readonly probe: Probe,
    base: number,
  ) {
    this.h = new Harness(base);
  }

  start() {
    return this.h.start({ poolFactory: this.probe.factory });
  }
  stop() {
    return this.h.stop();
  }

  as(who: { token?: string; restaurante?: string }) {
    const send = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, key?: string) =>
      this.h.app.inject({
        method,
        url,
        payload,
        remoteAddress: this.h.ip(),
        headers: {
          ...(who.token && { authorization: `Bearer ${who.token}` }),
          ...(who.restaurante && { 'x-restaurant-id': who.restaurante }),
          ...(key && { 'idempotency-key': key }),
        },
      });
    return {
      get: (url: string) => send('GET', url),
      post: (url: string, payload?: object, key?: string) => send('POST', url, payload, key),
      patch: (url: string, payload?: object) => send('PATCH', url, payload),
      put: (url: string, payload?: object) => send('PUT', url, payload),
    };
  }

  owner(nombre = `Local ${unique()}`) {
    return this.h.owner(nombre);
  }

  /** Local activo (precio suelto, horario de todos los días y estado ACTIVO). */
  async activeOwner(nombre?: string): Promise<Actor & { slug: string }> {
    const o = await this.owner(nombre);
    await this.as(o).patch('/v1/restaurante', { precioSueltoCentavos: 350, recargoParaLlevarCentavos: 25 });
    await this.as(o).put('/v1/restaurante/horarios', {
      horarios: ALL_DAYS.map((d) => ({ diaSemana: d, abre: '00:00', cierra: '23:59' })),
    });
    const act = await this.as(o).post('/v1/restaurante/activar');
    expect(act.statusCode, act.body).toBe(200);
    const perfil = (await this.as(o).get('/v1/restaurante')).json();
    return { ...o, slug: perfil.slug };
  }

  diner() {
    return this.h.diner();
  }

  /**
   * Menú de hoy publicado: sopa, dos fuertes y jugo (sin precio: van en el almuerzo) más dos extras con precio.
   * Devuelve los public_id que ve el comensal en la vitrina, por nombre.
   */
  async menu(o: Actor & { slug: string }): Promise<Record<string, string>> {
    const platos: [string, string, string, number | null][] = [
      ['Sopa de quinua', 'ALMUERZO', 'SOPA', null],
      ['Seco de pollo', 'ALMUERZO', 'FUERTE', null],
      ['Menestra con carne', 'ALMUERZO', 'FUERTE', null],
      ['Jugo de mora', 'ALMUERZO', 'JUGO', null],
      ['Huevo frito', 'EXTRA', 'ADICIONAL', 75],
      ['Cola', 'BEBIDA', 'ADICIONAL', 100],
    ];
    const items = [];
    for (const [nombre, categoria, seccion, precioCentavos] of platos) {
      const r = await this.as(o).post('/v1/menu/platos', { nombre, categoria, seccion, precioCentavos });
      expect(r.statusCode, r.body).toBe(201);
      items.push({ platoId: r.json().id, seccion });
    }
    expect((await this.as(o).put('/v1/menu/hoy', { items })).statusCode).toBe(200);
    expect((await this.as(o).post('/v1/menu/hoy/publicar')).statusCode).toBe(200);
    const vitrina = (await this.as({}).get(`/v1/restaurantes/${o.slug}`)).json();
    const ids: Record<string, string> = {};
    for (const s of vitrina.menuHoy.secciones) for (const p of s.platos) ids[p.nombre] = p.id;
    return ids;
  }

  async plan(o: Actor, extra: object = {}) {
    const r = await this.as(o).post('/v1/planes', {
      tipo: 'SEMANAL',
      nombre: 'Semanal',
      almuerzos: 5,
      precioCentavos: 1500,
      vigenciaDias: 7,
      diasValidos: ALL_DAYS,
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  /** Comensal con cuenta, vinculado como cliente del local `o` y con un plan pagado. */
  async dinerWithPlan(o: Actor, extra: object = {}, d?: Diner): Promise<Diner & { clienteId: string }> {
    const diner = d ?? (await this.diner());
    const c = (await this.as(o).post('/v1/clientes', { nombre: `Cliente ${unique()}` })).json().id as string;
    const link = await this.as(o).post(`/v1/clientes/${c}/vincular`, { correo: diner.correo });
    expect(link.statusCode, link.body).toBe(200);
    const sale = await this.as(o).post(
      `/v1/clientes/${c}/planes`,
      { planId: await this.plan(o, extra), metodoPago: 'EFECTIVO' },
      randomUUID(),
    );
    expect(sale.statusCode, sale.body).toBe(201);
    return { ...diner, clienteId: c };
  }

  /** La caja valida un almuerzo del cliente (búsqueda manual). Devuelve el public_id del consumo. */
  async lunch(o: Actor, clienteId: string): Promise<string> {
    const r = await this.as(o).post('/v1/caja/validar', { clienteId }, randomUUID());
    expect(r.json().descontado, r.body).toBe(true);
    return r.json().consumo.id as string;
  }

  /**
   * Mueve al pasado la hora de un consumo. consumo_almuerzo es de solo inserción: solo aquí, dentro del probe y como
   * superusuario, se apagan los triggers para preparar el dato; el ROLLBACK lo deshace todo.
   */
  async backdateLunch(consumoPublicId: string, minutes: number) {
    await this.probe.sql('SET LOCAL session_replication_role = replica');
    await this.probe.sql(`UPDATE consumo_almuerzo SET creado_en = creado_en - make_interval(mins => $2) WHERE public_id = $1`, [
      consumoPublicId,
      minutes,
    ]);
    await this.probe.sql('SET LOCAL session_replication_role = origin');
  }

  /** usuario_id interno a partir del public_id (solo para consultas directas de las pruebas). */
  async internalUser(publicId: string) {
    const r = await this.probe.sql<{ usuario_id: string }>('SELECT usuario_id FROM usuario WHERE public_id = $1', [publicId]);
    return String(r.rows[0]!.usuario_id);
  }

  /** Consulta como bck_api con el contexto dado, sin filtros de la API: lo que RLS deja ver. */
  rls<T extends object = Record<string, unknown>>(ctx: { userId?: string; tenantId?: string }, sql: string, params?: unknown[]) {
    return this.h.db.scope(ctx, async (q) => (await q.query<T & Record<string, unknown>>(sql, params)).rows);
  }
}
