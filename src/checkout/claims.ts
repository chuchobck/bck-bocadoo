import { Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { IdPipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { Text } from '../security/sanitize';
import { PERSONAL_ACTUAL } from './checkout';

const ESTADOS = ['PENDIENTE', 'DEVUELTO', 'RECHAZADO'] as const;

class ListarQuery {
  @IsOptional() @IsIn(ESTADOS) estado?: string;
}
class DevolverDto {
  @ApiPropertyOptional({ example: 'Tienes razón, te devolvimos el almuerzo.' })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 300)
  respuesta?: string;
}
class RechazarDto {
  @ApiProperty({ example: 'El almuerzo sí se sirvió ese día.' }) @Text() @IsString() @Length(1, 300) respuesta!: string;
}

interface Row {
  reclamo_id: string;
  estado: string;
  mensaje: string;
  respuesta: string | null;
  creado_en: Date;
  resuelto_en: Date | null;
  cliente_id: string;
  cliente_nombre: string;
  consumo_public_id: string;
  consumo_en: Date;
  canal: string;
  nombre_plan: string;
}

const SELECT = `SELECT r.reclamo_id, r.estado, r.mensaje, r.respuesta, r.creado_en, r.resuelto_en, c.cliente_id, c.nombre AS cliente_nombre,
       k.public_id AS consumo_public_id, k.creado_en AS consumo_en, k.canal, s.nombre_plan
  FROM reclamo r
  JOIN cliente_restaurante c ON c.restaurante_id = r.restaurante_id AND c.cliente_id = r.cliente_id
  JOIN consumo_almuerzo k ON k.restaurante_id = r.restaurante_id AND k.consumo_id = r.consumo_id
  JOIN suscripcion_plan s ON s.suscripcion_id = k.suscripcion_id`;

const toClaim = (r: Row) => ({
  id: String(r.reclamo_id),
  estado: r.estado,
  mensaje: r.mensaje,
  respuesta: r.respuesta,
  creadoEn: r.creado_en,
  resueltoEn: r.resuelto_en,
  cliente: { id: String(r.cliente_id), nombre: r.cliente_nombre },
  consumo: { id: r.consumo_public_id, fecha: r.consumo_en, canal: r.canal, plan: r.nombre_plan },
});

@Injectable()
export class ClaimsService {
  constructor(private readonly db: DbService) {}

  list(estado = 'PENDIENTE') {
    return this.db.forRequest(
      async (q) =>
        (
          await q.query<Row>(`${SELECT} WHERE r.restaurante_id = app_tenant_id() AND r.estado::text = $1 ORDER BY r.creado_en LIMIT 200`, [
            estado,
          ])
        ).rows.map(toClaim),
      { readOnly: true },
    );
  }

  /** Acepta el reclamo: devuelve el almuerzo al plan (consumo inverso) y lo marca DEVUELTO, en una transacción. */
  refund(id: string, respuesta?: string) {
    return this.db.forRequest(async (q) => {
      const r = await this.lock(q, id);
      if (r.estado === 'DEVUELTO') return this.one(q, id);
      if (r.estado !== 'PENDIENTE') throw new ConflictException('Ese reclamo ya fue rechazado.');
      const reverted = await q.query(
        'SELECT 1 FROM consumo_almuerzo WHERE restaurante_id = app_tenant_id() AND revierte_a_consumo_id = $1',
        [r.consumo_id],
      );
      if (reverted.rowCount) throw new ConflictException('Ese almuerzo ya había sido devuelto al plan. Rechaza el reclamo explicándolo.');
      await q.query(`SELECT fn_revertir_consumo(app_tenant_id(), $1, ${PERSONAL_ACTUAL}, $2)`, [r.consumo_id, `Reclamo #${id}`]);
      await q.query(
        `UPDATE reclamo SET estado = 'DEVUELTO', respuesta = $2, resuelto_en = CURRENT_TIMESTAMP, resuelto_por_personal_id = ${PERSONAL_ACTUAL}
          WHERE restaurante_id = app_tenant_id() AND reclamo_id = $1`,
        [id, respuesta ?? null],
      );
      return this.one(q, id);
    });
  }

  reject(id: string, respuesta: string) {
    return this.db.forRequest(async (q) => {
      const r = await this.lock(q, id);
      if (r.estado === 'RECHAZADO') return this.one(q, id);
      if (r.estado !== 'PENDIENTE') throw new ConflictException('Ese reclamo ya fue aceptado y el almuerzo devuelto.');
      await q.query(
        `UPDATE reclamo SET estado = 'RECHAZADO', respuesta = $2, resuelto_en = CURRENT_TIMESTAMP, resuelto_por_personal_id = ${PERSONAL_ACTUAL}
          WHERE restaurante_id = app_tenant_id() AND reclamo_id = $1`,
        [id, respuesta],
      );
      return this.one(q, id);
    });
  }

  private async lock(q: Queryable, id: string) {
    const r = await q.query<{ estado: string; consumo_id: string }>(
      'SELECT estado, consumo_id FROM reclamo WHERE restaurante_id = app_tenant_id() AND reclamo_id = $1 FOR UPDATE',
      [id],
    );
    if (!r.rows[0]) throw new NotFoundException('Reclamo no encontrado.');
    return r.rows[0];
  }

  private async one(q: Queryable, id: string) {
    return toClaim((await q.query<Row>(`${SELECT} WHERE r.restaurante_id = app_tenant_id() AND r.reclamo_id = $1`, [id])).rows[0]!);
  }
}

@ApiTags('reclamos')
@Controller('v1/reclamos')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Reclamos de comensales sobre un almuerzo', description: 'Por defecto, los pendientes.' })
  list(@Query() q: ListarQuery) {
    return this.claims.list(q.estado);
  }

  @Roles('DUENO')
  @Post(':id/devolver')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aceptar el reclamo y devolver el almuerzo al plan' })
  refund(@Param('id', IdPipe) id: string, @Body() dto: DevolverDto) {
    return this.claims.refund(id, dto.respuesta);
  }

  @Roles('DUENO')
  @Post(':id/rechazar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar el reclamo con una explicación' })
  reject(@Param('id', IdPipe) id: string, @Body() dto: RechazarDto) {
    return this.claims.reject(id, dto.respuesta);
  }
}
