import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Roles } from '../authz/roles.decorator';
import { ApiProblems, notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { HOY_TENANT } from '../common/sql';
import { DbService, Queryable } from '../db/db.service';
import { CURSOR_TS, decodeCursor, encodeCursor } from '../diner/common';
import { type Modificacion, anularCuenta, errorDePago, modificarCuenta, registrarPago, renderCuenta, renderCuentas } from './aplicar';
import { AgregarItemsDto, AnularCuentaDto, CobrarCuentaDto, CuentaResponse, CuentasDelDiaResponse, CuentasQuery } from './cuenta.dto';

/** Ref de una línea de la cotización (`almuerzo`, `almuerzo#1`, `extra:0`, `item:<uuid>`…): nunca llega a SQL sin validar. */
const REF_LINEA = /^[A-Za-z0-9:#_-]{1,120}$/;

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

  /**
   * Cuentas del día local del restaurante (`fecha_local`, la zona horaria del local; no el día UTC), de la más reciente
   * a la más antigua, por páginas (cursor opaco: creada_en + public_id). Una página son cuatro consultas, sin N+1.
   */
  list(f: CuentasQuery): Promise<CuentasDelDiaResponse> {
    const limit = f.limit ?? 20;
    const cur = f.cursor ? decodeCursor(f.cursor) : null;
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<{ cuenta_id: string; public_id: string; cursor_t: string; hoy: string }>(
          `SELECT c.cuenta_id, c.public_id, ${CURSOR_TS('c.creada_en')} AS cursor_t, ${HOY_TENANT}::text AS hoy
             FROM cuenta_cobro c
            WHERE c.restaurante_id = app_tenant_id() AND c.fecha_local = ${HOY_TENANT}
              AND ($1 = 'TODAS' OR c.estado::text = $1)
              AND ($2::text IS NULL
                   OR ($2 = 'PEDIDO' AND c.orden_id IS NOT NULL)
                   OR ($2 = 'QR' AND (c.consumo_id IS NOT NULL OR c.intento_id IS NOT NULL))
                   OR ($2 = 'MESA' AND c.mesa_compartida_id IS NOT NULL))
              AND ($3::timestamptz IS NULL OR (c.creada_en, c.public_id) < ($3::timestamptz, $4::uuid))
            ORDER BY c.creada_en DESC, c.public_id DESC
            LIMIT $5`,
          [f.estado ?? 'TODAS', f.origen ?? null, cur?.t ?? null, cur?.p ?? null, limit + 1],
        );
        const pagina = r.rows.slice(0, limit);
        const last = pagina.at(-1);
        const fecha = r.rows[0]?.hoy ?? (await q.query<{ hoy: string }>(`SELECT ${HOY_TENANT}::text AS hoy`)).rows[0]!.hoy;
        return {
          fecha,
          items: await renderCuentas(
            q,
            pagina.map((x) => String(x.cuenta_id)),
          ),
          nextCursor: r.rows.length > limit && last ? encodeCursor(last.cursor_t, last.public_id) : null,
        };
      },
      { readOnly: true },
    );
  }

  /** Agregar platos o quitar una línea (E.11): recotiza todo con la misma regla y responde la cuenta. */
  modificar(publicId: string, m: Modificacion, key: string) {
    return this.db.forRequest(async (q) => {
      const id = await this.id(q, publicId);
      await modificarCuenta(q, id, key, m);
      return renderCuenta(q, id);
    });
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
  @Get()
  @ApiOperation({
    summary: 'Cuentas de cobro del día',
    description:
      'Las cuentas del día local del restaurante (su zona horaria), de la más reciente a la más antigua, con paginación por cursor ' +
      '(máximo 50 por página). Filtros: `estado` (por defecto TODAS) y `origen` (PEDIDO, QR, MESA). Cada cuenta viene completa ' +
      '(líneas, pagos y saldo), como en `GET /v1/caja/cuentas/{id}`.',
  })
  @ApiOkResponse({ type: CuentasDelDiaResponse })
  @ApiProblems({ 400: ['CURSOR_INVALIDO'] })
  list(@Query() q: CuentasQuery) {
    return this.svc.list(q);
  }

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
      '`POST /v1/pagos/{id}/confirmar|rechazar`). Con `pagoConfirmado`, el cajero debe dar `referenciaExterna` (si no, 422 ' +
      '`REFERENCIA_PAGO_REQUERIDA`); el dueño no. Repetir con la misma llave devuelve la cuenta sin cobrar otra vez.',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({
    404: ['CUENTA_NO_ENCONTRADA'],
    409: ['CUENTA_CERRADA', 'SALDO_CAMBIO', 'REFERENCIA_PAGO_REPETIDA', 'IDEMPOTENCY_KEY_REUTILIZADA'],
    422: ['METODO_PAGO_NO_DISPONIBLE', 'MONTO_EXCEDE_SALDO', 'REFERENCIA_PAGO_REQUERIDA'],
  })
  cobrar(@Param('id', UuidPipe) id: string, @Body() dto: CobrarCuentaDto, @IdempotencyKey() key: string) {
    return this.svc.cobrar(id, dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/items')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Agregar platos a una cuenta abierta',
    description:
      'Carta, extras y bebidas (con las reglas de los platos sueltos: activo, de la carta o del menú de hoy, con precio, no agotado). Se ' +
      'recotiza toda la cuenta con la misma regla y los precios congelados de sus líneas: lo que cambia (p. ej. un plato que ya estaba y suma ' +
      'cantidad) se revierte con una línea inversa y entra de nuevo con el mismo `ref`; nunca se edita un monto. Para llevar hereda el de la ' +
      'cuenta. COBRADA o ANULADA → 409 `CUENTA_CERRADA`; en un local ANTES_DE_SERVIR, también si la cuenta ya tiene pagos (lo de después va ' +
      'por una venta nueva). Repetir con la misma llave devuelve la cuenta sin agregar otra vez; la misma llave con otros platos → 409.',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({
    404: ['CUENTA_NO_ENCONTRADA'],
    409: ['CUENTA_CERRADA', 'CUENTA_DE_MESA', 'PLATO_AGOTADO', 'MENU_NO_PUBLICADO', 'IDEMPOTENCY_KEY_REUTILIZADA'],
    422: ['PLATO_NO_DISPONIBLE', 'PLATO_SIN_PRECIO', 'CANTIDAD_INVALIDA'],
  })
  items(@Param('id', UuidPipe) id: string, @Body() dto: AgregarItemsDto, @IdempotencyKey() key: string) {
    return this.svc.modificar(id, { tipo: 'AGREGAR', items: dto.items }, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/lineas/:ref/quitar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiParam({
    name: 'ref',
    description: '`ref` de la línea en `cotizacion.lineas` (p. ej. `item:<uuid>`; `#` va como `%23`)',
    example: 'item:6a0e1c52-2b8e-4b51-9d0e-3a1c6f0d2e11',
  })
  @ApiOperation({
    summary: 'Quitar una línea de una cuenta abierta',
    description:
      'Quita la línea completa (todas sus unidades) con una línea inversa y recotiza el resto. Un almuerzo del plan no se quita aquí ' +
      '(409 `LINEA_DE_PLAN`: se deshace el consumo). Si lo ya pagado superaría lo que queda por cobrar → 409 `SALDO_NEGATIVO` (se anula la ' +
      'cuenta). Una cuenta que se queda sin líneas y sin pagos pasa a ANULADA. Repetir con la misma llave no quita nada más.',
  })
  @ApiOkResponse({ type: CuentaResponse })
  @ApiProblems({
    404: ['CUENTA_NO_ENCONTRADA', 'LINEA_NO_ENCONTRADA'],
    409: ['CUENTA_CERRADA', 'CUENTA_DE_MESA', 'LINEA_DE_PLAN', 'SALDO_NEGATIVO', 'IDEMPOTENCY_KEY_REUTILIZADA'],
  })
  quitar(@Param('id', UuidPipe) id: string, @Param('ref') ref: string, @IdempotencyKey() key: string) {
    if (!REF_LINEA.test(ref)) throw new BadRequestException('ref inválido.');
    return this.svc.modificar(id, { tipo: 'QUITAR', ref }, key);
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
