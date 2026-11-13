import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory';
import { DbService } from '../../src/db/db.service';

export const PASSWORD = 'una-clave-larga-123';
export const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export interface Actor {
  correo: string;
  token: string;
  usuarioId: string;
  restaurante: string;
}

/** Arma la API real y ayudantes para crear dueños y cajeros con tokens válidos. */
export class Harness {
  app!: NestFastifyApplication;
  db!: DbService;
  private n = 0;
  constructor(private readonly base: number) {}

  async start(opts?: Parameters<typeof createApp>[0]) {
    this.app = await createApp(opts);
    await this.app.init();
    await this.app.getHttpAdapter().getInstance().ready();
    this.db = this.app.get(DbService);
  }
  stop() {
    return this.app.close();
  }

  /** Cada petición sale de una IP distinta para no compartir contadores de rate limit. */
  ip() {
    this.n += 1;
    return `10.${this.base}.${Math.floor(this.n / 250)}.${(this.n % 250) + 1}`;
  }

  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    o: { payload?: object; token?: string; restaurante?: string; ip?: string } = {},
  ) {
    return this.app.inject({
      method,
      url,
      payload: o.payload,
      remoteAddress: o.ip ?? this.ip(),
      headers: { ...(o.token && { authorization: `Bearer ${o.token}` }), ...(o.restaurante && { 'x-restaurant-id': o.restaurante }) },
    });
  }

  async login(correo: string) {
    const l = await this.call('POST', '/v1/auth/login', { payload: { identificador: correo, password: PASSWORD } });
    return l.json().accessToken as string;
  }

  async owner(nombreLocal: string): Promise<Actor> {
    const correo = `dueno_${unique()}@correo.com`;
    const r = await this.call('POST', '/v1/auth/register-owner', {
      payload: {
        nombre: 'Dueño Prueba',
        correo,
        password: PASSWORD,
        aceptaTerminos: true,
        restaurante: { nombre: nombreLocal, ciudadId: 1 },
      },
    });
    if (r.statusCode !== 201) throw new Error(`registro de dueño falló: ${r.body}`);
    return { correo, token: await this.login(correo), usuarioId: r.json().usuario.id, restaurante: r.json().restaurante.id };
  }

  /** Comensal sin local (para invitar como cajero, etc.). */
  async diner(): Promise<{ correo: string; token: string; usuarioId: string }> {
    const correo = `comensal_${unique()}@correo.com`;
    const r = await this.call('POST', '/v1/auth/register', {
      payload: { nombre: 'Comensal Prueba', correo, password: PASSWORD, aceptaTerminos: true },
    });
    if (r.statusCode !== 201) throw new Error(`registro falló: ${r.body}`);
    return { correo, token: await this.login(correo), usuarioId: r.json().usuario.id };
  }

  /** Cajero de un local, creado directo en base (así no depende del endpoint de invitación). */
  async cashier(restaurantePublicId: string): Promise<Actor> {
    const d = await this.diner();
    await this.db.service((q) =>
      q.query(
        `INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible)
         SELECT r.restaurante_id, u.usuario_id, 'CAJERO', 'Cajero' FROM restaurante r, usuario u WHERE r.public_id = $1 AND u.public_id = $2`,
        [restaurantePublicId, d.usuarioId],
      ),
    );
    return { correo: d.correo, token: d.token, usuarioId: d.usuarioId, restaurante: restaurantePublicId };
  }
}
