import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, PASSWORD, unique, type Actor } from './harness';
import { ejemploCedulaRuc } from '../../src/restaurant/country/ejemplos';

// Datos inventados con dígito verificador válido (ver test/unit/country-ec.spec.ts).
const CEDULA = '1700000993';
const RUC = ejemploCedulaRuc();
const PERFIL = {
  cedulaRuc: RUC,
  telefono: '0991234567',
  direccion: 'Av. Siempre Viva 123',
  latitud: -0.18,
  longitud: -78.47,
  mesas: 12,
  puestos: 40,
  precioAlmuerzoCentavos: 300,
  precioSoloSegundoCentavos: 220,
  precioSoloSopaCentavos: 120,
  recargoParaLlevarCentavos: 30,
};

describe('Perfil de negocio del restaurante (campos opcionales)', () => {
  const h = new Harness(71);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const ctx = (o: Actor) => ({ token: o.token, restaurante: o.restaurante });
  const get = (o: Actor) => h.call('GET', '/v1/restaurante', ctx(o));
  const patch = (o: Actor, payload: object) => h.call('PATCH', '/v1/restaurante', { ...ctx(o), payload });
  const registrar = (restaurante: object, nombre = 'Perfil Nuevo') => {
    const correo = `perfil_${unique()}@correo.com`;
    return h
      .call('POST', '/v1/auth/register-owner', {
        payload: {
          nombre: 'Dueño Perfil',
          correo,
          password: PASSWORD,
          aceptaTerminos: true,
          restaurante: { nombre, ciudadId: 1, ...restaurante },
        },
      })
      .then((res) => ({ res, correo }));
  };
  const dueno = async (restaurante: object, nombre?: string): Promise<Actor> => {
    const { res, correo } = await registrar(restaurante, nombre);
    expect(res.statusCode).toBe(201);
    return { correo, token: await h.login(correo), usuarioId: res.json().usuario.id, restaurante: res.json().restaurante.id };
  };
  const tenantId = async (publicId: string) =>
    String(
      (
        await h.db.service((q) =>
          q.query<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante WHERE public_id = $1', [publicId]),
        )
      ).rows[0]!.restaurante_id,
    );

  it('cliente anterior: registro mínimo + PATCH antiguo siguen funcionando, con defaults y todo pendiente', async () => {
    const o = await h.owner('Local Cliente Viejo');
    const g = (await get(o)).json();
    expect(g).toMatchObject({
      puestos: 20,
      mesas: null,
      cedulaRuc: null,
      telefono: null,
      precioSueltoCentavos: 0,
      precioAlmuerzoCentavos: 0,
      precioSoloSegundoCentavos: null,
      precioSoloSopaCentavos: null,
      recargoParaLlevarCentavos: 25, // default nuevo para filas nuevas
      perfilCompleto: false,
    });
    expect(g.datosPendientes).toEqual(['cedulaRuc', 'telefono', 'direccion', 'coordenadas', 'mesas', 'puestos', 'precioAlmuerzo']);
    const p = await patch(o, { puestos: 30, precioSueltoCentavos: 350, telefono: '+593990000123', latitud: -0.2, longitud: -78.5 });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ puestos: 30, precioSueltoCentavos: 350, precioAlmuerzoCentavos: 350, telefono: '+593990000123' });
    expect((await get(o)).json().datosPendientes).toEqual(['cedulaRuc', 'direccion', 'mesas']);
  });

  it('el slug lo genera el servidor desde el nombre y no se pide ni se acepta', async () => {
    const { res } = await registrar({}, 'Café Ñandú del Centro');
    expect(res.json().restaurante.slug).toMatch(/^cafe-nandu-del-centro-[0-9a-f]{6}$/);
    expect((await registrar({ slug: 'mio' })).res.statusCode).toBe(400);
  });

  it('register-owner acepta los campos nuevos: normaliza el teléfono y guarda la cédula aparte', async () => {
    const o = await dueno(PERFIL, 'Perfil Completo');
    const g = (await get(o)).json();
    expect(g).toMatchObject({
      telefono: '+593991234567',
      direccion: PERFIL.direccion,
      latitud: -0.18,
      longitud: -78.47,
      mesas: 12,
      puestos: 40,
      precioAlmuerzoCentavos: 300,
      precioSueltoCentavos: 300,
      precioSoloSegundoCentavos: 220,
      precioSoloSopaCentavos: 120,
      recargoParaLlevarCentavos: 30,
      cedulaRuc: `${'*'.repeat(9)}${RUC.slice(-4)}`,
      perfilCompleto: true,
      datosPendientes: [],
    });
    expect(JSON.stringify(g)).not.toContain(RUC);
  });

  it('la cédula completa está en restaurante_fiscal, no en restaurante', async () => {
    const o = await dueno({ cedulaRuc: CEDULA });
    const id = await tenantId(o.restaurante);
    const f = await h.db.service((q) =>
      q.query<{ cedula_ruc: string }>('SELECT cedula_ruc FROM restaurante_fiscal WHERE restaurante_id = $1', [id]),
    );
    expect(f.rows[0]!.cedula_ruc).toBe(CEDULA);
    const cols = await h.db.service((q) =>
      q.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'restaurante' AND column_name ILIKE '%cedula%'`),
    );
    expect(cols.rowCount).toBe(0);
  });

  it('register-owner valida cada campo nuevo (400) y no deja el usuario a medias', async () => {
    const casos: object[] = [
      { cedulaRuc: '1700000994' },
      { cedulaRuc: '123' },
      { telefono: '0891234567' },
      { telefono: '022345678' },
      { latitud: 40.4, longitud: -3.7 },
      { mesas: 0 },
      { mesas: 201 },
      { puestos: 1001 },
      { mesas: 30, puestos: 20 },
      { precioAlmuerzoCentavos: 99 },
      { precioAlmuerzoCentavos: 5001 },
      { precioAlmuerzoCentavos: 300.5 },
      { precioSoloSopaCentavos: 0 },
      { recargoParaLlevarCentavos: -1 },
    ];
    for (const c of casos) {
      const { res, correo } = await registrar(c);
      expect(res.statusCode, JSON.stringify(c)).toBe(400);
      const left = await h.db.service((q) => q.query('SELECT 1 FROM usuario WHERE correo = $1', [correo]));
      expect(left.rowCount, JSON.stringify(c)).toBe(0);
    }
  });

  it('PATCH completa el perfil y valida: teléfono, cédula/RUC, coordenadas, mesas y puestos', async () => {
    const o = await h.owner('Local Perfil PATCH');
    const mal = async (payload: object) => expect((await patch(o, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    await mal({ telefono: '12345' });
    await mal({ cedulaRuc: '1700000994' });
    await mal({ cedulaRuc: '1790000002001' });
    await mal({ latitud: 4.6, longitud: -74.08 }); // Bogotá
    await mal({ latitud: 95, longitud: 0 });
    await mal({ mesas: 30 }); // solo mesas: contra los 20 puestos guardados
    await mal({ mesas: 30, puestos: 20 });
    await mal({ puestos: 1001 });
    await mal({ precioAlmuerzoCentavos: 99 });
    await mal({ precioAlmuerzoCentavos: 300, precioSueltoCentavos: 350 });
    await mal({ cedulaRuc: 1700000993 }); // número, no texto

    const ok = await patch(o, PERFIL);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      telefono: '+593991234567',
      mesas: 12,
      puestos: 40,
      precioSueltoCentavos: 300,
      recargoParaLlevarCentavos: 30,
    });
    expect(JSON.stringify(ok.json())).not.toContain(RUC);
    const g = (await get(o)).json();
    expect(g).toMatchObject({ perfilCompleto: true, datosPendientes: [] });

    // Un solo campo se compara con lo guardado (12 mesas, 40 puestos).
    await mal({ puestos: 11 });
    expect((await patch(o, { puestos: 12 })).statusCode).toBe(200);
    await mal({ mesas: 13 });
    expect((await patch(o, { mesas: 5 })).statusCode).toBe(200);
    expect((await patch(o, { puestos: 5, mesas: null })).statusCode).toBe(200);
    expect((await get(o)).json().datosPendientes).toEqual(['mesas']);
  });

  it('el estado final no cambia si el PATCH falla a medias (todo o nada)', async () => {
    const o = await dueno(PERFIL, 'Local Todo O Nada');
    const antes = (await get(o)).json();
    expect((await patch(o, { direccion: 'Otra', mesas: 99, puestos: 10 })).statusCode).toBe(400);
    const despues = (await get(o)).json();
    expect(despues.direccion).toBe(antes.direccion);
    expect(despues.puestos).toBe(antes.puestos);
  });

  it('null borra cédula, teléfono y precios opcionales', async () => {
    const o = await dueno(PERFIL, 'Local Borrar');
    const p = await patch(o, {
      cedulaRuc: null,
      telefono: null,
      precioSoloSegundoCentavos: null,
      precioSoloSopaCentavos: null,
      mesas: null,
    });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ cedulaRuc: null, telefono: null, precioSoloSegundoCentavos: null, mesas: null });
    expect((await get(o)).json().datosPendientes).toEqual(['cedulaRuc', 'telefono', 'mesas']);
  });

  it('el cajero ve la cédula enmascarada y no puede editar el perfil', async () => {
    const o = await dueno(PERFIL, 'Local Cajero Perfil');
    const c = await h.cashier(o.restaurante);
    const g = await h.call('GET', '/v1/restaurante', { token: c.token, restaurante: o.restaurante });
    expect(g.statusCode).toBe(200);
    expect(JSON.stringify(g.json())).not.toContain(RUC);
    expect(g.json().cedulaRuc).toBe(`${'*'.repeat(9)}${RUC.slice(-4)}`);
    expect(
      (await h.call('PATCH', '/v1/restaurante', { token: c.token, restaurante: o.restaurante, payload: { cedulaRuc: null } })).statusCode,
    ).toBe(403);
  });

  it('endpoints públicos: precios y recargo sí; la cédula/RUC nunca', async () => {
    const o = await dueno(PERFIL, 'Local Vitrina Perfil');
    expect(
      (
        await h.call('PUT', '/v1/restaurante/horarios', {
          ...ctx(o),
          payload: { horarios: [{ diaSemana: 1, abre: '12:00', cierra: '15:00' }] },
        })
      ).statusCode,
    ).toBe(200);
    expect((await h.call('POST', '/v1/restaurante/activar', ctx(o))).statusCode).toBe(200);
    const slug = (await get(o)).json().slug as string;

    const lista = await h.call('GET', `/v1/restaurantes?q=${encodeURIComponent('Vitrina Perfil')}`);
    const detalle = await h.call('GET', `/v1/restaurantes/${slug}`);
    expect(detalle.statusCode).toBe(200);
    for (const res of [lista, detalle]) {
      expect(res.body).not.toContain(RUC);
      expect(res.body).not.toMatch(/cedula|ruc/i);
    }
    const card = lista.json().items.find((i: { slug: string }) => i.slug === slug);
    for (const x of [card, detalle.json()]) {
      expect(x).toMatchObject({
        precioSueltoCentavos: 300,
        precioAlmuerzoCentavos: 300,
        precioSoloSegundoCentavos: 220,
        precioSoloSopaCentavos: 120,
        recargoParaLlevarCentavos: 30,
      });
    }
  });

  it('aislamiento: otro tenant, el rol de la API sin tenant y la auditoría no ven la cédula', async () => {
    const a = await dueno({ cedulaRuc: CEDULA }, 'Local Fiscal A');
    const b = await dueno({ cedulaRuc: '1790000001001' }, 'Local Fiscal B');
    const idA = await tenantId(a.restaurante);
    const idB = await tenantId(b.restaurante);
    const ver = (tenant: string | undefined) =>
      h.db.scope(tenant ? { tenantId: tenant } : {}, (q) =>
        q.query<{ restaurante_id: string }>('SELECT restaurante_id FROM restaurante_fiscal'),
      );
    expect((await ver(idA)).rows.map((r) => String(r.restaurante_id))).toEqual([idA]);
    expect((await ver(idB)).rows.map((r) => String(r.restaurante_id))).toEqual([idB]);
    expect((await ver(undefined)).rows).toEqual([]);
    // B no puede escribir ni cambiar la cédula de A, aunque fuerce el id.
    await expect(
      h.db.scope({ tenantId: idB }, (q) =>
        q.query('INSERT INTO restaurante_fiscal (restaurante_id, cedula_ruc) VALUES ($1, $2)', [idA, CEDULA]),
      ),
    ).rejects.toThrow();
    const upd = await h.db.scope({ tenantId: idB }, (q) =>
      q.query("UPDATE restaurante_fiscal SET cedula_ruc = '0100000017' WHERE restaurante_id = $1", [idA]),
    );
    expect(upd.rowCount).toBe(0);
    expect((await get(a)).json().cedulaRuc).toBe('******0993');

    // La auditoría copia filas de `restaurante` completas: la cédula no debe aparecer en ningún log del local.
    await patch(a, { cedulaRuc: '0100000017', direccion: 'Calle auditada' });
    const log = await h.db.service((q) =>
      q.query(
        'SELECT 1 FROM log_actividad WHERE tenant_restaurante_id = $1 AND (detalle_payload::text LIKE $2 OR detalle_payload::text LIKE $3)',
        [idA, `%${CEDULA}%`, '%0100000017%'],
      ),
    );
    expect(log.rowCount).toBe(0);
  });
});
