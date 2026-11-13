// Solo desarrollo: asigna una contraseña a los usuarios de la demo (@demo.bocadoo.test) para poder entrar.
// Uso: DEMO_PASSWORD='clave-de-al-menos-10' pnpm db:demo-passwords
// Usa DATABASE_SERVICE_URL (bck_servicio). Se niega a correr en producción.
import 'dotenv/config';
import { Algorithm, hash } from '@node-rs/argon2';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  console.error('No se ejecuta con NODE_ENV=production.');
  process.exit(1);
}
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 10) {
  console.error('Define DEMO_PASSWORD (mínimo 10 caracteres).');
  process.exit(1);
}
const url = process.env.DATABASE_SERVICE_URL;
if (!url) {
  console.error('Falta DATABASE_SERVICE_URL en .env');
  process.exit(1);
}

const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const r = await c.query(
    `INSERT INTO usuario_identidad (usuario_id, proveedor, sujeto, password_hash)
     SELECT usuario_id, 'PASSWORD', correo, $1 FROM usuario WHERE correo LIKE '%@demo.bocadoo.test'
     ON CONFLICT (usuario_id, proveedor) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [passwordHash],
  );
  console.log(`Contraseña asignada a ${r.rowCount} usuarios demo (correo: usuario@demo.bocadoo.test).`);
} finally {
  await c.end();
}
