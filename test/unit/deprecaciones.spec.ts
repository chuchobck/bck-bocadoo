import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avisarExtrasDeprecado } from '../../src/common/deprecaciones';

describe('avisarExtrasDeprecado (PR 9)', () => {
  afterEach(() => vi.restoreAllMocks());
  const RESTAURANTE = '41c0703f-3521-48eb-98ec-6d6d8efd5979';

  it('registra extras_deprecado_usado con el local y la ruta, sin el cuerpo', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    avisarExtrasDeprecado([{ plato: 'x', cantidad: 2 }], RESTAURANTE, 'POST /v1/mis/pedidos');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      { evento: 'extras_deprecado_usado', restauranteId: RESTAURANTE, ruta: 'POST /v1/mis/pedidos' },
      'extras_deprecado_usado',
    ]);
  });

  it('no registra nada sin extras o con extras vacío', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    avisarExtrasDeprecado(undefined, RESTAURANTE, 'POST /v1/mis/pedidos');
    avisarExtrasDeprecado([], RESTAURANTE, 'PUT /v1/mis/mesas/{id}/seleccion');
    expect(log).not.toHaveBeenCalled();
  });
});
