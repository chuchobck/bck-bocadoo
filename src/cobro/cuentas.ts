import { Body, Controller, Get, HttpCode, Injectable, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { anularCuenta, errorDePago, registrarPago, renderCuenta } from './aplicar';
import { AnularCuentaDto, CobrarCuentaDto, CuentaResponse } from './cuenta.dto';

/**
 * Cuentas de cobro desde la caja (docs/spec-cobros.md, E.11). Dueño y cajero, con tenant (RLS `tenant_total`). Las
 * cuentas las crean los flujos de caja (hoy: `POST /v1/caja/pedidos/{id}/canjear` con `cobro`); aquí se leen, se cobran
 * y se anulan.
 */
@Injectable()
export class CuentasService {
  constructor(private readonly db: DbService) {}

  private async id(q: Queryable, publicId: string): Promise<string> {
    const r = await q.query<{ cuenta_id: string }>(
      'SELECT cuenta_id FROM cuenta_cobro WHERE restaurante_id = app_tenant_id() AND public_id = $1',
      [publicId],
    );
    if (!r.rows[0]) throw notFound('CUENTA_NO_ENCONTRADA', 'Cuenta no encontrada.');
    return String(r.rows[0].cuenta_id);
  }

  one(publicId: string) {
    return this.db.forRequest(async (q) => renderCuenta(q, await this.id(q, publicId)), { readOnly: true });
  }

  async cobrar(publicId: string, dto: CobrarCuentaDto, key: string) {
    try {
      return await this.db.forRequest(async (q) => {
        const id = await this.id(q, publicId);
        await registrarPago(q, id, dto, key);
        return renderCuenta(q, id);
      });
    } catch (err) {
      // Dos cobros a la vez con la misma llave no chocan aquí: la cuenta se bloquea y el segundo ve el pago del primero.
      throw errorDePago(err);
    }
  }

  async anular(publicId: string, dto: AnularCuentaDto, key: string) {
    return this.db.forRequest(async (q) => {
      const id = await this.id(q, publicId);
      await anularCuenta(q, id, key, dto.motivo ?? null);
      return renderCuenta(q, id);
    });
  }
}

@ApiTags('caja')
@Controller('v1/caja/cuentas')
export class CuentasController {
  constructor(private readonly svc: CuentasService) {}

  @Roles('DUENO', 'CAJERO')
  @Get(':id')
  @ApiOperation({
    summary: 'Ver una cuenta de cobro',
    description:
      'Líneas (con sus reversos), pagos, lo pagado y el saldo. `debeCobrarseAntesDeServir` en locales ANTES_DE_SERVIR con saldo.',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({ 404: ['CUENTA_NO_ENCONTRADA'] })
  one(@Param('id', UuidPipe) id: string) {
    return this.svc.one(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/cobrar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Registrar un pago de la cuenta',
    description:
      '`saldoEsperadoCentavos` es el saldo que la caja vio: si el real es otro → 409 `SALDO_CAMBIO` (trae `saldoCentavos`) y no se cobra nada. ' +
      '`montoCentavos` permite pagos parciales (por defecto, todo el saldo); varios métodos en la misma cuenta. Sin saldo la cuenta pasa a ' +
      'COBRADA. Transferencia o Deuna sin `pagoConfirmado` quedan PENDIENTE (cuentan para el saldo; el dueño las confirma o rechaza en ' +
      '`POST /v1/pagos/{id}/confirmar|rechazar`). Repetir con la misma llave devuelve la cuenta sin cobrar otra vez.',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({
    404: ['CUENTA_NO_ENCONTRADA'],
    409: ['CUENTA_CERRADA', 'SALDO_CAMBIO', 'REFERENCIA_PAGO_REPETIDA', 'IDEMPOTENCY_KEY_REUTILIZADA'],
    422: ['METODO_PAGO_NO_DISPONIBLE', 'MONTO_EXCEDE_SALDO'],
  })
  cobrar(@Param('id', UuidPipe) id: string, @Body() dto: CobrarCuentaDto, @IdempotencyKey() key: string) {
    return this.svc.cobrar(id, dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/anular')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Anular la cuenta',
    description:
      'Devuelve todo: una línea inversa por línea, un pago inverso por cada pago confirmado (los pendientes pasan a RECHAZADO) y el almuerzo ' +
      'del plan de vuelta al comensal. El cajero solo anula cuentas del día local del restaurante (403 `SOLO_CUENTAS_DEL_DIA`); el dueño, ' +
      'cualquiera. Repetir devuelve la cuenta ya anulada (200).',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({ 403: ['SOLO_CUENTAS_DEL_DIA'], 404: ['CUENTA_NO_ENCONTRADA'] })
  anular(@Param('id', UuidPipe) id: string, @Body() dto: AnularCuentaDto, @IdempotencyKey() key: string) {
    return this.svc.anular(id, dto, key);
  }
}
