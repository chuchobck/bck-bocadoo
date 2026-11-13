import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    CORS_ORIGINS: z.string().default('http://localhost:3001'),
    DATABASE_URL: z.string().url(),
    DATABASE_SERVICE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // Autenticación
    JWT_PRIVATE_KEY: z.string().min(1).optional(), // PEM PKCS8 de una llave EC P-256; se admiten \n literales
    JWT_KEY_ID: z.string().min(1).max(64).default('k1'),
    JWT_PREVIOUS_PUBLIC_KEYS: z.string().optional(), // JSON {"kid":"PEM público"} para rotar sin cortar sesiones
    JWT_ISSUER: z.string().min(1).default('bocadoo'),
    JWT_AUDIENCE: z.string().min(1).default('bocadoo-api'),
    QR_SECRET_KEY: z.string().min(1).optional(), // 32 bytes en base64: cifra los secretos del QR de cada usuario
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    // Abuso
    BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(102_400),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120), // por IP y minuto, todos los endpoints
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5), // logins por IP+cuenta en la ventana
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
    INVITE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20), // altas de personal por IP y hora
    EVENTS_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(60), // lotes de eventos por IP y minuto
    EVENTS_USER_BATCHES_PER_MINUTE: z.coerce.number().int().min(1).default(20), // lotes por usuario y minuto
    SIGNUP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10), // registros por IP y hora
    SWAGGER_ENABLED: z.enum(['true', 'false']).optional(), // por defecto: encendido salvo en producción
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.JWT_PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['JWT_PRIVATE_KEY'], message: 'es obligatoria en producción' });
    }
    if (env.NODE_ENV === 'production' && !env.QR_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', path: ['QR_SECRET_KEY'], message: 'es obligatoria en producción' });
    }
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${detalle}`);
  }
  return parsed.data;
}
