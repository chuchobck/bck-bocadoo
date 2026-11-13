// Genera las llaves que la API necesita en producción:
//   · JWT_PRIVATE_KEY (ES256, EC P-256) para firmar los access tokens.
//   · QR_SECRET_KEY (32 bytes) para cifrar el secreto del QR de cada usuario.
// Uso: pnpm keys:generate [kid]   → pega las líneas en .env (local) o en las variables de Render. NUNCA en git.
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const kid = process.argv[2] ?? `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replaceAll('\n', '\\n');
console.log(`JWT_KEY_ID=${kid}`);
console.log(`JWT_PRIVATE_KEY="${pem}"`);
console.log(`QR_SECRET_KEY=${randomBytes(32).toString('base64')}`);
console.log('');
console.log('# Al rotar la llave JWT: la anterior pasa a JWT_PREVIOUS_PUBLIC_KEYS (solo la pública) hasta que venzan sus tokens (15 min).');
console.log('# QR_SECRET_KEY no se rota a la ligera: si cambia, cada usuario debe regenerar su pase.');
