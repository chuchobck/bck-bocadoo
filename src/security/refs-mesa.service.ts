import { Inject, Injectable } from '@nestjs/common';
import { llaveQr } from '../auth/qr-secret.service';
import { configurarRefsMesa } from '../cobro/refs-mesa';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * Configura al arrancar la subclave de los refs opacos de mesa (src/cobro/refs-mesa.ts). La llave base es
 * `QR_SECRET_KEY`: ya obligatoria en producción y validada al arrancar, y no se rota (rotarla invalidaría todos los QR),
 * así que los refs quedan estables. No se crea ninguna variable de entorno nueva.
 */
@Injectable()
export class RefsMesaService {
  constructor(@Inject(ENV) env: Env) {
    configurarRefsMesa(llaveQr(env));
  }
}
