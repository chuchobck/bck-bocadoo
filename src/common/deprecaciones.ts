import { Logger } from '@nestjs/common';

// Avisos de uso de campos deprecados del contrato: sirven para saber cuándo un campo ya se puede retirar.
// Solo el id público del local y la ruta: nunca datos del comensal ni el cuerpo.

const logger = new Logger('Deprecaciones');

/**
 * `extras` deprecado (PR 9) en `POST /v1/mis/pedidos`, `POST /v1/mis/pedidos/cotizar` y
 * `PUT /v1/mis/mesas/{id}/seleccion`. Solo registra si llegó con algo; no cambia nada de la petición.
 */
export function avisarExtrasDeprecado(extras: readonly unknown[] | undefined, restauranteId: string, ruta: string): void {
  if (!extras?.length) return;
  logger.log({ evento: 'extras_deprecado_usado', restauranteId, ruta }, 'extras_deprecado_usado');
}
