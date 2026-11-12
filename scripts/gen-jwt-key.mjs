// Genera una llave ES256 (EC P-256) para firmar los access tokens.
// Uso: pnpm keys:generate [kid]   → pega las líneas en .env (local) o en las variables de Render. NUNCA en git.
import { generateKeyPairSync } from 'node:crypto';

const kid = process.argv[2] ?? `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim().replaceAll('\n', '\\n');
console.log(`JWT_KEY_ID=${kid}`);
console.log(`JWT_PRIVATE_KEY="${pem}"`);
console.log('\n# Al rotar: la llave anterior pasa a JWT_PREVIOUS_PUBLIC_KEYS (solo la pública) hasta que venzan sus tokens (15 min).');
