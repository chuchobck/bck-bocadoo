import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { SolicitudPlanCreadaResponse } from '../catalog/dto';
import { ApiProblems } from '../common/errors';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, Length, Matches, MaxLength } from 'class-validator';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { IdPipe, UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';
import { RequestContextStore } from '../tenancy/request-context';
import { SUBS_SELECT, SubRow, toSub } from './subscriptions';
import { PlanVendidoResponse, SolicitudPendienteResponse, SolicitudRechazadaResponse } from './responses';

const METODOS = ['EFECTIVO', 'TRANSFERENCIA', 'DEUNA'] as const;
const ID = /^[1-9][0-9]{0,17}$/;

class CobroDto {
  @ApiProperty({ enum: METODOS }) @IsIn(METODOS) metodoPago!: (typeof METODOS)[number];
  @ApiPropertyOptional({
    description:
      'Transferencia o Deuna ya verificada. Si no, queda PENDIENTE hasta que el dueño la confirme. Efectivo siempre se confirma.',
  })
  @IsOptional()
  @IsBoolean()
  pagoConfirmado?: boolean;
  @ApiPropertyOptional({ description: 'Foto del comprobante (https)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  comprobanteUrl?: string;
  @ApiPropertyOptional({ description: 'Número de la transferencia o id de Deuna' })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 100)
  referenciaExterna?: string;
}

export class VenderPlanDto extends CobroDto {
  @ApiProperty({ description: 'Id de la plantilla de plan' }) @IsString() @Matches(ID, { message: 'planId inválido' }) planId!: string;
}

class DeshacerDto {
  @ApiPropertyOptional({ example: 'Se cobró al cliente equivocado' }) @IsOptional() @Text() @IsString() @Length(1, 200) motivo?: string;
}

class SolicitarPlanDto {
  @ApiProperty({ description: 'Id del plan, tal como aparece en la vitrina' })
  @IsString()
  @Matches(ID, { message: 'planId inválido' })
  planId!: string;
}

const PERSONAL_ACTUAL = `(SELECT personal_id FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id() AND activo)`;
const HOY = `(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())`;
const IDEMP_CONSTRAINT = 'transaccion_pago_restaurante_id_clave_idempotencia_key';

/** Un mismo depósito (referencia de transferencia/Deuna) no puede pagar dos planes: el esquema lo impide con un índice único. */
function assertNotDuplicateReference(err: unknown) {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'uq_pago_referencia_externa') {
    throw new ConflictException('Esa referencia de pago ya se registró: no se puede usar el mismo depósito dos veces.');
  }
}

interface SellInput extends CobroDto {
  clienteId: string;
  planId: string;
}

@Injectable()
export class SalesService {
  constructor(private readonly db: DbService) {}

  // --- Venta -----------------------------------------------------------------------------------------------------

  /**
   * Vende un plan: suscripción + pago en UNA transacción (si algo falla, no queda ninguno). La Idempotency-Key es la
   * clave del pago: repetir la petición devuelve la misma venta; usarla para otra venta distinta → 409.
   */
  async sell(input: SellInput, key: string) {
    const replay = await this.replay(key, input);
    if (replay) return replay;
    try {
      return await this.db.forRequest(async (q) => {
        const subId = await this.sellIn(q, input, key);
        return this.renderSub(q, subId);
      });
    } catch (err) {
      assertNotDuplicateReference(err);
      // Dos peticiones simultáneas con la misma clave: la segunda choca con el índice único y devuelve la primera.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === IDEMP_CONSTRAINT) {
        const again = await this.replay(key, input);
        if (again) return again;
      }
      throw err;
    }
  }

  private async replay(key: string, input: SellInput) {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<{ suscripcion_id: string; cliente_id: string; plantilla_plan_id: string | null; metodo: string }>(
          `SELECT s.suscripcion_id, s.cliente_id, s.plantilla_plan_id, m.codigo AS metodo
             FROM transaccion_pago p JOIN suscripcion_plan s ON s.restaurante_id = p.restaurante_id AND s.suscripcion_id = p.suscripcion_id
             JOIN metodo_pago m ON m.metodo_pago_id = p.metodo_pago_id
            WHERE p.restaurante_id = app_tenant_id() AND p.clave_idempotencia = $1 AND p.revierte_a_pago_id IS NULL`,
          [key],
        );
        const prev = r.rows[0];
        if (!prev) return null;
        if (
          String(prev.cliente_id) !== input.clienteId ||
          String(prev.plantilla_plan_id) !== input.planId ||
          prev.metodo !== input.metodoPago
        ) {
          throw new ConflictException('Esa Idempotency-Key ya se usó para otra venta.');
        }
        return this.renderSub(q, prev.suscripcion_id);
      },
      { readOnly: true },
    );
  }

  /** Núcleo de la venta, dentro de una transacción ya abierta con el tenant. Devuelve el suscripcion_id. */
  private async sellIn(q: Queryable, input: SellInput, key: string): Promise<string> {
    // FOR UPDATE serializa las ventas de la misma plantilla: así dos cajas no pueden vender el último cupo a la vez.
    const t = await q.query<{
      nombre: string;
      almuerzos: number;
      precio_centavos: string;
      vigencia_dias: number;
      cupos: number | null;
      dias_validos: number[];
      activo: boolean;
    }>(
      `SELECT nombre, almuerzos, precio_centavos, vigencia_dias, cupos, dias_validos, activo
         FROM plantilla_plan WHERE restaurante_id = app_tenant_id() AND plantilla_plan_id = $1 FOR UPDATE`,
      [input.planId],
    );
    const tpl = t.rows[0];
    if (!tpl) throw new NotFoundException('Plan no encontrado.');
    if (!tpl.activo) throw new ConflictException('Ese plan está desactivado.');
    if (tpl.cupos !== null) {
      const used = await q.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM suscripcion_plan WHERE restaurante_id = app_tenant_id() AND plantilla_plan_id = $1 AND estado = 'ACTIVA'`,
        [input.planId],
      );
      if (used.rows[0]!.n >= tpl.cupos) throw new ConflictException('Este plan ya no tiene cupos disponibles.');
    }
    const c = await q.query('SELECT 1 FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND activo', [
      input.clienteId,
    ]);
    if (!c.rowCount) throw new NotFoundException('Cliente no encontrado o inactivo.');
    const m = await q.query<{ metodo_pago_id: string; es_efectivo: boolean }>(
      `SELECT metodo_pago_id, es_efectivo FROM metodo_pago WHERE codigo = $1 AND activo
          AND (pais_codigo IS NULL OR pais_codigo = (SELECT pais_codigo FROM restaurante WHERE restaurante_id = app_tenant_id()))`,
      [input.metodoPago],
    );
    const metodo = m.rows[0];
    if (!metodo) throw new BadRequestException('Método de pago no disponible.');
    const estadoPago = metodo.es_efectivo || input.pagoConfirmado ? 'CONFIRMADO' : 'PENDIENTE';

    // Cada plan vence por su cuenta (desde hoy + vigencia): dos planes del mismo cliente NO suman vencimientos.
    const s = await q.query<{ suscripcion_id: string }>(
      `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, plantilla_plan_id, origen, nombre_plan, almuerzos_totales, almuerzos_restantes,
           precio_pagado_centavos, precio_unitario_centavos, moneda_codigo, dias_validos, vence_el, vendida_por_personal_id)
       SELECT app_tenant_id(), $1, $2, 'VENTA', $3, $4::int, $4::int, $5::bigint, round($5::numeric / $4::int)::bigint, r.moneda_codigo, $6::smallint[],
              (CURRENT_TIMESTAMP AT TIME ZONE r.zona_horaria)::date + ($7::int - 1), ${PERSONAL_ACTUAL}
         FROM restaurante r WHERE r.restaurante_id = app_tenant_id()
       RETURNING suscripcion_id`,
      [input.clienteId, input.planId, tpl.nombre, tpl.almuerzos, tpl.precio_centavos, tpl.dias_validos, tpl.vigencia_dias],
    );
    const subId = s.rows[0]!.suscripcion_id;
    await q.query(
      `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, suscripcion_id, cobrado_por_personal_id,
           fecha_local, comprobante_url, referencia_externa, clave_idempotencia)
       SELECT app_tenant_id(), $1, $2, r.moneda_codigo, $3, $4, ${PERSONAL_ACTUAL}, ${HOY}, $5, $6, $7
         FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
      [metodo.metodo_pago_id, tpl.precio_centavos, estadoPago, subId, input.comprobanteUrl ?? null, input.referenciaExterna ?? null, key],
    );
    return subId;
  }

  // --- Pagos pendientes ------------------------------------------------------------------------------------------

  pendingPayments() {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<SubRow>(
          `${SUBS_SELECT} WHERE s.restaurante_id = app_tenant_id() AND p.estado = 'PENDIENTE' ORDER BY p.creado_en`,
        );
        return r.rows.map(toSub);
      },
      { readOnly: true },
    );
  }

  /** Confirma o rechaza una transferencia/Deuna pendiente. Rechazarla anula el plan. Repetir la misma acción no cambia nada. */
  resolvePayment(pagoPublicId: string, accion: 'CONFIRMADO' | 'RECHAZADO') {
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ pago_id: string; estado: string; suscripcion_id: string | null }>(
        `SELECT pago_id, estado, suscripcion_id FROM transaccion_pago
          WHERE restaurante_id = app_tenant_id() AND public_id = $1 AND revierte_a_pago_id IS NULL FOR UPDATE`,
        [pagoPublicId],
      );
      const pago = r.rows[0];
      if (!pago || !pago.suscripcion_id) throw new NotFoundException('Pago no encontrado.');
      if (pago.estado !== 'PENDIENTE') {
        if (pago.estado === accion) return this.renderSub(q, pago.suscripcion_id);
        throw new ConflictException(`Ese pago ya está ${pago.estado.toLowerCase()}.`);
      }
      await q.query('UPDATE transaccion_pago SET estado = $2 WHERE pago_id = $1', [pago.pago_id, accion]);
      if (accion === 'RECHAZADO') {
        await q.query(
          `UPDATE suscripcion_plan SET estado = 'ANULADA', anulada_en = CURRENT_TIMESTAMP, actualizado_en = CURRENT_TIMESTAMP,
                  anotacion = 'Pago rechazado' WHERE suscripcion_id = $1 AND estado <> 'ANULADA'`,
          [pago.suscripcion_id],
        );
      }
      return this.renderSub(q, pago.suscripcion_id);
    });
  }

  // --- Deshacer --------------------------------------------------------------------------------------------------

  /**
   * Deshace una venta: nunca borra. Si el pago estaba confirmado registra un pago inverso (negativo) con la Idempotency-Key;
   * si estaba pendiente lo rechaza. Solo si aún no se consumió ningún almuerzo. El cajero solo puede deshacer ventas del día.
   */
  undo(subPublicId: string, key: string, motivo?: string) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ suscripcion_id: string; estado: string; origen: string; totales: number; restantes: number }>(
        `SELECT suscripcion_id, estado, origen, almuerzos_totales AS totales, almuerzos_restantes AS restantes
           FROM suscripcion_plan WHERE restaurante_id = app_tenant_id() AND public_id = $1 FOR UPDATE`,
        [subPublicId],
      );
      const sub = r.rows[0];
      if (!sub) throw new NotFoundException('Plan vendido no encontrado.');
      if (sub.estado === 'ANULADA') return this.renderSub(q, sub.suscripcion_id); // ya deshecho: idempotente
      if (sub.restantes < sub.totales) throw new ConflictException('Ya se consumieron almuerzos de este plan: no se puede deshacer.');

      const p = await q.query<{ pago_id: string; estado: string; monto_centavos: string; metodo_pago_id: string; es_hoy: boolean }>(
        `SELECT pago_id, estado, monto_centavos, metodo_pago_id, fecha_local = ${HOY} AS es_hoy FROM transaccion_pago
          WHERE restaurante_id = app_tenant_id() AND suscripcion_id = $1 AND revierte_a_pago_id IS NULL FOR UPDATE`,
        [sub.suscripcion_id],
      );
      const pago = p.rows[0];
      if (RequestContextStore.get()?.role === 'CAJERO' && !(pago?.es_hoy ?? false)) {
        throw new ForbiddenException('El cajero solo puede deshacer ventas del mismo día.');
      }
      if (pago?.estado === 'CONFIRMADO') {
        await q.query(
          `INSERT INTO transaccion_pago (restaurante_id, metodo_pago_id, monto_centavos, moneda_codigo, estado, suscripcion_id, cobrado_por_personal_id,
               fecha_local, clave_idempotencia, revierte_a_pago_id)
           SELECT app_tenant_id(), $1, -$2::bigint, r.moneda_codigo, 'CONFIRMADO', $3, ${PERSONAL_ACTUAL}, ${HOY}, $4, $5
             FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
          [pago.metodo_pago_id, pago.monto_centavos, sub.suscripcion_id, key, pago.pago_id],
        );
      } else if (pago?.estado === 'PENDIENTE') {
        await q.query(`UPDATE transaccion_pago SET estado = 'RECHAZADO' WHERE pago_id = $1`, [pago.pago_id]);
      }
      await q.query(
        `UPDATE suscripcion_plan SET estado = 'ANULADA', anulada_en = CURRENT_TIMESTAMP, actualizado_en = CURRENT_TIMESTAMP,
                anotacion = COALESCE($2, 'Venta deshecha') WHERE suscripcion_id = $1`,
        [sub.suscripcion_id, motivo ?? null],
      );
      return this.renderSub(q, sub.suscripcion_id);
    });
  }

  // --- Solicitudes de comensales ---------------------------------------------------------------------------------

  pendingRequests() {
    return this.db.forRequest(
      async (q) => {
        const r = await q.query<{
          solicitud_plan_id: string;
          creada_en: Date;
          cliente_id: string;
          cliente_nombre: string;
          plan_id: string;
          plan_nombre: string;
          precio_centavos: string;
          almuerzos: number;
        }>(
          `SELECT sp.solicitud_plan_id, sp.creada_en, c.cliente_id, c.nombre AS cliente_nombre, p.plantilla_plan_id AS plan_id, p.nombre AS plan_nombre,
                  p.precio_centavos, p.almuerzos
             FROM solicitud_plan sp
             JOIN cliente_restaurante c ON c.restaurante_id = sp.restaurante_id AND c.cliente_id = sp.cliente_id
             JOIN plantilla_plan p ON p.restaurante_id = sp.restaurante_id AND p.plantilla_plan_id = sp.plantilla_plan_id
            WHERE sp.restaurante_id = app_tenant_id() AND sp.estado = 'PENDIENTE' ORDER BY sp.creada_en`,
        );
        return r.rows.map((x) => ({
          id: String(x.solicitud_plan_id),
          creadaEn: x.creada_en,
          cliente: { id: String(x.cliente_id), nombre: x.cliente_nombre },
          plan: { id: String(x.plan_id), nombre: x.plan_nombre, precioCentavos: Number(x.precio_centavos), almuerzos: x.almuerzos },
        }));
      },
      { readOnly: true },
    );
  }

  /** Cobra una solicitud: vende el plan y la marca COBRADA, todo en la misma transacción. */
  async chargeRequest(id: string, cobro: CobroDto, key: string) {
    const req = await this.db.forRequest(
      async (q) =>
        (
          await q.query<{ cliente_id: string; plantilla_plan_id: string; estado: string; suscripcion_id: string | null }>(
            'SELECT cliente_id, plantilla_plan_id, estado, suscripcion_id FROM solicitud_plan WHERE restaurante_id = app_tenant_id() AND solicitud_plan_id = $1',
            [id],
          )
        ).rows[0],
      { readOnly: true },
    );
    if (!req) throw new NotFoundException('Solicitud no encontrada.');
    if (req.estado === 'COBRADA') return this.db.forRequest((q) => this.renderSub(q, req.suscripcion_id!), { readOnly: true });
    if (req.estado !== 'PENDIENTE') throw new ConflictException(`La solicitud está ${req.estado.toLowerCase()}.`);
    const input: SellInput = { ...cobro, clienteId: String(req.cliente_id), planId: String(req.plantilla_plan_id) };
    const replay = await this.replay(key, input);
    if (replay) return replay;
    try {
      return await this.db.forRequest(async (q) => {
        const locked = await q.query<{ estado: string }>(
          'SELECT estado FROM solicitud_plan WHERE restaurante_id = app_tenant_id() AND solicitud_plan_id = $1 FOR UPDATE',
          [id],
        );
        if (locked.rows[0]?.estado !== 'PENDIENTE') throw new ConflictException('La solicitud ya fue resuelta.');
        const subId = await this.sellIn(q, input, key);
        await q.query(
          `UPDATE solicitud_plan SET estado = 'COBRADA', suscripcion_id = $2, resuelta_en = CURRENT_TIMESTAMP WHERE solicitud_plan_id = $1`,
          [id, subId],
        );
        return this.renderSub(q, subId);
      });
    } catch (err) {
      assertNotDuplicateReference(err);
      throw err;
    }
  }

  rejectRequest(id: string) {
    return this.db.forRequest(async (q) => {
      const r = await q.query<{ estado: string }>(
        `UPDATE solicitud_plan SET estado = 'RECHAZADA', resuelta_en = CURRENT_TIMESTAMP
          WHERE restaurante_id = app_tenant_id() AND solicitud_plan_id = $1 AND estado IN ('PENDIENTE', 'RECHAZADA') RETURNING estado`,
        [id],
      );
      if (!r.rowCount) {
        const e = await q.query('SELECT 1 FROM solicitud_plan WHERE restaurante_id = app_tenant_id() AND solicitud_plan_id = $1', [id]);
        if (!e.rowCount) throw new NotFoundException('Solicitud no encontrada.');
        throw new ConflictException('La solicitud ya fue resuelta.');
      }
      return { id, estado: 'RECHAZADA' };
    });
  }

  /**
   * El comensal pide un plan desde la vitrina. Corre con el tenant del restaurante pedido (resuelto por slug, solo locales
   * activos) y con su usuario: si aún no es cliente de ese local, se crea su ficha con su nombre de la app.
   */
  async requestPlan(slug: string, planId: string, user: AuthUser) {
    const rest = await this.db.scope({ readOnly: true }, (q) =>
      q.query<{ restaurante_id: string }>(`SELECT restaurante_id FROM restaurante WHERE slug = $1 AND estado = 'ACTIVO'`, [slug]),
    );
    const tenantId = rest.rows[0]?.restaurante_id;
    if (!tenantId) throw new NotFoundException('Restaurante no encontrado.');
    return this.db.scope({ tenantId: String(tenantId), userId: user.userId }, async (q) => {
      const plan = await q.query<{ nombre: string }>(
        'SELECT nombre FROM plantilla_plan WHERE restaurante_id = app_tenant_id() AND plantilla_plan_id = $1 AND activo AND visible_en_marketplace',
        [planId],
      );
      if (!plan.rows[0]) throw new NotFoundException('Plan no disponible.');
      let cliente = (
        await q.query<{ cliente_id: string }>(
          'SELECT cliente_id FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id()',
        )
      ).rows[0];
      if (!cliente) {
        cliente = (
          await q.query<{ cliente_id: string }>(
            `INSERT INTO cliente_restaurante (restaurante_id, usuario_id, nombre)
             SELECT app_tenant_id(), app_user_id(), nombre FROM usuario WHERE usuario_id = app_user_id() RETURNING cliente_id`,
          )
        ).rows[0]!;
      }
      const dup = await q.query(
        `SELECT 1 FROM solicitud_plan WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND plantilla_plan_id = $2 AND estado = 'PENDIENTE'`,
        [cliente.cliente_id, planId],
      );
      if (dup.rowCount) throw new ConflictException('Ya tienes una solicitud pendiente de ese plan.');
      const r = await q.query<{ solicitud_plan_id: string; creada_en: Date }>(
        `INSERT INTO solicitud_plan (restaurante_id, cliente_id, plantilla_plan_id) VALUES (app_tenant_id(), $1, $2) RETURNING solicitud_plan_id, creada_en`,
        [cliente.cliente_id, planId],
      );
      return { id: String(r.rows[0]!.solicitud_plan_id), estado: 'PENDIENTE', plan: plan.rows[0].nombre, creadaEn: r.rows[0]!.creada_en };
    });
  }

  private async renderSub(q: Queryable, subId: string) {
    const r = await q.query<SubRow>(`${SUBS_SELECT} WHERE s.restaurante_id = app_tenant_id() AND s.suscripcion_id = $1`, [subId]);
    return toSub(r.rows[0]!);
  }
}

@ApiTags('ventas')
@Controller('v1')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Roles('DUENO', 'CAJERO')
  @Post('clientes/:id/planes')
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Vender un plan a un cliente',
    description:
      'Crea el plan y el pago en una sola transacción. Efectivo queda confirmado; transferencia/Deuna, pendiente salvo pagoConfirmado.',
  })
  @ApiCreatedResponse({ type: PlanVendidoResponse })
  sell(@Param('id', IdPipe) clienteId: string, @Body() dto: VenderPlanDto, @IdempotencyKey() key: string) {
    return this.sales.sell({ ...dto, clienteId }, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('planes-vendidos/:id/deshacer')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Deshacer la venta de un plan',
    description: 'Registra un pago inverso (nunca borra). Solo sin almuerzos consumidos; el cajero, solo el mismo día.',
  })
  @ApiOkResponse({ type: PlanVendidoResponse })
  undo(@Param('id', UuidPipe) id: string, @Body() dto: DeshacerDto, @IdempotencyKey() key: string) {
    return this.sales.undo(id, key, dto.motivo);
  }

  @Roles('DUENO')
  @Get('pagos/pendientes')
  @ApiOperation({ summary: 'Transferencias y pagos Deuna por confirmar' })
  @ApiOkResponse({ type: PlanVendidoResponse, isArray: true })
  pending() {
    return this.sales.pendingPayments();
  }

  @Roles('DUENO')
  @Post('pagos/:id/confirmar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirmar un pago pendiente' })
  @ApiOkResponse({ type: PlanVendidoResponse })
  confirm(@Param('id', UuidPipe) id: string) {
    return this.sales.resolvePayment(id, 'CONFIRMADO');
  }

  @Roles('DUENO')
  @Post('pagos/:id/rechazar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar un pago pendiente', description: 'Anula el plan asociado.' })
  @ApiOkResponse({ type: PlanVendidoResponse })
  reject(@Param('id', UuidPipe) id: string) {
    return this.sales.resolvePayment(id, 'RECHAZADO');
  }

  @Roles('DUENO', 'CAJERO')
  @Get('solicitudes-plan')
  @ApiOperation({ summary: 'Solicitudes de plan hechas por comensales desde la app' })
  @ApiOkResponse({ type: SolicitudPendienteResponse, isArray: true })
  requests() {
    return this.sales.pendingRequests();
  }

  @Roles('DUENO', 'CAJERO')
  @Post('solicitudes-plan/:id/cobrar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({ summary: 'Cobrar una solicitud: vende el plan y la marca cobrada' })
  @ApiOkResponse({ type: PlanVendidoResponse })
  charge(@Param('id', IdPipe) id: string, @Body() dto: CobroDto, @IdempotencyKey() key: string) {
    return this.sales.chargeRequest(id, dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('solicitudes-plan/:id/rechazar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar una solicitud de plan' })
  @ApiOkResponse({ type: SolicitudRechazadaResponse })
  rejectRequest(@Param('id', IdPipe) id: string) {
    return this.sales.rejectRequest(id);
  }
}

@ApiTags('vitrina')
@Controller('v1/restaurantes')
export class PlanRequestsController {
  constructor(private readonly sales: SalesService) {}

  @ApiBearerAuth()
  @Post(':slug/solicitudes-plan')
  @ApiOperation({
    summary: 'Pedir un plan a un restaurante (comensal con sesión)',
    description: 'El local la ve en sus solicitudes y la cobra en caja.',
  })
  @ApiCreatedResponse({ type: SolicitudPlanCreadaResponse })
  @ApiProblems({ 404: ['NOT_FOUND'], 409: ['CONFLICT'] })
  request(@Param('slug') slug: string, @Body() dto: SolicitarPlanDto, @CurrentUser() user: AuthUser) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) throw new NotFoundException('Restaurante no encontrado.');
    return this.sales.requestPlan(slug, dto.planId, user);
  }
}

@Module({ controllers: [SalesController, PlanRequestsController], providers: [SalesService] })
export class SalesModule {}
