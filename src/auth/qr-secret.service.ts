import { Inject, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { DbService } from '../db/db.service';

const VERSION = 1;

/**
 * Secreto del QR de cada usuario. En base se guarda cifrado con AES-256-GCM (llave QR_SECRET_KEY, fuera del repo):
 * un volcado de la tabla no permite fabricar códigos. La tabla solo la toca el rol de servicio.
 */
@Injectable()
export class QrSecretService {
  private readonly logger = new Logger(QrSecretService.name);
  private readonly key: Buffer;

  constructor(
    private readonly db: DbService,
    @Inject(ENV) env: Env,
  ) {
    if (env.QR_SECRET_KEY) {
      this.key = Buffer.from(env.QR_SECRET_KEY, 'base64');
      if (this.key.length !== 32) throw new Error('QR_SECRET_KEY debe ser 32 bytes en base64 (genera una con pnpm keys:generate).');
    } else {
      // Solo desarrollo y pruebas (en producción la config la exige).
      this.key = createHash('sha256').update('bocadoo-llave-qr-solo-desarrollo').digest();
      this.logger.warn('QR_SECRET_KEY no definida: se usa una llave de desarrollo. No usar así en producción.');
    }
  }

  private encrypt(usuarioId: string, secret: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`qr:${usuarioId}`)); // atado al usuario: no se puede copiar el secreto de otro
    const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  private decrypt(usuarioId: string, blob: Buffer): Buffer {
    if (blob[0] !== VERSION || blob.length < 1 + 12 + 16 + 1) throw new Error('Formato de secreto QR desconocido.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(`qr:${usuarioId}`));
    decipher.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
  }

  /** Secreto del usuario o null si nunca generó su pase. */
  async get(usuarioId: string): Promise<Buffer | null> {
    const r = await this.db.service((q) =>
      q.query<{ secreto_cifrado: Buffer }>('SELECT secreto_cifrado FROM usuario_secreto_qr WHERE usuario_id = $1', [usuarioId]),
    );
    return r.rows[0] ? this.decrypt(usuarioId, r.rows[0].secreto_cifrado) : null;
  }

  async getOrCreate(usuarioId: string): Promise<Buffer> {
    const fresh = this.encrypt(usuarioId, randomBytes(32));
    const r = await this.db.service(async (q) => {
      // Si dos peticiones llegan a la vez, solo una inserta y ambas leen el mismo secreto.
      await q.query('INSERT INTO usuario_secreto_qr (usuario_id, secreto_cifrado) VALUES ($1, $2) ON CONFLICT (usuario_id) DO NOTHING', [
        usuarioId,
        fresh,
      ]);
      return q.query<{ secreto_cifrado: Buffer }>('SELECT secreto_cifrado FROM usuario_secreto_qr WHERE usuario_id = $1', [usuarioId]);
    });
    return this.decrypt(usuarioId, r.rows[0]!.secreto_cifrado);
  }

  /** Cambia el secreto: todos los códigos anteriores (p. ej. de un teléfono perdido) dejan de valer. */
  async rotate(usuarioId: string): Promise<void> {
    const fresh = this.encrypt(usuarioId, randomBytes(32));
    await this.db.service((q) =>
      q.query(
        `INSERT INTO usuario_secreto_qr (usuario_id, secreto_cifrado) VALUES ($1, $2)
         ON CONFLICT (usuario_id) DO UPDATE SET secreto_cifrado = EXCLUDED.secreto_cifrado, version = usuario_secreto_qr.version + 1, rotado_en = CURRENT_TIMESTAMP`,
        [usuarioId, fresh],
      ),
    );
  }
}
