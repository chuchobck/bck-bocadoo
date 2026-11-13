import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { createHash } from 'node:crypto';
import { QrSecretService } from '../auth/qr-secret.service';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Roles } from '../authz/roles.decorator';
import { notFound } from '../common/errors';
import { ApiIdempotent, IdempotencyKey } from '../common/idempotency';
import { UuidPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { STEP_SECONDS, issuePassCode, parsePassCode, stepOf, verifyPassCode } from './pass-code';

const ID = /^[1-9][0-9]{0,17}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana para deshacer una validación en caja. Después solo queda el reclamo. */
export const UNDO_SECONDS = 10;

export const RESULTADOS = {
  OK: 'Almuerzo descontado.',
  OK_ADVERTENCIA: 'Almuerzo descontado. Es el último o el plan vence pronto: ofrece renovar.',
  DUPLICADO: 'Este comensal ya fue validado hace menos de un minuto. No se descontó otra vez.',
  SIN_PLAN: 'No tiene un plan en este restaurante.',
  SIN_SALDO: 'Su plan ya no tiene almuerzos.',
  VENCIDO: 'Su plan está vencido.',
  DIA_NO_VALIDO: 'Su plan no vale hoy.',
  OTRO_LOCAL: 'Ese código es de otro restaurante.',
  QR_EXPIRADO: 'El código venció. Pídele que actualice su pase.',
  QR_INVALIDO: 'Código no válido.',
  LIMITE_SAAS: 'El restaurante alcanzó el límite de validaciones de su plan Bocadoo.',
} as const;
export type Resultado = keyof typeof RESULTADOS;

export const PERSONAL_ACTUAL = `(SELECT personal_id FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id() AND activo)`;

export class ValidarDto {
  @ApiPropertyOptional({ description: 'Contenido del QR del comensal (canal QR)' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  codigoQr?: string;
  @ApiPropertyOptional({ description: 'Id del cliente elegido en la búsqueda manual (canal MANUAL)' })
  @IsOptional()
  @IsString()
  @Matches(ID, { message: 'clienteId inválido' })
  clienteId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() paraLlevar?: boolean;
  @ApiPropertyOptional({ description: 'Mesa del local donde se sirve' })
  @IsOptional()
  @IsString()
  @Matches(ID, { message: 'mesaLocalId inválido' })
  mesaLocalId?: string;
}

export class ValidacionResponse {
  @ApiProperty({ enum: Object.keys(RESULTADOS), example: 'OK' }) resultado!: Resultado;
  @ApiProperty({ example: RESULTADOS.OK }) mensaje!: string;
  @ApiProperty({ description: 'true solo si se descontó un almuerzo (OK u OK_ADVERTENCIA)' }) descontado!: boolean;
  @ApiPropertyOptional({ example: { id: '12', nombre: 'Ana Pérez' } }) cliente!: { id: string; nombre: string } | null;
  @ApiPropertyOptional({ example: { id: 'uuid', creadoEn: '2026-11-13T17:00:00Z', deshacerHasta: '2026-11-13T17:00:10Z' } })
  consumo!: { id: string; creadoEn: Date; deshacerHasta: Date } | null;
  @ApiPropertyOptional({ example: { nombre: 'Plan semanal', venceEl: '2026-11-20' } }) plan!: { nombre: string; venceEl: string } | null;
  @ApiPropertyOptional({ example: 4 }) almuerzosRestantes!: number | null;
  @ApiPropertyOptional({ example: 6 }) diasParaVencer!: number | null;
}

interface QrCheck {
  resultado: 'VALIDO' | 'QR_EXPIRADO' | 'QR_INVALIDO';
  usuarioId?: string;
  restaurantPublicId?: string | null;
}

/** Clave de idempotencia propia de cada miembro de una mesa, derivada de la clave de la petición. */
const deriveKey = (key: string, n: string) => {
  const h = createHash('sha256').update(`${key}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

@Injectable()
export class CheckoutService {
  constructor(
    private readonly db: DbService,
    private readonly secrets: QrSecretService,
  ) {}

  // --- Pase del comensal -----------------------------------------------------------------------------------------

  async issueCode(user: AuthUser, restaurantPublicId?: string) {
    if (restaurantPublicId) {
      const r = await this.db.scope({ readOnly: true }, (q) =>
        q.query(`SELECT 1 FROM restaurante WHERE public_id = $1 AND estado <> 'BAJA'`, [restaurantPublicId]),
      );
      if (!r.rowCount) throw notFound('RESTAURANTE_NO_ENCONTRADO', 'Restaurante no encontrado.');
    }
    const secret = await this.secrets.getOrCreate(user.userId);
    const now = Date.now();
    return {
      codigo: issuePassCode(secret, user.publicId, restaurantPublicId ?? null, now),
      validoSegundos: STEP_SECONDS,
      expiraEn: new Date((stepOf(now) + 1) * STEP_SECONDS * 1000),
    };
  }

  async rotateSecret(user: AuthUser) {
    await this.secrets.rotate(user.userId);
  }

  private async checkQr(code: string): Promise<QrCheck> {
    const pass = parsePassCode(code);
    if (!pass) return { resultado: 'QR_INVALIDO' };
    const u = await this.db.scope({ readOnly: true }, (q) =>
      q.query<{ usuario_id: string; activo: boolean }>('SELECT usuario_id, activo FROM usuario WHERE public_id = $1', [pass.userPublicId]),
    );
    const user = u.rows[0];
    if (!user?.activo) return { resultado: 'QR_INVALIDO' };
    const usuarioId = String(user.usuario_id);
    const secret = await this.secrets.get(usuarioId);
    if (!secret) return { resultado: 'QR_INVALIDO' };
    const v = verifyPassCode(secret, pass, Date.now());
    if (v === 'INVALIDO') return { resultado: 'QR_INVALIDO' };
    return { resultado: v === 'VALIDO' ? 'VALIDO' : 'QR_EXPIRADO', usuarioId, restaurantPublicId: pass.restaurantPublicId };
  }

  // --- Validar un almuerzo ---------------------------------------------------------------------------------------

  async validate(dto: ValidarDto, key: string): Promise<ValidacionResponse> {
    if (Boolean(dto.codigoQr) === Boolean(dto.clienteId)) throw new BadRequestException('Envía codigoQr o clienteId (uno de los dos).');
    const qr = dto.codigoQr ? await this.checkQr(dto.codigoQr) : null;
    const canal = qr ? 'QR' : 'MANUAL';

    return this.db.forRequest(async (q) => {
      const ctx = (
        await q.query<{ public_id: string; personal_id: string }>(
          `SELECT r.public_id, ${PERSONAL_ACTUAL} AS personal_id FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
        )
      ).rows[0]!;
      const fail = async (resultado: Resultado, usuarioId?: string): Promise<ValidacionResponse> => {
        await q.query(
          `INSERT INTO intento_escaneo (restaurante_id, personal_id, usuario_id, canal, resultado) VALUES (app_tenant_id(), $1, $2, $3, $4)`,
          [ctx.personal_id, usuarioId ?? null, canal, resultado],
        );
        return {
          resultado,
          mensaje: RESULTADOS[resultado],
          descontado: false,
          cliente: null,
          consumo: null,
          plan: null,
          almuerzosRestantes: null,
          diasParaVencer: null,
        };
      };

      let clienteId = dto.clienteId;
      if (qr) {
        if (qr.resultado !== 'VALIDO') return fail(qr.resultado, qr.usuarioId);
        if (qr.restaurantPublicId && qr.restaurantPublicId !== ctx.public_id) return fail('OTRO_LOCAL', qr.usuarioId);
        const c = await q.query<{ cliente_id: string }>(
          'SELECT cliente_id FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = $1 AND activo',
          [qr.usuarioId],
        );
        if (!c.rows[0]) return fail('SIN_PLAN', qr.usuarioId);
        clienteId = String(c.rows[0].cliente_id);
      }
      const cliente = (
        await q.query<{ nombre: string }>(
          'SELECT nombre FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND activo',
          [clienteId],
        )
      ).rows[0];
      if (!cliente) throw new NotFoundException('Cliente no encontrado o inactivo.');
      if (dto.mesaLocalId) {
        const m = await q.query('SELECT 1 FROM mesa_local WHERE restaurante_id = app_tenant_id() AND mesa_local_id = $1 AND activo', [
          dto.mesaLocalId,
        ]);
        if (!m.rowCount) throw new BadRequestException('mesaLocalId no existe o está inactiva.');
      }
      // La misma clave no puede servir para otro cliente (la función de base solo mira restaurante + clave).
      const prev = await q.query<{ cliente_id: string }>(
        'SELECT cliente_id FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND clave_idempotencia = $1',
        [key],
      );
      if (prev.rows[0] && String(prev.rows[0].cliente_id) !== clienteId)
        throw new ConflictException('Esa Idempotency-Key ya se usó para otro cliente.');

      const r = await this.deduct(q, {
        clienteId: clienteId!,
        personalId: ctx.personal_id,
        key,
        canal,
        paraLlevar: dto.paraLlevar ?? false,
        mesaLocalId: dto.mesaLocalId,
      });
      return { ...r, cliente: { id: clienteId!, nombre: cliente.nombre } };
    });
  }

  /** Llama a la función atómica de la base (FIFO, duplicado, idempotencia, límite SaaS) y arma la respuesta. */
  async deduct(
    q: Queryable,
    a: {
      clienteId: string;
      personalId: string;
      key: string;
      canal: string;
      paraLlevar: boolean;
      ordenId?: string;
      mesaLocalId?: string;
      mesaCompartidaId?: string;
      omitirDuplicado?: boolean;
    },
  ): Promise<Omit<ValidacionResponse, 'cliente'>> {
    const f = (
      await q.query<{
        resultado: Resultado;
        consumo_id: string | null;
        almuerzos_restantes_total: number;
        dias_para_vencer: number | null;
      }>('SELECT * FROM fn_descontar_almuerzo(app_tenant_id(), $1, $2, $3, $4::canal_consumo_enum, $5, $9, $6, $7, $8)', [
        a.clienteId,
        a.personalId,
        a.key,
        a.canal,
        a.paraLlevar,
        a.mesaCompartidaId ?? null,
        a.mesaLocalId ?? null,
        a.omitirDuplicado ?? false,
        a.ordenId ?? null,
      ])
    ).rows[0]!;
    const descontado = f.resultado === 'OK' || f.resultado === 'OK_ADVERTENCIA';
    let consumo: ValidacionResponse['consumo'] = null;
    let plan: ValidacionResponse['plan'] = null;
    if (descontado && f.consumo_id) {
      const c = (
        await q.query<{ public_id: string; creado_en: Date; nombre_plan: string; vence_el: string }>(
          `SELECT c.public_id, c.creado_en, s.nombre_plan, s.vence_el::text AS vence_el FROM consumo_almuerzo c
           JOIN suscripcion_plan s ON s.suscripcion_id = c.suscripcion_id WHERE c.restaurante_id = app_tenant_id() AND c.consumo_id = $1`,
          [f.consumo_id],
        )
      ).rows[0]!;
      consumo = { id: c.public_id, creadoEn: c.creado_en, deshacerHasta: new Date(c.creado_en.getTime() + UNDO_SECONDS * 1000) };
      plan = { nombre: c.nombre_plan, venceEl: c.vence_el };
    }
    return {
      resultado: f.resultado,
      mensaje: RESULTADOS[f.resultado],
      descontado,
      consumo,
      plan,
      almuerzosRestantes: f.almuerzos_restantes_total,
      diasParaVencer: f.dias_para_vencer,
    };
  }

  // --- Deshacer (10 segundos) ------------------------------------------------------------------------------------

  async undo(consumoPublicId: string) {
    try {
      return await this.db.forRequest(async (q) => {
        const c = (
          await q.query<{ consumo_id: string; cantidad: number; viejo: boolean; revertido: boolean }>(
            `SELECT c.consumo_id, c.cantidad, c.creado_en < CURRENT_TIMESTAMP - make_interval(secs => $2) AS viejo,
                  EXISTS (SELECT 1 FROM consumo_almuerzo x WHERE x.revierte_a_consumo_id = c.consumo_id) AS revertido
             FROM consumo_almuerzo c WHERE c.restaurante_id = app_tenant_id() AND c.public_id = $1`,
            [consumoPublicId, UNDO_SECONDS],
          )
        ).rows[0];
        if (!c || c.cantidad !== 1) throw new NotFoundException('Validación no encontrada.');
        if (c.revertido) return { id: consumoPublicId, revertido: true };
        if (c.viejo)
          throw new ConflictException(
            `Solo se puede deshacer en los ${UNDO_SECONDS} segundos siguientes. Si hubo un error, regístralo como reclamo.`,
          );
        await q.query(`SELECT fn_revertir_consumo(app_tenant_id(), $1, ${PERSONAL_ACTUAL}, 'Deshacer en caja')`, [c.consumo_id]);
        return { id: consumoPublicId, revertido: true };
      });
    } catch (err) {
      // Dos "deshacer" a la vez: el índice único deja pasar solo uno; el otro ya está deshecho.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_consumo_un_solo_reverso') return { id: consumoPublicId, revertido: true };
      throw err;
    }
  }

  // --- Mesa compartida -------------------------------------------------------------------------------------------

  previewTable(mesaPublicId: string) {
    return this.db.forRequest(async (q) => this.tableView(q, await this.loadTable(q, mesaPublicId, false)), { readOnly: true });
  }

  /**
   * Valida toda la mesa de una vez. CADA_UNO: cada miembro paga con su plan. INVITO_YO: el anfitrión paga todos.
   * Quien no tenga plan queda "por cobrar" (se cobra como venta suelta). Repetir la petición no descuenta otra vez.
   */
  validateTable(mesaPublicId: string, key: string) {
    return this.db.forRequest(async (q) => {
      const mesa = await this.loadTable(q, mesaPublicId, true);
      if (mesa.validada_en) return { ...(await this.tableView(q, mesa)), yaValidada: true, resultados: [] };
      if (!['ABIERTA', 'EN_CAMINO'].includes(mesa.estado)) throw new ConflictException(`La mesa está ${mesa.estado.toLowerCase()}.`);
      const personalId = (await q.query<{ p: string }>(`SELECT ${PERSONAL_ACTUAL} AS p`)).rows[0]!.p;
      const members = await this.members(q, mesa.mesa_compartida_id);
      const host = members.find((m) => m.es_anfitrion);
      const resultados: { miembro: string; resultado: Resultado; descontado: boolean; consumoId: string | null }[] = [];
      for (const m of members) {
        const payer = mesa.modo === 'INVITO_YO' ? host?.cliente_id : m.cliente_id;
        if (!payer) {
          resultados.push({ miembro: m.nombre, resultado: 'SIN_PLAN', descontado: false, consumoId: null });
          continue;
        }
        const r = await this.deduct(q, {
          clienteId: String(payer),
          personalId,
          key: deriveKey(key, String(m.miembro_id)),
          canal: 'MESA',
          paraLlevar: m.para_llevar,
          mesaCompartidaId: String(mesa.mesa_compartida_id),
          mesaLocalId: mesa.mesa_local_id ? String(mesa.mesa_local_id) : undefined,
          omitirDuplicado: mesa.modo === 'INVITO_YO',
        });
        resultados.push({ miembro: m.nombre, resultado: r.resultado, descontado: r.descontado, consumoId: r.consumo?.id ?? null });
      }
      await q.query(
        `UPDATE mesa_compartida SET validada_en = CURRENT_TIMESTAMP, validada_por_personal_id = $2, estado = 'EN_MESA' WHERE mesa_compartida_id = $1`,
        [mesa.mesa_compartida_id, personalId],
      );
      const view = await this.tableView(q, { ...mesa, estado: 'EN_MESA', validada_en: new Date() });
      return {
        ...view,
        yaValidada: false,
        resultados,
        descontados: resultados.filter((r) => r.descontado).length,
        porCobrar: resultados.filter((r) => !r.descontado).length,
      };
    });
  }

  private async loadTable(q: Queryable, publicId: string, lock: boolean) {
    const r = await q.query<{
      mesa_compartida_id: string;
      modo: string;
      estado: string;
      validada_en: Date | null;
      hora_llegada: Date;
      mesa_local_id: string | null;
    }>(
      `SELECT mesa_compartida_id, modo, estado, validada_en, hora_llegada, mesa_local_id FROM mesa_compartida
        WHERE restaurante_id = app_tenant_id() AND public_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [publicId],
    );
    if (!r.rows[0]) throw new NotFoundException('Mesa no encontrada.');
    return r.rows[0];
  }

  private async members(q: Queryable, mesaId: string) {
    const r = await q.query<{
      miembro_id: string;
      nombre: string;
      es_anfitrion: boolean;
      para_llevar: boolean;
      cliente_id: string | null;
      disponibles: number;
    }>(
      `SELECT m.miembro_id, m.nombre, m.es_anfitrion, m.para_llevar, c.cliente_id,
              COALESCE((SELECT sum(s.almuerzos_restantes) FROM suscripcion_plan s
                         WHERE s.restaurante_id = m.restaurante_id AND s.cliente_id = c.cliente_id AND s.estado = 'ACTIVA'
                           AND s.vence_el >= (SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())), 0)::int AS disponibles
         FROM mesa_compartida_miembro m
         LEFT JOIN cliente_restaurante c ON c.restaurante_id = m.restaurante_id AND c.usuario_id = m.usuario_id AND c.activo
        WHERE m.mesa_compartida_id = $1 AND m.restaurante_id = app_tenant_id() ORDER BY m.miembro_id`,
      [mesaId],
    );
    return r.rows;
  }

  private async tableView(
    q: Queryable,
    mesa: { mesa_compartida_id: string; modo: string; estado: string; validada_en: Date | null; hora_llegada: Date },
  ) {
    const members = await this.members(q, mesa.mesa_compartida_id);
    const host = members.find((m) => m.es_anfitrion);
    return {
      modo: mesa.modo,
      estado: mesa.estado,
      horaLlegada: mesa.hora_llegada,
      validadaEn: mesa.validada_en,
      personas: members.length,
      // Cuántos almuerzos cubren los planes (según el modo) y cuántos habría que cobrar aparte.
      cubiertos:
        mesa.modo === 'INVITO_YO' ? Math.min(members.length, host?.disponibles ?? 0) : members.filter((m) => m.disponibles > 0).length,
      miembros: members.map((m) => ({
        nombre: m.nombre,
        esAnfitrion: m.es_anfitrion,
        paraLlevar: m.para_llevar,
        tieneCuenta: m.cliente_id !== null,
        almuerzosDisponibles: m.disponibles,
      })),
    };
  }
}

class CodigoQuery {
  @ApiPropertyOptional({ description: 'public_id del restaurante: el código solo vale en ese local' })
  @IsOptional()
  @Matches(UUID, { message: 'restaurante debe ser un UUID' })
  restaurante?: string;
}

@ApiTags('pase')
@ApiBearerAuth()
@Controller('v1/pase')
export class PassController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('codigo')
  @ApiOperation({
    summary: 'Código QR del comensal (cambia cada 30 segundos)',
    description: 'La app lo pide de nuevo cuando vence. Con `restaurante` el código solo vale en ese local.',
  })
  code(@CurrentUser() user: AuthUser, @Query() q: CodigoQuery) {
    return this.checkout.issueCode(user, q.restaurante?.toLowerCase());
  }

  @Post('rotar')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Invalidar todos mis códigos anteriores',
    description: 'Para un teléfono perdido o una captura de pantalla compartida.',
  })
  async rotate(@CurrentUser() user: AuthUser) {
    await this.checkout.rotateSecret(user);
  }
}

@ApiTags('caja')
@Controller('v1/caja')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Roles('DUENO', 'CAJERO')
  @Post('validar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Validar un almuerzo por QR o por búsqueda manual',
    description:
      'Siempre responde 200 con un `resultado`. Descuenta del plan que vence primero (FIFO). Resultados: ' +
      Object.entries(RESULTADOS)
        .map(([k, v]) => `**${k}**: ${v}`)
        .join(' · '),
  })
  @ApiOkResponse({ type: ValidacionResponse })
  validate(@Body() dto: ValidarDto, @IdempotencyKey() key: string) {
    return this.checkout.validate(dto, key);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('consumos/:id/deshacer')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deshacer una validación',
    description: `Solo en los ${UNDO_SECONDS} segundos siguientes; después → 409. Devuelve el almuerzo al plan.`,
  })
  undo(@Param('id', UuidPipe) id: string) {
    return this.checkout.undo(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Get('mesas/:id')
  @ApiOperation({
    summary: 'Vista previa de una mesa compartida',
    description: 'Quiénes vienen, quién paga y cuántos almuerzos cubren los planes.',
  })
  previewTable(@Param('id', UuidPipe) id: string) {
    return this.checkout.previewTable(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('mesas/:id/validar')
  @HttpCode(200)
  @ApiIdempotent()
  @ApiOperation({
    summary: 'Validar toda la mesa de una vez',
    description: 'CADA_UNO: cada quien con su plan. INVITO_YO: paga el anfitrión. Sin plan → por cobrar.',
  })
  validateTable(@Param('id', UuidPipe) id: string, @IdempotencyKey() key: string) {
    return this.checkout.validateTable(id, key);
  }
}
