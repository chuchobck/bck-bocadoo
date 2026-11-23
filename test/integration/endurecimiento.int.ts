import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, unique } from './harness';

const registro = () => ({
  nombre: 'Rosa Andrade',
  correo: `cerrado_${unique()}@correo.com`,
  password: 'una-clave-larga-123',
  aceptaTerminos: true,
  restaurante: { nombre: 'Local Cerrado', ciudadId: 1 },
});

describe('Endurecimiento del piloto: registro de dueños cerrable', () => {
  const h = new Harness(76);
  beforeAll(() => {
    process.env.REGISTER_OWNER_ENABLED = 'false';
    return h.start();
  });
  afterAll(async () => {
    delete process.env.REGISTER_OWNER_ENABLED;
    await h.stop();
  });

  it('con REGISTER_OWNER_ENABLED=false responde 403 REGISTRO_CERRADO y no crea nada', async () => {
    const body = registro();
    const res = await h.call('POST', '/v1/auth/register-owner', { payload: body });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'REGISTRO_CERRADO' });
    // No existe la cuenta: el login falla como con cualquier usuario inexistente.
    const login = await h.call('POST', '/v1/auth/login', { payload: { identificador: body.correo, password: body.password } });
    expect(login.statusCode).toBe(401);
  });

  it('responde 403 antes de validar el cuerpo (un body vacío tampoco crea nada)', async () => {
    const res = await h.call('POST', '/v1/auth/register-owner', { payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('el registro de comensales sigue abierto', async () => {
    const res = await h.call('POST', '/v1/auth/register', {
      payload: { nombre: 'Ana', correo: `ana_${unique()}@correo.com`, password: 'una-clave-larga-123', aceptaTerminos: true },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('Endurecimiento del piloto: tope por cuenta en cajeros y vincular', () => {
  const h = new Harness(77);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it('cajeros: 10 por hora por usuario aunque cambie de IP; la 11 es 429 con Retry-After; otro dueño no se ve afectado', async () => {
    const o = await h.owner('Local Tope Cajeros');
    const otro = await h.owner('Local Tope Otro');
    const invitar = (a: typeof o) =>
      h.call('POST', '/v1/restaurante/personal/cajeros', {
        token: a.token,
        restaurante: a.restaurante,
        payload: { correo: `no_existe_${unique()}@correo.com` },
      });
    for (let i = 0; i < 10; i++) expect((await invitar(o)).statusCode).toBe(404); // IP distinta en cada llamada
    const bloqueado = await invitar(o);
    expect(bloqueado.statusCode).toBe(429);
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0);
    expect((await invitar(otro)).statusCode).toBe(404);
  });

  it('vincular: 10 por hora por usuario; la 11 es 429', async () => {
    const o = await h.owner('Local Tope Vincular');
    const vincular = () =>
      h.call('POST', '/v1/clientes/1/vincular', {
        token: o.token,
        restaurante: o.restaurante,
        payload: { correo: `x_${unique()}@correo.com` },
      });
    for (let i = 0; i < 10; i++) expect((await vincular()).statusCode).not.toBe(429);
    const bloqueado = await vincular();
    expect(bloqueado.statusCode).toBe(429);
    expect(Number(bloqueado.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('sin token no se crea ninguna clave por usuario: responde 401', async () => {
    const res = await h.call('POST', '/v1/restaurante/personal/cajeros', { payload: { correo: 'a@correo.com' } });
    expect(res.statusCode).toBe(401);
  });
});
