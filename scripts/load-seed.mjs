// Prepara datos para la prueba de carga de la caja: un restaurante con su dueño y N clientes con plan.
// Uso: LOAD_PASSWORD='clave-de-10+' node scripts/load-seed.mjs [N=4000]
// Usa DATABASE_SERVICE_URL. SOLO contra una base de pruebas: crea miles de filas. Se niega a correr en producción.
import 'dotenv/config';
import { Algorithm, hash } from '@node-rs/argon2';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') throw new Error('No se ejecuta con NODE_ENV=production.');
const password = process.env.LOAD_PASSWORD;
if (!password || password.length < 10) throw new Error('Define LOAD_PASSWORD (mínimo 10 caracteres).');
const n = Number(process.argv[2] ?? 4000);
const tag = Date.now().toString(36);
const correo = `carga_${tag}@carga.bocadoo.test`;

const c = new pg.Client({ connectionString: process.env.DATABASE_SERVICE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  const u = (await c.query(`INSERT INTO usuario (nombre, correo) VALUES ('Dueño Carga', $1) RETURNING usuario_id`, [correo])).rows[0]
    .usuario_id;
  const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await c.query(`INSERT INTO usuario_identidad (usuario_id, proveedor, sujeto, password_hash) VALUES ($1, 'PASSWORD', $2, $3)`, [
    u,
    correo,
    passwordHash,
  ]);
  const r = (
    await c.query(
      `INSERT INTO restaurante (nombre, slug, pais_codigo, ciudad_id, moneda_codigo, zona_horaria, precio_suelto_centavos)
       VALUES ('Local de carga', $1, 'EC', 1, 'USD', 'America/Guayaquil', 300) RETURNING restaurante_id, public_id`,
      [`carga-${tag}`],
    )
  ).rows[0];
  await c.query(
    `INSERT INTO personal_restaurante (restaurante_id, usuario_id, rol, nombre_visible) VALUES ($1, $2, 'DUENO', 'Dueño Carga')`,
    [r.restaurante_id, u],
  );
  const ids = (
    await c.query(
      `INSERT INTO cliente_restaurante (restaurante_id, nombre) SELECT $1, 'Cliente carga ' || g FROM generate_series(1, $2::int) g RETURNING cliente_id`,
      [r.restaurante_id, n],
    )
  ).rows.map((x) => String(x.cliente_id));
  await c.query(
    `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, nombre_plan, almuerzos_totales, almuerzos_restantes, precio_pagado_centavos,
        precio_unitario_centavos, moneda_codigo, dias_validos, vence_el)
     SELECT $1, cliente_id, 'Plan carga', 20, 20, 6000, 300, 'USD', '{1,2,3,4,5,6,7}', CURRENT_DATE + 30 FROM cliente_restaurante WHERE restaurante_id = $1`,
    [r.restaurante_id],
  );
  await c.query('COMMIT');
  writeFileSync('test/load/.data.json', JSON.stringify({ correo, restaurante: r.public_id, clientes: ids }));
  console.log(`Listo: restaurante de carga con ${ids.length} clientes. Datos en test/load/.data.json (ignorado por git).`);
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  await c.end();
}
