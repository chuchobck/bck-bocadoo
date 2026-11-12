import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

// Parámetros OWASP para argon2id: 19 MiB, 2 pasadas, 1 hilo.
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false; // hash corrupto o con formato inválido: nunca es una coincidencia
    }
  }

  /**
   * Usuario inexistente: se verifica contra un hash falso para gastar el mismo tiempo que con un
   * usuario real y que la latencia no delate qué correos existen.
   */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash('contraseña-señuelo-no-usar');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
