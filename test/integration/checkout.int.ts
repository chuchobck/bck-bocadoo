import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QrSecretService } from '../../src/auth/qr-secret.service';
import { issuePassCode } from '../../src/checkout/pass-code';
import { Actor, Harness, unique } from './harness';

const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

describe('Fase 7: caja', () => {
  const h = new Harness(75);
  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const as = (who: { token: string; restaurante?: string }) => {
    const send = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, key?: string) =>
      h.app.inject({
        method,
        url,
        payload,
        remoteAddress: h.ip(),
        headers: {
          authorization: `Bearer ${who.token}`,
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
  };
  const hoy = async (o: Actor) => (await as(o).get('/v1/menu/hoy')).json().fecha as string;
  const plan = async (o: Actor, extra: object = {}) =>
    (
      await as(o).post('/v1/planes', {
        tipo: 'SEMANAL',
        nombre: 'Semanal',
        almuerzos: 5,
        precioCentavos: 1500,
        vigenciaDias: 7,
        diasValidos: ALL_DAYS,
        ...extra,
      })
    ).json().id as string;
  const customer = async (o: Actor) => (await as(o).post('/v1/clientes', { nombre: `Cliente ${unique()}` })).json().id as string;
  const sellPlan = async (o: Actor, c: string, p: string, metodoPago = 'EFECTIVO') =>
    (await as(o).post(`/v1/clientes/${c}/planes`, { planId: p, metodoPago }, randomUUID())).json();
  /** Cliente nuevo con un plan de N almuerzos pagado en efectivo. */
  async function withPlan(o: Actor, extra: object = {}) {
    const p = await plan(o, extra);
    const c = await customer(o);
    await sellPlan(o, c, p);
    return c;
  }
  const validar = (who: Actor, body: object, key = randomUUID()) => as(who).post('/v1/caja/validar', body, key);
  const saldo = async (o: Actor, c: string) => (await as(o).get(`/v1/clientes/${c}`)).json().almuerzosDisponibles as number;
  const internalUser = async (publicId: string) =>
    String(
      (await h.db.service((q) => q.query<{ usuario_id: string }>('SELECT usuario_id FROM usuario WHERE public_id = $1', [publicId])))
        .rows[0]!.usuario_id,
    );
  /** Comensal con cuenta, vinculado como cliente del local y con plan. */
  async function dinerWithPlan(o: Actor, extra: object = {}) {
    const d = await h.diner();
    const c = await withPlan(o, extra);
    expect((await as(o).post(`/v1/clientes/${c}/vincular`, { correo: d.correo })).statusCode).toBe(200);
    return { ...d, clienteId: c };
  }
  const code = async (d: { token: string }, restaurante?: string) =>
    (await as(d).get(`/v1/pase/codigo${restaurante ? `?restaurante=${restaurante}` : ''}`)).json().codigo as string;

  describe('QR', () => {
    it('el comensal obtiene su código y la caja lo valida: descuenta un almuerzo', async () => {
      const o = await h.owner('QR Local');
      const d = await dinerWithPlan(o);
      const pase = await as(d).get(`/v1/pase/codigo?restaurante=${o.restaurante}`);
      expect(pase.statusCode).toBe(200);
      expect(pase.json()).toMatchObject({ validoSegundos: 30 });
      expect(new Date(pase.json().expiraEn).getTime()).toBeGreaterThan(Date.now());
      const res = await validar(o, { codigoQr: pase.json().codigo });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        resultado: 'OK',
        descontado: true,
        cliente: { id: d.clienteId },
        almuerzosRestantes: 4,
        plan: { nombre: 'Semanal' },
      });
      expect(new Date(res.json().consumo.deshacerHasta).getTime() - new Date(res.json().consumo.creadoEn).getTime()).toBe(10_000);
      expect(await saldo(o, d.clienteId)).toBe(4);
      // Un pase general (sin restaurante) también sirve; el cajero también valida.
      const d2 = await dinerWithPlan(o);
      const cashier = await h.cashier(o.restaurante);
      expect((await validar(cashier, { codigoQr: await code(d2) })).json().resultado).toBe('OK');
    });

    it('QR de otro local → OTRO_LOCAL; vencido → QR_EXPIRADO; falso → QR_INVALIDO; ninguno descuenta y todos quedan registrados', async () => {
      const a = await h.owner('QR A');
      const b = await h.owner('QR B');
      for (const o of [a, b]) {
        await as(o).patch('/v1/restaurante', { precioSueltoCentavos: 300 });
        await as(o).put('/v1/restaurante/horarios', { horarios: [{ diaSemana: 1, abre: '12:00', cierra: '15:00' }] });
        await as(o).post('/v1/restaurante/activar');
      }
      const d = await dinerWithPlan(a);
      const paraB = await code(d, b.restaurante);
      expect((await validar(a, { codigoQr: paraB })).json()).toMatchObject({ resultado: 'OTRO_LOCAL', descontado: false, consumo: null });

      const secret = await h.app.get(QrSecretService).getOrCreate(await internalUser(d.usuarioId));
      const viejo = issuePassCode(secret, d.usuarioId, a.restaurante, Date.now() - 5 * 60_000);
      expect((await validar(a, { codigoQr: viejo })).json().resultado).toBe('QR_EXPIRADO');
      const pasoAnterior = issuePassCode(secret, d.usuarioId, a.restaurante, Date.now() - 30_000);
      const d0 = await saldo(a, d.clienteId);
      expect((await validar(a, { codigoQr: pasoAnterior })).json().resultado).toBe('OK'); // un paso de tolerancia
      expect(await saldo(a, d.clienteId)).toBe(d0 - 1);

      const bueno = await code(d, a.restaurante);
      const alterado = bueno.slice(0, -1) + (bueno.endsWith('A') ? 'B' : 'A');
      for (const falso of [
        alterado,
        'no-es-un-codigo',
        `BCD1.${randomUUID()}.0.${'a'.repeat(22)}`,
        bueno.replace(d.usuarioId, a.usuarioId),
      ]) {
        expect((await validar(a, { codigoQr: falso })).json().resultado).toBe('QR_INVALIDO');
      }
      expect(await saldo(a, d.clienteId)).toBe(d0 - 1);
      const log = await h.db.service((q) =>
        q.query<{ resultado: string; n: string }>(
          `SELECT resultado, count(*) AS n FROM intento_escaneo i JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1 GROUP BY 1`,
          [a.restaurante],
        ),
      );
      const counts = Object.fromEntries(log.rows.map((r) => [r.resultado, Number(r.n)]));
      expect(counts).toMatchObject({ OTRO_LOCAL: 1, QR_EXPIRADO: 1, QR_INVALIDO: 4 });
    });

    it('con cuenta pero sin ser cliente del local → SIN_PLAN; rotar el secreto invalida los códigos anteriores', async () => {
      const o = await h.owner('QR Rotar');
      const stranger = await h.diner();
      expect((await validar(o, { codigoQr: await code(stranger) })).json().resultado).toBe('SIN_PLAN');
      const d = await dinerWithPlan(o);
      const antes = await code(d);
      expect((await as(d).post('/v1/pase/rotar')).statusCode).toBe(204);
      expect((await validar(o, { codigoQr: antes })).json().resultado).toBe('QR_INVALIDO');
      expect((await validar(o, { codigoQr: await code(d) })).json().resultado).toBe('OK');
      expect((await h.app.inject({ method: 'GET', url: '/v1/pase/codigo', remoteAddress: h.ip() })).statusCode).toBe(401);
      expect((await as(d).get(`/v1/pase/codigo?restaurante=${randomUUID()}`)).statusCode).toBe(404);
    });

    it('el secreto del QR se guarda cifrado y atado a su usuario', async () => {
      const d = await h.diner();
      await code(d);
      const uid = await internalUser(d.usuarioId);
      const svc = h.app.get(QrSecretService);
      const secret = await svc.getOrCreate(uid);
      const stored = (
        await h.db.service((q) =>
          q.query<{ secreto_cifrado: Buffer }>('SELECT secreto_cifrado FROM usuario_secreto_qr WHERE usuario_id = $1', [uid]),
        )
      ).rows[0]!.secreto_cifrado;
      expect(stored.includes(secret)).toBe(false);
      expect(stored.length).toBe(1 + 12 + 16 + 32);
      // Copiar el secreto cifrado de un usuario a otro no funciona (AAD con el id del usuario).
      const other = await internalUser((await h.diner()).usuarioId);
      await h.db.service((q) => q.query('INSERT INTO usuario_secreto_qr (usuario_id, secreto_cifrado) VALUES ($1, $2)', [other, stored]));
      await expect(svc.get(other)).rejects.toThrow();
      await expect(h.db.scope({ tenantId: '1' }, (q) => q.query('SELECT 1 FROM usuario_secreto_qr'))).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('validar un almuerzo', () => {
    it('búsqueda manual; exige Idempotency-Key y exactamente un identificador', async () => {
      const o = await h.owner('Manual');
      const c = await withPlan(o);
      const res = await validar(o, { clienteId: c, paraLlevar: true });
      expect(res.json()).toMatchObject({ resultado: 'OK', descontado: true, almuerzosRestantes: 4 });
      expect((await as(o).post('/v1/caja/validar', { clienteId: c })).statusCode).toBe(400);
      expect((await validar(o, {})).statusCode).toBe(400);
      expect((await validar(o, { clienteId: c, codigoQr: 'x' })).statusCode).toBe(400);
      expect((await validar(o, { clienteId: '99999999' })).statusCode).toBe(404);
      expect((await validar(o, { clienteId: c, mesaLocalId: '99999999' })).statusCode).toBe(400);
    });

    it('FIFO: descuenta del plan que vence primero, aunque se haya comprado después', async () => {
      const o = await h.owner('FIFO');
      const largo = await plan(o, { nombre: 'Mensual', almuerzos: 20, vigenciaDias: 30 });
      const corto = await plan(o, { nombre: 'Corto', almuerzos: 2, vigenciaDias: 3 });
      const c = await customer(o);
      await sellPlan(o, c, largo);
      await sellPlan(o, c, corto);
      const r1 = (await validar(o, { clienteId: c })).json();
      expect(r1).toMatchObject({ resultado: 'OK_ADVERTENCIA', plan: { nombre: 'Corto' }, almuerzosRestantes: 21 }); // vence en ≤ 3 días
      const planes = (await as(o).get(`/v1/clientes/${c}`)).json().planes;
      expect(planes.find((p: { nombrePlan: string }) => p.nombrePlan === 'Corto').almuerzosRestantes).toBe(1);
      expect(planes.find((p: { nombrePlan: string }) => p.nombrePlan === 'Mensual').almuerzosRestantes).toBe(20);
    });

    it('doble escaneo en menos de 60 s → DUPLICADO y no descuenta', async () => {
      const o = await h.owner('Duplicado');
      const c = await withPlan(o);
      expect((await validar(o, { clienteId: c })).json().resultado).toBe('OK');
      const dup = (await validar(o, { clienteId: c })).json();
      expect(dup).toMatchObject({ resultado: 'DUPLICADO', descontado: false, consumo: null, almuerzosRestantes: 4 });
      expect(await saldo(o, c)).toBe(4);
    });

    it('la misma Idempotency-Key devuelve el mismo consumo sin descontar otra vez; con otro cliente → 409', async () => {
      const o = await h.owner('Idem Caja');
      const c = await withPlan(o);
      const other = await withPlan(o);
      const key = randomUUID();
      const a = (await validar(o, { clienteId: c }, key)).json();
      const b = (await validar(o, { clienteId: c }, key)).json();
      expect(b.consumo.id).toBe(a.consumo.id);
      expect(b.descontado).toBe(true);
      expect(await saldo(o, c)).toBe(4);
      expect((await validar(o, { clienteId: other }, key)).statusCode).toBe(409);
      expect(await saldo(o, other)).toBe(5);
    });

    it('el mismo comensal en dos cajas a la vez → un solo descuento', async () => {
      const o = await h.owner('Dos Cajas');
      const cashier = await h.cashier(o.restaurante);
      const c = await withPlan(o);
      const burst = await Promise.all([o, cashier, o, cashier, o, cashier].map((who) => validar(who, { clienteId: c })));
      const results = burst.map((r) => r.json().resultado);
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      expect(results.filter((r) => r === 'DUPLICADO')).toHaveLength(5);
      expect(await saldo(o, c)).toBe(4);
      // La misma clave en paralelo (reintento de red): un solo consumo.
      const c2 = await withPlan(o);
      const key = randomUUID();
      const same = await Promise.all(Array.from({ length: 6 }, () => validar(o, { clienteId: c2 }, key)));
      expect(same.every((r) => r.statusCode === 200)).toBe(true);
      expect(new Set(same.map((r) => r.json().consumo?.id).filter(Boolean)).size).toBe(1);
      expect(await saldo(o, c2)).toBe(4);
    });

    it('SIN_PLAN, SIN_SALDO, VENCIDO, DIA_NO_VALIDO y LIMITE_SAAS: ninguno descuenta', async () => {
      const o = await h.owner('Resultados');
      const sinPlan = await customer(o);
      expect((await validar(o, { clienteId: sinPlan })).json().resultado).toBe('SIN_PLAN');

      const uno = await withPlan(o, { almuerzos: 1 });
      expect((await validar(o, { clienteId: uno })).json()).toMatchObject({ resultado: 'OK_ADVERTENCIA', almuerzosRestantes: 0 }); // era el último
      const agotado = await customer(o);
      await h.db.service((q) =>
        q.query(
          `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, nombre_plan, almuerzos_totales, almuerzos_restantes, precio_pagado_centavos, precio_unitario_centavos, moneda_codigo, vence_el, estado)
           SELECT r.restaurante_id, $2, 'Agotado', 5, 0, 1500, 300, 'USD', CURRENT_DATE + 5, 'AGOTADA' FROM restaurante r WHERE r.public_id = $1`,
          [o.restaurante, agotado],
        ),
      );
      expect((await validar(o, { clienteId: agotado })).json().resultado).toBe('SIN_SALDO');

      const vencido = await customer(o);
      await h.db.service((q) =>
        q.query(
          `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, nombre_plan, almuerzos_totales, almuerzos_restantes, precio_pagado_centavos, precio_unitario_centavos, moneda_codigo, vence_el, estado)
           SELECT r.restaurante_id, $2, 'Vencido', 5, 3, 1500, 300, 'USD', CURRENT_DATE - 3, 'VENCIDA' FROM restaurante r WHERE r.public_id = $1`,
          [o.restaurante, vencido],
        ),
      );
      expect((await validar(o, { clienteId: vencido })).json().resultado).toBe('VENCIDO');

      const dow = (
        await h.db.service((q) => q.query<{ d: number }>(`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Guayaquil'))::int AS d`))
      ).rows[0]!.d;
      const otroDia = await withPlan(o, { diasValidos: [dow === 7 ? 1 : dow + 1] });
      expect((await validar(o, { clienteId: otroDia })).json()).toMatchObject({ resultado: 'DIA_NO_VALIDO', descontado: false });
      expect(await saldo(o, otroDia)).toBe(5);

      // Plan Bocadoo suspendido → LIMITE_SAAS.
      const conPlan = await withPlan(o);
      await h.db.service((q) =>
        q.query(
          `INSERT INTO suscripcion_saas_restaurante (restaurante_id, plan_saas_id, estado, fin_ciclo_actual)
           SELECT r.restaurante_id, 1, 'SUSPENDIDA', CURRENT_DATE + 30 FROM restaurante r WHERE r.public_id = $1`,
          [o.restaurante],
        ),
      );
      expect((await validar(o, { clienteId: conPlan })).json()).toMatchObject({ resultado: 'LIMITE_SAAS', descontado: false });
      expect(await saldo(o, conPlan)).toBe(5);
    });

    it('Swagger documenta todos los resultados del escáner', async () => {
      const doc = (await h.app.inject({ method: 'GET', url: '/docs-json', remoteAddress: h.ip() })).json();
      const op = doc.paths['/v1/caja/validar'].post;
      for (const r of [
        'OK',
        'OK_ADVERTENCIA',
        'DUPLICADO',
        'SIN_PLAN',
        'SIN_SALDO',
        'VENCIDO',
        'DIA_NO_VALIDO',
        'OTRO_LOCAL',
        'QR_EXPIRADO',
        'QR_INVALIDO',
        'LIMITE_SAAS',
      ]) {
        expect(op.description).toContain(`**${r}**`);
      }
      expect(doc.components.schemas.ValidacionResponse.properties.resultado.enum).toHaveLength(11);
      expect(op.parameters.some((p: { name: string; required: boolean }) => p.name === 'Idempotency-Key' && p.required)).toBe(true);
    });
  });

  describe('deshacer', () => {
    it('dentro de 10 s devuelve el almuerzo; repetir o hacerlo dos veces a la vez no devuelve dos; luego se puede validar de nuevo', async () => {
      const o = await h.owner('Deshacer Caja');
      const c = await withPlan(o, { almuerzos: 1 });
      const v = (await validar(o, { clienteId: c })).json();
      expect(await saldo(o, c)).toBe(0);
      const [u1, u2, u3] = await Promise.all([1, 2, 3].map(() => as(o).post(`/v1/caja/consumos/${v.consumo.id}/deshacer`)));
      for (const u of [u1, u2, u3]) expect(u!.json()).toEqual({ id: v.consumo.id, revertido: true });
      expect(await saldo(o, c)).toBe(1); // volvió uno solo y el plan AGOTADA volvió a ACTIVA
      expect((await as(o).post(`/v1/caja/consumos/${v.consumo.id}/deshacer`)).statusCode).toBe(200);
      expect(await saldo(o, c)).toBe(1);
      // Tras deshacer no cuenta como duplicado.
      expect((await validar(o, { clienteId: c })).json().descontado).toBe(true);
    });

    it('pasados 10 s → 409; no se puede deshacer un consumo de otro local ni un reverso', async () => {
      const o = await h.owner('Deshacer Tarde');
      const other = await h.owner('Deshacer Otro');
      const c = await withPlan(o);
      // Consumo de hace 11 s (cargado directo: los consumos no se pueden editar).
      const viejo = (
        await h.db.service((q) =>
          q.query<{ public_id: string }>(
            `INSERT INTO consumo_almuerzo (restaurante_id, suscripcion_id, cliente_id, personal_id, valor_unitario_centavos, clave_idempotencia, fecha_local, creado_en)
           SELECT s.restaurante_id, s.suscripcion_id, s.cliente_id, p.personal_id, 300, gen_random_uuid(), CURRENT_DATE, now() - interval '11 seconds'
             FROM suscripcion_plan s JOIN personal_restaurante p ON p.restaurante_id = s.restaurante_id WHERE s.cliente_id = $1 RETURNING public_id`,
            [c],
          ),
        )
      ).rows[0]!.public_id;
      const late = await as(o).post(`/v1/caja/consumos/${viejo}/deshacer`);
      expect(late.statusCode).toBe(409);
      expect(late.json().detail).toContain('10 segundos');
      const c2 = await withPlan(o);
      const v = (await validar(o, { clienteId: c2 })).json();
      expect((await as(other).post(`/v1/caja/consumos/${v.consumo.id}/deshacer`)).statusCode).toBe(404);
      expect((await as(o).post(`/v1/caja/consumos/${randomUUID()}/deshacer`)).statusCode).toBe(404);
      expect(await saldo(o, c2)).toBe(4);
    });

    it('los consumos son libro de solo inserción', async () => {
      await expect(
        h.db.service((q) =>
          q.query('UPDATE consumo_almuerzo SET cantidad = 1 WHERE consumo_id = (SELECT min(consumo_id) FROM consumo_almuerzo)'),
        ),
      ).rejects.toThrow();
      await expect(h.db.scope({ tenantId: '1' }, (q) => q.query('DELETE FROM consumo_almuerzo WHERE false'))).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  describe('mesa compartida', () => {
    async function table(
      o: Actor,
      modo: 'CADA_UNO' | 'INVITO_YO',
      members: { usuarioPublicId?: string; nombre: string; anfitrion?: boolean; paraLlevar?: boolean }[],
    ) {
      const host = members.find((m) => m.anfitrion)!;
      return h.db.service(async (q) => {
        const m = (
          await q.query<{ mesa_compartida_id: string; public_id: string; restaurante_id: string }>(
            `INSERT INTO mesa_compartida (restaurante_id, anfitrion_usuario_id, hora_llegada, modo)
           SELECT r.restaurante_id, u.usuario_id, now() + interval '20 minutes', $3::modo_mesa_enum FROM restaurante r, usuario u WHERE r.public_id = $1 AND u.public_id = $2
           RETURNING mesa_compartida_id, public_id, restaurante_id`,
            [o.restaurante, host.usuarioPublicId, modo],
          )
        ).rows[0]!;
        for (const mem of members) {
          await q.query(
            `INSERT INTO mesa_compartida_miembro (mesa_compartida_id, restaurante_id, usuario_id, nombre, es_anfitrion, para_llevar)
             VALUES ($1, $2, (SELECT usuario_id FROM usuario WHERE public_id = $3), $4, $5, $6)`,
            [
              m.mesa_compartida_id,
              m.restaurante_id,
              mem.usuarioPublicId ?? null,
              mem.nombre,
              mem.anfitrion ?? false,
              mem.paraLlevar ?? false,
            ],
          );
        }
        return m.public_id;
      });
    }

    it('CADA_UNO: cada quien paga con su plan; quien no tiene queda por cobrar; repetir no descuenta otra vez', async () => {
      const o = await h.owner('Mesa Cada Uno');
      const ana = await dinerWithPlan(o);
      const beto = await dinerWithPlan(o);
      const sinPlan = await h.diner();
      const mesa = await table(o, 'CADA_UNO', [
        { usuarioPublicId: ana.usuarioId, nombre: 'Ana', anfitrion: true },
        { usuarioPublicId: beto.usuarioId, nombre: 'Beto', paraLlevar: true },
        { usuarioPublicId: sinPlan.usuarioId, nombre: 'Caro' },
        { nombre: 'Invitado sin cuenta' },
      ]);
      const preview = (await as(o).get(`/v1/caja/mesas/${mesa}`)).json();
      expect(preview).toMatchObject({ modo: 'CADA_UNO', personas: 4, cubiertos: 2, validadaEn: null });
      expect(preview.miembros.map((m: { tieneCuenta: boolean }) => m.tieneCuenta)).toEqual([true, true, false, false]);
      const key = randomUUID();
      const res = await as(o).post(`/v1/caja/mesas/${mesa}/validar`, undefined, key);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ yaValidada: false, descontados: 2, porCobrar: 2, estado: 'EN_MESA' });
      expect(res.json().resultados.map((r: { resultado: string }) => r.resultado)).toEqual(['OK', 'OK', 'SIN_PLAN', 'SIN_PLAN']);
      expect(await saldo(o, ana.clienteId)).toBe(4);
      expect(await saldo(o, beto.clienteId)).toBe(4);
      for (const k of [key, randomUUID()]) {
        expect((await as(o).post(`/v1/caja/mesas/${mesa}/validar`, undefined, k)).json().yaValidada).toBe(true);
      }
      expect(await saldo(o, ana.clienteId)).toBe(4);
      const other = await h.owner('Mesa Ajena');
      expect((await as(other).get(`/v1/caja/mesas/${mesa}`)).statusCode).toBe(404);
      expect((await as(other).post(`/v1/caja/mesas/${mesa}/validar`, undefined, randomUUID())).statusCode).toBe(404);
    });

    it('INVITO_YO: el anfitrión paga todos; si no le alcanza, el resto queda por cobrar', async () => {
      const o = await h.owner('Mesa Invito');
      const host = await dinerWithPlan(o, { almuerzos: 2, vigenciaDias: 30 });
      const mesa = await table(o, 'INVITO_YO', [
        { usuarioPublicId: host.usuarioId, nombre: 'Anfitrión', anfitrion: true },
        { nombre: 'Invitado 1' },
        { nombre: 'Invitado 2' },
      ]);
      expect((await as(o).get(`/v1/caja/mesas/${mesa}`)).json()).toMatchObject({ modo: 'INVITO_YO', personas: 3, cubiertos: 2 });
      const res = (await as(o).post(`/v1/caja/mesas/${mesa}/validar`, undefined, randomUUID())).json();
      expect(res.resultados.map((r: { resultado: string }) => r.resultado)).toEqual(['OK', 'OK_ADVERTENCIA', 'SIN_SALDO']);
      expect(res).toMatchObject({ descontados: 2, porCobrar: 1 });
      expect(await saldo(o, host.clienteId)).toBe(0);
    });

    it('dos cajas validan la misma mesa a la vez: se descuenta una sola vez', async () => {
      const o = await h.owner('Mesa Carrera');
      const cashier = await h.cashier(o.restaurante);
      const ana = await dinerWithPlan(o);
      const mesa = await table(o, 'CADA_UNO', [{ usuarioPublicId: ana.usuarioId, nombre: 'Ana', anfitrion: true }]);
      const race = await Promise.all(
        [o, cashier, o, cashier].map((w) => as(w).post(`/v1/caja/mesas/${mesa}/validar`, undefined, randomUUID())),
      );
      expect(race.every((r) => r.statusCode === 200)).toBe(true);
      expect(race.filter((r) => r.json().yaValidada === false)).toHaveLength(1);
      expect(await saldo(o, ana.clienteId)).toBe(4);
    });
  });

  describe('ventas sueltas (POS)', () => {
    async function posLocal(nombre: string) {
      const o = await h.owner(nombre);
      await as(o).patch('/v1/restaurante', { precioSueltoCentavos: 350, recargoParaLlevarCentavos: 25 });
      return o;
    }
    const vender = (who: Actor, body: object, key = randomUUID()) => as(who).post('/v1/caja/ventas', body, key);

    it('los precios los pone el servidor; almuerzo + plato + cobro libre + recargo para llevar', async () => {
      const o = await posLocal('POS Precios');
      const jugo = (await as(o).post('/v1/menu/platos', { categoria: 'BEBIDA', nombre: 'Jugo', precioCentavos: 100 })).json().id;
      const soloMenu = (await as(o).post('/v1/menu/platos', { categoria: 'ALMUERZO', nombre: 'Sopa del día' })).json().id;
      const res = await vender(o, {
        metodoPago: 'EFECTIVO',
        paraLlevar: true,
        mesaTexto: 'Barra',
        items: [
          { tipo: 'ALMUERZO', cantidad: 2, precioUnitarioCentavos: 1 }, // el precio enviado se ignora
          { tipo: 'PLATO', platoId: jugo, cantidad: 3, precioUnitarioCentavos: 1 },
          { tipo: 'LIBRE', nombre: 'Propina', precioUnitarioCentavos: 50, cantidad: 1 },
        ],
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        ticket: 1,
        totalCentavos: 2 * 350 + 3 * 100 + 50 + 2 * 25,
        pago: { estado: 'CONFIRMADO', metodo: 'EFECTIVO' },
        deshecha: false,
      });
      expect(res.json().items.map((i: { nombre: string; subtotalCentavos: number }) => [i.nombre, i.subtotalCentavos])).toEqual([
        ['Almuerzo', 700],
        ['Jugo', 300],
        ['Propina', 50],
        ['Recargo para llevar', 50],
      ]);
      const bad = (items: object[]) => vender(o, { metodoPago: 'EFECTIVO', items });
      expect((await bad([{ tipo: 'PLATO', platoId: soloMenu, cantidad: 1 }])).statusCode).toBe(400);
      expect((await bad([{ tipo: 'PLATO', cantidad: 1 }])).statusCode).toBe(400);
      expect((await bad([{ tipo: 'LIBRE', nombre: 'Sin precio', cantidad: 1 }])).statusCode).toBe(400);
      expect((await bad([{ tipo: 'LIBRE', nombre: 'Gratis', precioUnitarioCentavos: 0, cantidad: 1 }])).statusCode).toBe(400);
      expect((await bad([{ tipo: 'ALMUERZO', cantidad: 0 }])).statusCode).toBe(400);
      expect((await bad([])).statusCode).toBe(400);
      expect((await as(o).post('/v1/caja/ventas', { metodoPago: 'EFECTIVO', items: [{ tipo: 'ALMUERZO', cantidad: 1 }] })).statusCode).toBe(
        400,
      );
    });

    it('tickets consecutivos sin huecos ni repetidos con 10 ventas simultáneas; idempotencia', async () => {
      const o = await posLocal('POS Tickets');
      const cashier = await h.cashier(o.restaurante);
      const body = { metodoPago: 'EFECTIVO', items: [{ tipo: 'ALMUERZO', cantidad: 1 }] };
      const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => vender(i % 2 ? o : cashier, body)));
      expect(burst.every((r) => r.statusCode === 201)).toBe(true);
      expect(burst.map((r) => r.json().ticket).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const key = randomUUID();
      const same = await Promise.all(Array.from({ length: 5 }, () => vender(o, body, key)));
      expect(same.every((r) => r.statusCode === 201)).toBe(true);
      expect(new Set(same.map((r) => r.json().id)).size).toBe(1);
      expect((await as(o).get('/v1/caja/ventas')).json()).toHaveLength(11);
    });

    it('deshacer registra venta y pago inversos; una sola vez aunque se pida en paralelo; un pendiente se rechaza', async () => {
      const o = await posLocal('POS Deshacer');
      const other = await posLocal('POS Otro');
      const v = (await vender(o, { metodoPago: 'EFECTIVO', items: [{ tipo: 'ALMUERZO', cantidad: 2 }] })).json();
      const undo = await Promise.all([1, 2, 3].map(() => as(o).post(`/v1/caja/ventas/${v.id}/deshacer`, undefined, randomUUID())));
      expect(undo.every((r) => r.statusCode === 200 && r.json().deshecha === true)).toBe(true);
      const rows = await h.db.service((q) =>
        q.query<{ total_centavos: string; pagos: string }>(
          `SELECT v.total_centavos, (SELECT COALESCE(sum(p.monto_centavos), 0) FROM transaccion_pago p WHERE p.venta_pos_id = v.venta_pos_id) AS pagos
             FROM venta_pos_cabecera v JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1 ORDER BY v.venta_pos_id`,
          [o.restaurante],
        ),
      );
      expect(rows.rows.map((r) => [Number(r.total_centavos), Number(r.pagos)])).toEqual([
        [700, 700],
        [-700, -700],
      ]);
      expect((await as(other).post(`/v1/caja/ventas/${v.id}/deshacer`, undefined, randomUUID())).statusCode).toBe(404);
      const t = (await vender(o, { metodoPago: 'TRANSFERENCIA', items: [{ tipo: 'ALMUERZO', cantidad: 1 }] })).json();
      expect(t.pago.estado).toBe('PENDIENTE');
      expect((await as(o).post(`/v1/caja/ventas/${t.id}/deshacer`, undefined, randomUUID())).json()).toMatchObject({
        deshecha: true,
        pago: { estado: 'RECHAZADO' },
      });
    });
  });

  describe('cierre de caja', () => {
    it('efectivo esperado = cobros en efectivo del día (planes + ventas) menos reversos; un cierre activo por día', async () => {
      const o = await h.owner('Cierre');
      const cashier = await h.cashier(o.restaurante);
      await as(o).patch('/v1/restaurante', { precioSueltoCentavos: 300 });
      const p = await plan(o); // 1500
      const [c1, c2, c3] = [await customer(o), await customer(o), await customer(o)];
      await sellPlan(o, c1, p); // +1500 efectivo
      const deshecho = await sellPlan(cashier, c2, p); // +1500 efectivo
      await as(o).post(`/v1/planes-vendidos/${deshecho.id}/deshacer`, {}, randomUUID()); // −1500
      await sellPlan(o, c3, p, 'TRANSFERENCIA'); // pendiente: no cuenta
      const confirmada = await sellPlan(o, c3, p, 'DEUNA');
      await as(o).post(`/v1/pagos/${confirmada.pago.id}/confirmar`); // +1500 Deuna (no es efectivo)
      await as(o).post(
        '/v1/caja/ventas',
        { metodoPago: 'EFECTIVO', paraLlevar: true, items: [{ tipo: 'ALMUERZO', cantidad: 2 }] },
        randomUUID(),
      ); // +600
      const v = (
        await as(o).post('/v1/caja/ventas', { metodoPago: 'EFECTIVO', items: [{ tipo: 'ALMUERZO', cantidad: 1 }] }, randomUUID())
      ).json(); // +300
      await as(o).post(`/v1/caja/ventas/${v.id}/deshacer`, undefined, randomUUID()); // −300
      await validar(o, { clienteId: c1, paraLlevar: true }); // 1 almuerzo con plan

      const arqueo = (await as(cashier).get('/v1/caja/cierre/hoy')).json();
      expect(arqueo).toMatchObject({
        efectivoEsperadoCentavos: 2100,
        totalCentavos: 3600,
        pagosPendientes: 1,
        almuerzosConPlan: 1,
        almuerzosSueltos: 2,
        almuerzosServidos: 3,
        almuerzosParaLlevar: 3,
        cierre: null,
      });
      expect(arqueo.porMetodo).toEqual([
        { metodo: 'EFECTIVO', nombre: 'Efectivo', esEfectivo: true, planesCentavos: 1500, posCentavos: 600, totalCentavos: 2100 },
        { metodo: 'DEUNA', nombre: 'Deuna', esEfectivo: false, planesCentavos: 1500, posCentavos: 0, totalCentavos: 1500 },
      ]);

      const cierre = await as(cashier).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: 2000, nota: 'Faltó un dólar' });
      expect(cierre.statusCode).toBe(201);
      expect(cierre.json().cierre).toMatchObject({
        efectivoEsperadoCentavos: 2100,
        efectivoContadoCentavos: 2000,
        diferenciaCentavos: -100,
        nota: 'Faltó un dólar',
        movimientosDespuesDelCierre: false,
      });
      expect((await as(o).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: 2100 })).statusCode).toBe(409);
      // Un cobro después del cierre se nota.
      await as(o).post('/v1/caja/ventas', { metodoPago: 'EFECTIVO', items: [{ tipo: 'ALMUERZO', cantidad: 1 }] }, randomUUID());
      expect((await as(o).get('/v1/caja/cierre/hoy')).json().cierre.movimientosDespuesDelCierre).toBe(true);
      // Solo el dueño reabre; luego se puede cerrar de nuevo.
      expect((await as(cashier).post('/v1/caja/cierre/hoy/reabrir')).statusCode).toBe(403);
      expect((await as(o).post('/v1/caja/cierre/hoy/reabrir')).json().cierre).toBeNull();
      expect((await as(o).post('/v1/caja/cierre/hoy/reabrir')).statusCode).toBe(404);
      const again = await as(o).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: 2400 });
      expect(again.json().cierre).toMatchObject({ efectivoEsperadoCentavos: 2400, diferenciaCentavos: 0 });
      const detalle = await h.db.service((q) =>
        q.query<{ n: string }>(
          `SELECT count(*) AS n FROM cierre_caja_cabecera c JOIN restaurante r USING (restaurante_id) WHERE r.public_id = $1`,
          [o.restaurante],
        ),
      );
      expect(Number(detalle.rows[0]!.n)).toBe(2); // el cierre anterior queda en el historial
    });

    it('validaciones: día futuro, cajero en otro día, monto negativo; dos cierres a la vez → uno solo', async () => {
      const o = await h.owner('Cierre Reglas');
      const cashier = await h.cashier(o.restaurante);
      const today = await hoy(o);
      expect((await as(o).post(`/v1/caja/cierre/${addDays(today, 1)}`, { efectivoContadoCentavos: 0 })).statusCode).toBe(409);
      expect((await as(cashier).post(`/v1/caja/cierre/${addDays(today, -1)}`, { efectivoContadoCentavos: 0 })).statusCode).toBe(403);
      expect((await as(o).post(`/v1/caja/cierre/${addDays(today, -1)}`, { efectivoContadoCentavos: 0 })).statusCode).toBe(201);
      expect((await as(o).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: -1 })).statusCode).toBe(400);
      expect((await as(o).post('/v1/caja/cierre/2026-02-31', { efectivoContadoCentavos: 0 })).statusCode).toBe(400);
      const race = await Promise.all([o, cashier, o].map((w) => as(w).post('/v1/caja/cierre/hoy', { efectivoContadoCentavos: 0 })));
      expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      const other = await h.owner('Cierre Otro');
      expect((await as(other).get('/v1/caja/cierre/hoy')).json().cierre).toBeNull();
    });
  });

  describe('reclamos', () => {
    async function claim(o: Actor, clienteId: string, consumoPublicId: string) {
      return String(
        (
          await h.db.service((q) =>
            q.query<{ reclamo_id: string }>(
              `INSERT INTO reclamo (restaurante_id, consumo_id, cliente_id, mensaje)
           SELECT k.restaurante_id, k.consumo_id, k.cliente_id, 'Me descontaron y no almorcé' FROM consumo_almuerzo k WHERE k.public_id = $1 AND k.cliente_id = $2 RETURNING reclamo_id`,
              [consumoPublicId, clienteId],
            ),
          )
        ).rows[0]!.reclamo_id,
      );
    }

    it('aceptar devuelve el almuerzo al plan (una sola vez); rechazar exige explicación; el cajero no resuelve', async () => {
      const o = await h.owner('Reclamos');
      const cashier = await h.cashier(o.restaurante);
      const other = await h.owner('Reclamos Otro');
      const c = await withPlan(o);
      const v = (await validar(o, { clienteId: c })).json();
      const id = await claim(o, c, v.consumo.id);
      const list = (await as(cashier).get('/v1/reclamos')).json();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, estado: 'PENDIENTE', cliente: { id: c }, consumo: { id: v.consumo.id, plan: 'Semanal' } });
      expect((await as(other).get('/v1/reclamos')).json()).toEqual([]);
      expect((await as(cashier).post(`/v1/reclamos/${id}/devolver`, {})).statusCode).toBe(403);
      expect((await as(other).post(`/v1/reclamos/${id}/devolver`, {})).statusCode).toBe(404);
      const both = await Promise.all(
        [1, 2].map(() => as(o).post(`/v1/reclamos/${id}/devolver`, { respuesta: 'Disculpa, ya lo devolvimos.' })),
      );
      expect(both.every((r) => r.statusCode === 200 && r.json().estado === 'DEVUELTO')).toBe(true);
      expect(await saldo(o, c)).toBe(5);
      expect((await as(o).post(`/v1/reclamos/${id}/rechazar`, { respuesta: 'No' })).statusCode).toBe(409);
      expect((await as(o).get('/v1/reclamos')).json()).toEqual([]);
      expect((await as(o).get('/v1/reclamos?estado=DEVUELTO')).json()).toHaveLength(1);

      const c2 = await withPlan(o);
      const v2 = (await validar(o, { clienteId: c2 })).json();
      const id2 = await claim(o, c2, v2.consumo.id);
      expect((await as(o).post(`/v1/reclamos/${id2}/rechazar`, {})).statusCode).toBe(400);
      expect((await as(o).post(`/v1/reclamos/${id2}/rechazar`, { respuesta: 'Sí se sirvió.' })).json()).toMatchObject({
        estado: 'RECHAZADO',
        respuesta: 'Sí se sirvió.',
      });
      expect((await as(o).post(`/v1/reclamos/${id2}/devolver`, {})).statusCode).toBe(409);
      expect(await saldo(o, c2)).toBe(4);
    });

    it('si el almuerzo ya se había devuelto (deshacer), aceptar el reclamo no lo devuelve otra vez', async () => {
      const o = await h.owner('Reclamo Doble');
      const c = await withPlan(o);
      const v = (await validar(o, { clienteId: c })).json();
      const id = await claim(o, c, v.consumo.id);
      await as(o).post(`/v1/caja/consumos/${v.consumo.id}/deshacer`);
      const res = await as(o).post(`/v1/reclamos/${id}/devolver`, {});
      expect(res.statusCode).toBe(409);
      expect(await saldo(o, c)).toBe(5);
    });
  });
});
