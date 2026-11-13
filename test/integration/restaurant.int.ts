import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './harness';

describe('Restaurante: perfil, estado, horarios, mesas y "local lleno"', () => {
  const h = new Harness(70);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it('el dueño ve y edita su perfil; el cajero solo lo ve', async () => {
    const o = await h.owner('Local Perfil');
    const c = await h.cashier(o.restaurante);
    const got = await h.call('GET', '/v1/restaurante', { token: o.token, restaurante: o.restaurante });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: o.restaurante, nombre: 'Local Perfil', estado: 'BORRADOR', monedaCodigo: 'USD', puestos: 20 });
    expect((await h.call('GET', '/v1/restaurante', { token: c.token, restaurante: o.restaurante })).statusCode).toBe(200);

    const patch = await h.call('PATCH', '/v1/restaurante', {
      token: o.token,
      restaurante: o.restaurante,
      payload: {
        nombre: '  Café  Ñandú ',
        descripcionCorta: 'Comida casera',
        etiquetas: ['casero'],
        puestos: 30,
        precioSueltoCentavos: 350,
        telefono: '+593990000123',
        zonaId: 1,
        latitud: -0.2,
        longitud: -78.5,
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      nombre: 'Café  Ñandú',
      puestos: 30,
      precioSueltoCentavos: 350,
      telefono: '+593990000123',
      zonaId: 1,
      latitud: -0.2,
    });
    // El cajero no edita el local.
    expect(
      (await h.call('PATCH', '/v1/restaurante', { token: c.token, restaurante: o.restaurante, payload: { puestos: 5 } })).statusCode,
    ).toBe(403);
  });

  it('valida los datos: estado/slug no se tocan, tipos, rangos, null en NOT NULL y zona de otra ciudad', async () => {
    const o = await h.owner('Local Validación');
    const patch = (payload: object) => h.call('PATCH', '/v1/restaurante', { token: o.token, restaurante: o.restaurante, payload });
    expect((await patch({ estado: 'ACTIVO' })).statusCode).toBe(400);
    expect((await patch({ slug: 'otro' })).statusCode).toBe(400);
    expect((await patch({ puestos: 0 })).statusCode).toBe(400);
    expect((await patch({ puestos: null })).statusCode).toBe(400);
    expect((await patch({ nombre: null })).statusCode).toBe(400);
    expect((await patch({ precioSueltoCentavos: -1 })).statusCode).toBe(400);
    expect((await patch({ telefono: '0990000123' })).statusCode).toBe(400);
    expect((await patch({ logoUrl: 'http://inseguro.test/x.png' })).statusCode).toBe(400);
    expect((await patch({ latitud: 91 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ zonaId: 999999 })).statusCode).toBe(400);
    // Zona de otra ciudad (Guayaquil no tiene zonas en el seed; se crea una de prueba).
    const z = await h.db.service((q) =>
      q.query<{ zona_id: string }>(
        `INSERT INTO zona (ciudad_id, nombre, slug, latitud, longitud) VALUES (2, 'Zona GYE ${Date.now()}', 'gye-${Date.now()}', -2.1, -79.9) RETURNING zona_id`,
      ),
    );
    expect((await patch({ zonaId: Number(z.rows[0]!.zona_id) })).statusCode).toBe(400);
    // Los campos opcionales aceptan null para limpiar.
    expect((await patch({ descripcionCorta: 'algo' })).statusCode).toBe(200);
    expect((await patch({ descripcionCorta: null })).json().descripcionCorta).toBeNull();
  });

  it('activar exige precio y horario; pausar lo saca de la vitrina', async () => {
    const o = await h.owner('Local Estado');
    const call = (m: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
      h.call(m, url, { token: o.token, restaurante: o.restaurante, payload });
    const fail = await call('POST', '/v1/restaurante/activar');
    expect(fail.statusCode).toBe(409);
    expect(fail.json().detail).toContain('precio del almuerzo suelto y al menos un horario');
    await call('PATCH', '/v1/restaurante', { precioSueltoCentavos: 300 });
    expect((await call('POST', '/v1/restaurante/activar')).json().detail).toContain('al menos un horario');
    await call('PUT', '/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '12:00', cierra: '15:00' }] });
    const ok = await call('POST', '/v1/restaurante/activar');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().estado).toBe('ACTIVO');
    expect((await call('POST', '/v1/restaurante/pausar')).json().estado).toBe('PAUSADO');
    expect((await call('POST', '/v1/restaurante/pausar')).json().estado).toBe('PAUSADO'); // idempotente
    expect((await call('POST', '/v1/restaurante/activar')).json().estado).toBe('ACTIVO');
  });

  it('horarios: varios tramos por día, reemplazo completo, validaciones', async () => {
    const o = await h.owner('Local Horarios');
    const put = (horarios: object[]) =>
      h.call('PUT', '/v1/restaurante/horarios', { token: o.token, restaurante: o.restaurante, payload: { horarios } });
    const ok = await put([
      { diaSemana: 1, abre: '12:00', cierra: '15:00' },
      { diaSemana: 1, abre: '18:00', cierra: '21:00' },
      { diaSemana: 2, abre: '12:00', cierra: '15:00' },
    ]);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(3);
    expect((await put([{ diaSemana: 3, abre: '10:00', cierra: '11:00' }])).json()).toEqual([
      { diaSemana: 3, abre: '10:00', cierra: '11:00' },
    ]);
    expect((await put([{ diaSemana: 1, abre: '15:00', cierra: '12:00' }])).statusCode).toBe(400);
    expect(
      (
        await put([
          { diaSemana: 1, abre: '12:00', cierra: '15:00' },
          { diaSemana: 1, abre: '14:00', cierra: '16:00' },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await put([{ diaSemana: 8, abre: '12:00', cierra: '15:00' }])).statusCode).toBe(400);
    expect((await put([{ diaSemana: 1, abre: '25:00', cierra: '26:00' }])).statusCode).toBe(400);
    expect((await put([])).json()).toEqual([]);
    const c = await h.cashier(o.restaurante);
    expect((await h.call('GET', '/v1/restaurante/horarios', { token: c.token, restaurante: o.restaurante })).statusCode).toBe(200);
    expect(
      (await h.call('PUT', '/v1/restaurante/horarios', { token: c.token, restaurante: o.restaurante, payload: { horarios: [] } }))
        .statusCode,
    ).toBe(403);
  });

  it('mesas: crear, editar, desactivar; etiqueta repetida → 409; el otro local no las ve', async () => {
    const o = await h.owner('Local Mesas');
    const other = await h.owner('Local Mesas Otro');
    const call = (m: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, who = o) =>
      h.call(m, url, { token: who.token, restaurante: who.restaurante, payload });
    const m = await call('POST', '/v1/restaurante/mesas', { etiqueta: 'Mesa 1', capacidad: 4 });
    expect(m.statusCode).toBe(201);
    expect((await call('POST', '/v1/restaurante/mesas', { etiqueta: 'Mesa 1', capacidad: 2 })).statusCode).toBe(409);
    expect((await call('POST', '/v1/restaurante/mesas', { etiqueta: 'Mesa 2', capacidad: 0 })).statusCode).toBe(400);
    const id = m.json().id;
    expect((await call('PATCH', `/v1/restaurante/mesas/${id}`, { capacidad: 6, activo: false })).json()).toMatchObject({
      capacidad: 6,
      activo: false,
    });
    expect((await call('PATCH', `/v1/restaurante/mesas/${id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/restaurante/mesas/abc', { capacidad: 2 })).statusCode).toBe(400);
    // Otro local no puede editar ni ver la mesa por id.
    expect((await call('PATCH', `/v1/restaurante/mesas/${id}`, { capacidad: 2 }, other)).statusCode).toBe(404);
    expect((await call('GET', '/v1/restaurante/mesas', undefined, other)).json()).toEqual([]);
    expect((await call('GET', '/v1/restaurante/mesas')).json()).toHaveLength(1);
  });

  it('"Local lleno": lo marcan dueño y cajero, dura 20 minutos y se puede quitar', async () => {
    const o = await h.owner('Local Lleno');
    const c = await h.cashier(o.restaurante);
    const on = await h.call('POST', '/v1/restaurante/lleno', { token: c.token, restaurante: o.restaurante, payload: { lleno: true } });
    expect(on.statusCode).toBe(200);
    const mins = (new Date(on.json().llenoManualHasta).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(19);
    expect(mins).toBeLessThanOrEqual(20.1);
    const off = await h.call('POST', '/v1/restaurante/lleno', { token: o.token, restaurante: o.restaurante, payload: { lleno: false } });
    expect(off.json()).toEqual({ lleno: false, llenoManualHasta: null });
    expect(
      (await h.call('POST', '/v1/restaurante/lleno', { token: o.token, restaurante: o.restaurante, payload: { lleno: 'si' } })).statusCode,
    ).toBe(400);
  });

  it('la edición queda auditada con el usuario real', async () => {
    const o = await h.owner('Local Auditoría');
    await h.call('PATCH', '/v1/restaurante', { token: o.token, restaurante: o.restaurante, payload: { puestos: 44 } });
    const r = await h.db.service((q) =>
      q.query(
        `SELECT 1 FROM log_actividad l JOIN usuario u ON u.usuario_id = l.ejecutado_por_usuario_id JOIN restaurante r ON r.restaurante_id = l.entidad_registro_id
          WHERE l.entidad_afectada = 'restaurante' AND l.accion = 'EDITAR' AND u.public_id = $1 AND r.public_id = $2`,
        [o.usuarioId, o.restaurante],
      ),
    );
    expect(r.rowCount).toBeGreaterThan(0);
  });
});
