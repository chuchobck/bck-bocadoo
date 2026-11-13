import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { UsersLookupService } from '../auth/users-lookup.service';
import { Roles } from '../authz/roles.decorator';
import { IdPipe, IsoDatePipe } from '../common/pipes';
import { DbService, Queryable } from '../db/db.service';
import { RateLimit } from '../security/rate-limit';
import { Email, Text } from '../security/sanitize';
import { SUBS_SELECT, SubRow, toSub } from '../sales/subscriptions';

const E164 = /^\+[1-9][0-9]{6,14}$/;
const present = () => ValidateIf((_: unknown, v: unknown) => v !== undefined);

export class CrearClienteDto {
  @ApiProperty({ example: 'Juan Pérez' }) @Text() @IsString() @Length(1, 100) nombre!: string;
  @ApiPropertyOptional({ example: '+593990000123', description: 'E.164; único por restaurante' })
  @IsOptional()
  @IsString()
  @Matches(E164, { message: 'telefono debe estar en formato E.164, p. ej. +593990000123' })
  telefono?: string | null;
  @ApiPropertyOptional() @IsOptional() @Email() @IsEmail() @MaxLength(254) correo?: string | null;
  @ApiPropertyOptional() @IsOptional() @Text() @IsString() @MaxLength(300) nota?: string | null;
}

export class ActualizarClienteDto {
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(1, 100) nombre?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(E164, { message: 'telefono debe estar en formato E.164' })
  telefono?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Email() @IsEmail() @MaxLength(254) correo?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(300) nota?: string | null;
  @ApiPropertyOptional() @present() @IsBoolean() activo?: boolean;
}

export class MigrarCartulinaDto {
  @ApiProperty({ example: 7, description: 'Almuerzos que le quedan en la cartulina de papel' })
  @IsInt()
  @Min(1)
  @Max(200)
  almuerzosRestantes!: number;
  @ApiProperty({ example: '2026-12-15', description: 'Último día válido' }) @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) venceEl!: string;
  @ApiProperty({ example: 300, description: 'Valor de cada almuerzo (centavos): es lo que el local le debe al cliente' })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  precioUnitarioCentavos!: number;
  @ApiPropertyOptional({ example: 'Cartulina de papel' }) @IsOptional() @Text() @IsString() @Length(1, 80) nombrePlan?: string;
  @ApiPropertyOptional({ example: [1, 2, 3, 4, 5] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  diasValidos?: number[];
  @ApiPropertyOptional() @IsOptional() @Text() @IsString() @MaxLength(300) anotacion?: string;
}

export class VincularDto {
  @ApiProperty({ description: 'Correo de la cuenta de la app del comensal' }) @Email() @IsEmail() @MaxLength(254) correo!: string;
}

class BuscarQuery {
  @ApiPropertyOptional({ description: 'Nombre o teléfono' }) @IsOptional() @Text() @IsString() @Length(1, 60) q?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
  @ApiPropertyOptional({ description: 'nextCursor de la página anterior' }) @IsOptional() @IsString() @Length(1, 300) cursor?: string;
}

interface ClienteRow {
  cliente_id: string;
  nombre: string;
  telefono_e164: string | null;
  correo: string | null;
  nota: string | null;
  activo: boolean;
  vinculado: boolean;
  restantes: number;
  proximo_vencimiento: string | null;
}

const HOY = `(SELECT (CURRENT_TIMESTAMP AT TIME ZONE zona_horaria)::date FROM restaurante WHERE restaurante_id = app_tenant_id())`;

const CLIENTE_SELECT = `SELECT c.cliente_id, c.nombre, c.telefono_e164, c.correo::text AS correo, c.nota, c.activo, c.usuario_id IS NOT NULL AS vinculado,
       COALESCE(s.restantes, 0)::int AS restantes, s.proximo::text AS proximo_vencimiento
  FROM cliente_restaurante c
  LEFT JOIN LATERAL (SELECT sum(sp.almuerzos_restantes) AS restantes, min(sp.vence_el) AS proximo FROM suscripcion_plan sp
                      WHERE sp.restaurante_id = c.restaurante_id AND sp.cliente_id = c.cliente_id AND sp.estado = 'ACTIVA' AND sp.vence_el >= ${HOY}) s ON true`;

const toCliente = (c: ClienteRow) => ({
  id: c.cliente_id,
  nombre: c.nombre,
  telefono: c.telefono_e164,
  correo: c.correo,
  nota: c.nota,
  activo: c.activo,
  vinculadoApp: c.vinculado,
  almuerzosDisponibles: c.restantes,
  proximoVencimiento: c.proximo_vencimiento,
});

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** El teléfono repetido en el mismo local tiene su propio mensaje (el 409 genérico no ayuda en caja). */
function conflictOnPhone(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'uq_cliente_restaurante_telefono')
    throw new ConflictException('Ya existe un cliente con ese teléfono en este restaurante.');
  if (e.code === '23505' && e.constraint === 'uq_cliente_restaurante_usuario')
    throw new ConflictException('Esa cuenta ya está vinculada a otro cliente de este restaurante.');
  throw err;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersLookupService,
  ) {}

  search(q: string | undefined, limit: number, cursor?: string) {
    let cur: { n: string; i: string } | null = null;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { n?: unknown; i?: unknown };
        if (typeof c.n === 'string' && typeof c.i === 'string' && /^[1-9][0-9]{0,17}$/.test(c.i)) cur = { n: c.n, i: c.i };
      } catch {
        /* inválido */
      }
      if (!cur) throw new BadRequestException('cursor inválido.');
    }
    const digits = q?.replace(/[^0-9]/g, '') ?? '';
    const byPhone = q && /^[+\d\s-]+$/.test(q) && digits.length >= 3 ? digits : null;
    return this.db.forRequest(
      async (db) => {
        const r = await db.query<ClienteRow>(
          `${CLIENTE_SELECT}
            WHERE c.restaurante_id = app_tenant_id()
              AND ($1::text IS NULL OR c.nombre ILIKE '%' || $1 || '%')
              AND ($2::text IS NULL OR c.telefono_e164 LIKE '%' || $2 || '%')
              AND ($3::text IS NULL OR (c.nombre, c.cliente_id) > ($3, $4::bigint))
            ORDER BY c.nombre, c.cliente_id LIMIT $5`,
          [q && !byPhone ? likeEscape(q) : null, byPhone, cur?.n ?? null, cur?.i ?? null, limit + 1],
        );
        const page = r.rows.slice(0, limit);
        const last = page.at(-1);
        return {
          items: page.map(toCliente),
          nextCursor:
            r.rows.length > limit && last
              ? Buffer.from(JSON.stringify({ n: last.nombre, i: String(last.cliente_id) })).toString('base64url')
              : null,
        };
      },
      { readOnly: true },
    );
  }

  async create(d: CrearClienteDto) {
    try {
      return await this.db.forRequest(async (q) => {
        const r = await q.query<{ cliente_id: string }>(
          'INSERT INTO cliente_restaurante (restaurante_id, nombre, telefono_e164, correo, nota) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING cliente_id',
          [d.nombre, d.telefono ?? null, d.correo ?? null, d.nota ?? null],
        );
        return this.detailIn(q, r.rows[0]!.cliente_id);
      });
    } catch (e) {
      conflictOnPhone(e);
    }
  }

  detail(id: string) {
    return this.db.forRequest((q) => this.detailIn(q, id), { readOnly: true });
  }

  async update(id: string, d: ActualizarClienteDto) {
    const map: [keyof ActualizarClienteDto, string][] = [
      ['nombre', 'nombre'],
      ['telefono', 'telefono_e164'],
      ['correo', 'correo'],
      ['nota', 'nota'],
      ['activo', 'activo'],
    ];
    const present = map.filter(([k]) => d[k] !== undefined);
    if (!present.length) throw new BadRequestException('No hay nada que actualizar.');
    try {
      return await this.db.forRequest(async (q) => {
        const r = await q.query(
          `UPDATE cliente_restaurante SET ${present.map(([, c], i) => `${c} = $${i + 2}`).join(', ')}, actualizado_en = CURRENT_TIMESTAMP
            WHERE restaurante_id = app_tenant_id() AND cliente_id = $1`,
          [id, ...present.map(([k]) => d[k])],
        );
        if (!r.rowCount) throw new NotFoundException('Cliente no encontrado.');
        return this.detailIn(q, id);
      });
    } catch (e) {
      conflictOnPhone(e);
    }
  }

  /** Pasa a la app el saldo de una cartulina de papel: crea un plan MIGRADO sin cobro (ya se pagó en papel). */
  migrateCard(id: string, d: MigrarCartulinaDto) {
    new IsoDatePipe().transform(d.venceEl);
    return this.db.forRequest(async (q) => {
      await this.assertCustomer(q, id);
      const hoy = (await q.query<{ hoy: string }>(`SELECT ${HOY}::text AS hoy`)).rows[0]!.hoy;
      if (d.venceEl < hoy) throw new BadRequestException('venceEl no puede ser un día pasado.');
      await q.query(
        `INSERT INTO suscripcion_plan (restaurante_id, cliente_id, origen, nombre_plan, almuerzos_totales, almuerzos_restantes,
            precio_pagado_centavos, precio_unitario_centavos, moneda_codigo, dias_validos, vence_el, vendida_por_personal_id, anotacion)
         SELECT app_tenant_id(), $1, 'MIGRADA', $2, $3::int, $3::int, $3::bigint * $4::bigint, $4::bigint, r.moneda_codigo, COALESCE($5::smallint[], '{1,2,3,4,5}'), $6,
                (SELECT personal_id FROM personal_restaurante WHERE restaurante_id = app_tenant_id() AND usuario_id = app_user_id()), $7
           FROM restaurante r WHERE r.restaurante_id = app_tenant_id()`,
        [
          id,
          d.nombrePlan ?? 'Cartulina migrada',
          d.almuerzosRestantes,
          d.precioUnitarioCentavos,
          d.diasValidos ?? null,
          d.venceEl,
          d.anotacion ?? null,
        ],
      );
      return this.detailIn(q, id);
    });
  }

  /** Vincula la ficha del cliente con su cuenta de la app (por el correo de la cuenta). */
  async link(id: string, correo: string) {
    const user = await this.users.findActiveByEmail(correo);
    if (!user) throw new NotFoundException('No existe una cuenta con ese correo.');
    try {
      return await this.db.forRequest(async (q) => {
        const r = await q.query(
          'UPDATE cliente_restaurante SET usuario_id = $2, actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND cliente_id = $1',
          [id, user.usuarioId],
        );
        if (!r.rowCount) throw new NotFoundException('Cliente no encontrado.');
        return this.detailIn(q, id);
      });
    } catch (e) {
      conflictOnPhone(e);
    }
  }

  unlink(id: string) {
    return this.db.forRequest(async (q) => {
      const r = await q.query(
        'UPDATE cliente_restaurante SET usuario_id = NULL, actualizado_en = CURRENT_TIMESTAMP WHERE restaurante_id = app_tenant_id() AND cliente_id = $1',
        [id],
      );
      if (!r.rowCount) throw new NotFoundException('Cliente no encontrado.');
      return this.detailIn(q, id);
    });
  }

  private async assertCustomer(q: Queryable, id: string) {
    const r = await q.query('SELECT 1 FROM cliente_restaurante WHERE restaurante_id = app_tenant_id() AND cliente_id = $1 AND activo', [
      id,
    ]);
    if (!r.rowCount) throw new NotFoundException('Cliente no encontrado o inactivo.');
  }

  private async detailIn(q: Queryable, id: string) {
    const c = await q.query<ClienteRow>(`${CLIENTE_SELECT} WHERE c.restaurante_id = app_tenant_id() AND c.cliente_id = $1`, [id]);
    if (!c.rows[0]) throw new NotFoundException('Cliente no encontrado.');
    const subs = await q.query<SubRow>(
      `${SUBS_SELECT} WHERE s.restaurante_id = app_tenant_id() AND s.cliente_id = $1 ORDER BY s.comprada_en DESC`,
      [id],
    );
    return { ...toCliente(c.rows[0]), planes: subs.rows.map(toSub) };
  }
}

@ApiTags('clientes')
@Controller('v1/clientes')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({
    summary: 'Buscar clientes por nombre o teléfono',
    description: 'Paginación por cursor (máximo 50). Incluye almuerzos disponibles.',
  })
  search(@Query() q: BuscarQuery) {
    return this.customers.search(q.q, q.limit ?? 20, q.cursor);
  }

  @Roles('DUENO', 'CAJERO')
  @Post()
  @ApiOperation({ summary: 'Crear un cliente', description: 'Teléfono en E.164; repetido en el mismo restaurante → 409.' })
  create(@Body() dto: CrearClienteDto) {
    return this.customers.create(dto);
  }

  @Roles('DUENO', 'CAJERO')
  @Get(':id')
  @ApiOperation({ summary: 'Ficha del cliente con todos sus planes' })
  detail(@Param('id', IdPipe) id: string) {
    return this.customers.detail(id);
  }

  @Roles('DUENO', 'CAJERO')
  @Patch(':id')
  @ApiOperation({ summary: 'Editar o desactivar un cliente' })
  update(@Param('id', IdPipe) id: string, @Body() dto: ActualizarClienteDto) {
    return this.customers.update(id, dto);
  }

  @Roles('DUENO')
  @Post(':id/migrar-cartulina')
  @ApiOperation({ summary: 'Migrar el saldo de una cartulina de papel', description: 'Crea un plan de origen MIGRADA, sin cobro.' })
  migrate(@Param('id', IdPipe) id: string, @Body() dto: MigrarCartulinaDto) {
    return this.customers.migrateCard(id, dto);
  }

  @Roles('DUENO', 'CAJERO')
  @RateLimit('invite')
  @Post(':id/vincular')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Vincular el cliente con su cuenta de la app',
    description: 'Por el correo de la cuenta. Límite de intentos por hora.',
  })
  link(@Param('id', IdPipe) id: string, @Body() dto: VincularDto) {
    return this.customers.link(id, dto.correo);
  }

  @Roles('DUENO', 'CAJERO')
  @Post(':id/desvincular')
  @HttpCode(200)
  @ApiOperation({ summary: 'Quitar el vínculo con la cuenta de la app' })
  unlink(@Param('id', IdPipe) id: string) {
    return this.customers.unlink(id);
  }
}

@Module({ imports: [AuthModule], controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
