import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './harness';

describe('Personal: agregar y desactivar cajeros', () => {
  const h = new Harness(71);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it('el dueño agrega a una cuenta existente como cajero y ese cajero ya puede operar', async () => {
    const o = await h.owner('Local Personal');
    const d = await h.diner();
    const res = await h.call('POST', '/v1/restaurante/personal/cajeros', {
      token: o.token,
      restaurante: o.restaurante,
      payload: { correo: d.correo.toUpperCase(), nombreVisible: 'Pedro Caja' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ usuarioId: d.usuarioId, nombreVisible: 'Pedro Caja', rol: 'CAJERO', activo: true });
    expect(JSON.stringify(res.json())).not.toContain(d.correo); // nunca devuelve el correo
    // Ahora el cajero entra al restaurante con su propio token.
    expect((await h.call('GET', '/v1/restaurante', { token: d.token, restaurante: o.restaurante })).statusCode).toBe(200);
    const list = await h.call('GET', '/v1/restaurante/personal', { token: o.token, restaurante: o.restaurante });
    expect(
      list
        .json()
        .map((p: { rol: string }) => p.rol)
        .sort(),
    ).toEqual(['CAJERO', 'DUENO']);
  });

  it('desactivar corta el acceso de inmediato; reactivar lo devuelve', async () => {
    const o = await h.owner('Local Baja');
    const d = await h.diner();
    await h.call('POST', '/v1/restaurante/personal/cajeros', { token: o.token, restaurante: o.restaurante, payload: { correo: d.correo } });
    const off = await h.call('PATCH', `/v1/restaurante/personal/${d.usuarioId}`, {
      token: o.token,
      restaurante: o.restaurante,
      payload: { activo: false },
    });
    expect(off.json().activo).toBe(false);
    expect((await h.call('GET', '/v1/restaurante', { token: d.token, restaurante: o.restaurante })).statusCode).toBe(403);
    expect(
      (
        await h.call('PATCH', `/v1/restaurante/personal/${d.usuarioId}`, {
          token: o.token,
          restaurante: o.restaurante,
          payload: { activo: true },
        })
      ).json().activo,
    ).toBe(true);
    expect((await h.call('GET', '/v1/restaurante', { token: d.token, restaurante: o.restaurante })).statusCode).toBe(200);
  });

  it('reglas: duplicado 409, cuenta inexistente 404, el dueño no se desactiva, el cajero no administra personal', async () => {
    const o = await h.owner('Local Reglas');
    const d = await h.diner();
    const post = (correo: string, who = o) =>
      h.call('POST', '/v1/restaurante/personal/cajeros', { token: who.token, restaurante: o.restaurante, payload: { correo } });
    expect((await post(d.correo)).statusCode).toBe(201);
    expect((await post(d.correo)).statusCode).toBe(409);
    expect((await post(`nadie_${Date.now()}@correo.com`)).statusCode).toBe(404);
    expect((await post('no-es-correo')).statusCode).toBe(400);
    expect(
      (
        await h.call('PATCH', `/v1/restaurante/personal/${o.usuarioId}`, {
          token: o.token,
          restaurante: o.restaurante,
          payload: { activo: false },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.call('PATCH', '/v1/restaurante/personal/no-uuid', {
          token: o.token,
          restaurante: o.restaurante,
          payload: { activo: false },
        })
      ).statusCode,
    ).toBe(400);
    // El cajero no puede agregar gente ni listar al personal.
    expect((await post('otro@correo.com', { ...d, restaurante: o.restaurante, correo: d.correo })).statusCode).toBe(403);
    expect((await h.call('GET', '/v1/restaurante/personal', { token: d.token, restaurante: o.restaurante })).statusCode).toBe(403);
  });

  it('un dueño no puede desactivar al personal de otro local', async () => {
    const a = await h.owner('Local A Personal');
    const b = await h.owner('Local B Personal');
    const d = await h.diner();
    await h.call('POST', '/v1/restaurante/personal/cajeros', { token: b.token, restaurante: b.restaurante, payload: { correo: d.correo } });
    const res = await h.call('PATCH', `/v1/restaurante/personal/${d.usuarioId}`, {
      token: a.token,
      restaurante: a.restaurante,
      payload: { activo: false },
    });
    expect(res.statusCode).toBe(404);
    expect((await h.call('GET', '/v1/restaurante', { token: d.token, restaurante: b.restaurante })).statusCode).toBe(200);
  });

  it('buscar cuentas por correo tiene límite por hora', async () => {
    const o = await h.owner('Local Límite');
    const ip = '10.71.200.1';
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push(
        (
          await h.call('POST', '/v1/restaurante/personal/cajeros', {
            token: o.token,
            restaurante: o.restaurante,
            payload: { correo: `x${i}_${Date.now()}@correo.com` },
            ip,
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 20).every((c) => c === 404)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });
});
