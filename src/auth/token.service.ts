import { Inject, Injectable, Logger } from '@nestjs/common';
import { SignJWT, jwtVerify, errors } from 'jose';
import { KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export interface AccessClaims {
  /** public_id (UUID) del usuario. */
  sub: string;
  /** usuario_id interno: solo viaja dentro del token, nunca en respuestas. */
  uid: string;
}

const ID_RE = /^[1-9][0-9]{0,18}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Access JWT ES256 con `kid`. Las llaves viven en variables de entorno, nunca en el repo. */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly signingKey: KeyObject;
  private readonly kid: string;
  /** kid → llave pública. Incluye la actual y las anteriores aún válidas (rotación). */
  private readonly verifyKeys = new Map<string, KeyObject>();

  constructor(@Inject(ENV) private readonly env: Env) {
    this.kid = env.JWT_KEY_ID;
    if (env.JWT_PRIVATE_KEY) {
      this.signingKey = createPrivateKey(env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'));
      if (this.signingKey.asymmetricKeyType !== 'ec' || this.signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('JWT_PRIVATE_KEY debe ser una llave EC P-256 (ES256).');
      }
    } else {
      // Solo desarrollo y pruebas (en producción la config exige la llave).
      this.signingKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
      this.logger.warn('JWT_PRIVATE_KEY no definida: llave efímera, los tokens mueren al reiniciar.');
    }
    this.verifyKeys.set(this.kid, createPublicKey(this.signingKey));
    for (const [kid, pem] of Object.entries(this.parsePrevious(env.JWT_PREVIOUS_PUBLIC_KEYS))) {
      if (kid !== this.kid) this.verifyKeys.set(kid, createPublicKey(pem.replace(/\\n/g, '\n')));
    }
  }

  private parsePrevious(raw?: string): Record<string, string> {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Object.values(parsed).some((v) => typeof v !== 'string')) {
      throw new Error('JWT_PREVIOUS_PUBLIC_KEYS debe ser un JSON {"kid":"PEM público"}.');
    }
    return parsed as Record<string, string>;
  }

  get accessTtlSeconds(): number {
    return this.env.ACCESS_TOKEN_TTL_SECONDS;
  }

  async signAccess(claims: AccessClaims, ttlSeconds = this.env.ACCESS_TOKEN_TTL_SECONDS): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ uid: claims.uid })
      .setProtectedHeader({ alg: 'ES256', kid: this.kid, typ: 'at+jwt' })
      .setSubject(claims.sub)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(randomUUID())
      .sign(this.signingKey);
  }

  /** Devuelve los claims o null si el token no es válido por cualquier motivo (nunca lanza). */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.verifyKeys.get(header.kid) : undefined;
          if (!key) throw new errors.JWSInvalid('kid desconocido');
          return key;
        },
        {
          algorithms: ['ES256'],
          issuer: this.env.JWT_ISSUER,
          audience: this.env.JWT_AUDIENCE,
          typ: 'at+jwt',
          requiredClaims: ['sub', 'exp', 'iat'],
        },
      );
      const { sub, uid } = payload as { sub?: unknown; uid?: unknown };
      if (typeof sub !== 'string' || !UUID_RE.test(sub) || typeof uid !== 'string' || !ID_RE.test(uid)) return null;
      return { sub, uid };
    } catch {
      return null;
    }
  }
}
