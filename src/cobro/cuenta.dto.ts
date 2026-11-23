import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQuery, UUID_RE } from '../diner/common';
import { Text } from '../security/sanitize';
import { CotizacionResponse } from './cotizacion.dto';

// Cuentas de cobro en la API (docs/spec-cobros.md, E.1 y E.11). Montos siempre en centavos enteros.

export const METODOS_PAGO = ['EFECTIVO', 'TRANSFERENCIA', 'DEUNA'] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];
/** Tope de cualquier monto de la API: muy por encima de una cuenta real y lejos de 2⁵³. */
const MONTO_MAX = 1_000_000_000_000;

/** Campos del pago comunes a `CobroDto` y `CobrarCuentaDto` (sin herencia de validaciones de `metodoPago`). */
class PagoBaseDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Pago parcial; por defecto todo el saldo. Más que el saldo → 422 `MONTO_EXCEDE_SALDO`' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MONTO_MAX)
  montoCentavos?: number;
  @ApiPropertyOptional({
    description:
      'Transferencia o Deuna ya verificada; si no, el pago queda PENDIENTE. Efectivo siempre se confirma. El cajero que la confirma ' +
      'debe dar `referenciaExterna` (sin ella → 422 `REFERENCIA_PAGO_REQUERIDA`); el dueño no.',
  })
  @IsOptional()
  @IsBoolean()
  pagoConfirmado?: boolean;
  @ApiPropertyOptional({ description: 'URL https del comprobante (máx. 500)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  comprobanteUrl?: string;
  @ApiPropertyOptional({
    description:
      'Id del depósito o de Deuna. Obligatoria si un cajero envía `pagoConfirmado`. Repetida en el local → 409 `REFERENCIA_PAGO_REPETIDA`',
  })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 100)
  referenciaExterna?: string;
}

/**
 * `CobroDto` (E.1): pagar en el mismo paso que se crea la cuenta. Sin `metodoPago` solo se abre la cuenta. Con
 * `metodoPago`, `saldoEsperadoCentavos` es obligatorio: es lo que la caja vio y confirma.
 */
export class CobroDto extends PagoBaseDto {
  @ApiPropertyOptional({ enum: METODOS_PAGO, description: 'Sin él solo se abre la cuenta (queda ABIERTA)' })
  @IsOptional()
  @IsIn(METODOS_PAGO)
  metodoPago?: MetodoPago;
  @ApiPropertyOptional({
    example: 300,
    minimum: 0,
    description:
      'Saldo que la caja vio y confirma. Obligatorio con `metodoPago`. Sin él se compara con el `totalCentavos` del pedido. ' +
      'Si el saldo real es otro → 409 `SALDO_CAMBIO` sin descontar ni cobrar nada.',
  })
  @ValidateIf((o: CobroDto) => o.metodoPago !== undefined || o.saldoEsperadoCentavos !== undefined)
  @IsDefined({ message: 'saldoEsperadoCentavos es obligatorio con metodoPago' })
  @IsInt()
  @Min(0)
  @Max(MONTO_MAX)
  saldoEsperadoCentavos?: number;
}

/** `POST /v1/caja/cuentas/{id}/cobrar`: el pago con `metodoPago` y `saldoEsperadoCentavos` obligatorios. */
export class CobrarCuentaDto extends PagoBaseDto {
  @ApiProperty({ enum: METODOS_PAGO })
  @IsIn(METODOS_PAGO)
  metodoPago!: MetodoPago;
  @ApiProperty({ example: 725, minimum: 0, description: 'Saldo que la caja vio. Distinto del real → 409 `SALDO_CAMBIO`' })
  @IsInt()
  @Min(0)
  @Max(MONTO_MAX)
  saldoEsperadoCentavos!: number;
}

export class AnularCuentaDto {
  @ApiPropertyOptional({ example: 'El comensal se fue sin comer', maxLength: 200 })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 200)
  motivo?: string;
}

class PagadorCuentaResponse {
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
  @ApiProperty({ description: 'true solo en la cuenta del anfitrión de una mesa' }) esAnfitrion!: boolean;
}

class PagoCuentaResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: METODOS_PAGO }) metodo!: string;
  @ApiProperty({ example: 500, description: 'Negativo = reverso (al anular la cuenta)' }) montoCentavos!: number;
  @ApiProperty({ enum: ['PENDIENTE', 'CONFIRMADO', 'RECHAZADO'] }) estado!: string;
  @ApiProperty() creadoEn!: Date;
}

export class CuentaResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['PEDIDO', 'QR', 'MESA'] }) origen!: string;
  @ApiProperty({ enum: ['ABIERTA', 'COBRADA', 'ANULADA'] }) estado!: string;
  @ApiProperty({ enum: ['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'], description: 'Copia del local al crear la cuenta' }) momentoCobro!: string;
  @ApiProperty({ description: 'ANTES_DE_SERVIR con saldo pendiente: la caja debe cobrar antes de entregar' })
  debeCobrarseAntesDeServir!: boolean;
  @ApiProperty({ type: PagadorCuentaResponse }) pagador!: PagadorCuentaResponse;
  @ApiProperty({
    type: CotizacionResponse,
    description:
      'Las líneas de la cuenta (`estimada: false`), congeladas al crearla. Un reverso es una línea más con la cantidad y los montos en negativo y el mismo `ref`. `avisos` siempre vacío aquí: los avisos son de la operación que creó la cuenta.',
  })
  cotizacion!: CotizacionResponse;
  @ApiProperty({ example: 0, description: 'Σ pagos no rechazados (los PENDIENTE cuentan)' }) pagadoCentavos!: number;
  @ApiProperty({ example: 25, description: 'cotizacion.saldoPorCobrarCentavos − pagadoCentavos' }) saldoCentavos!: number;
  @ApiProperty({ type: [PagoCuentaResponse] }) pagos!: PagoCuentaResponse[];
  @ApiProperty() creadaEn!: Date;
  @ApiProperty({ type: Date, nullable: true }) cobradaEn!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) anuladaEn!: Date | null;
}

/** Un plato de la carta, extra o bebida que la caja agrega (E.4 `items` y E.11 `POST …/items`). */
export class ItemCajaDto {
  @ApiProperty({
    format: 'uuid',
    description: 'public_id de un plato con precio: de la carta fija (a la carta, extra, bebida) o del menú de hoy',
  })
  @Matches(UUID_RE, { message: 'plato debe ser un UUID' })
  plato!: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) cantidad!: number;
}

/** Lista de `items` de la caja: hasta 10 platos distintos (sin `paraLlevar` por ítem, D3: heredan el de la cuenta). */
export const ItemsCaja = () => (target: object, key: string) => {
  IsArray()(target, key);
  ArrayMaxSize(10)(target, key);
  ArrayUnique((e: ItemCajaDto) => String(e?.plato).toLowerCase())(target, key);
  ValidateNested({ each: true })(target, key);
  Type(() => ItemCajaDto)(target, key);
};

export class AgregarItemsDto {
  @ApiProperty({
    type: [ItemCajaDto],
    description: 'Platos a sumar a la cuenta. Un plato que ya está en la cuenta suma cantidad a su línea.',
  })
  @ItemsCaja()
  @ArrayMinSize(1)
  items!: ItemCajaDto[];
}

export const ESTADOS_CUENTA = ['ABIERTA', 'COBRADA', 'ANULADA', 'TODAS'] as const;
export const ORIGENES_CUENTA = ['PEDIDO', 'QR', 'MESA'] as const;

export class CuentasQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ESTADOS_CUENTA, default: 'TODAS' })
  @IsOptional()
  @IsIn(ESTADOS_CUENTA)
  estado?: (typeof ESTADOS_CUENTA)[number];
  @ApiPropertyOptional({ enum: ORIGENES_CUENTA, description: 'QR = validar en caja, con o sin consumo del plan' })
  @IsOptional()
  @IsIn(ORIGENES_CUENTA)
  origen?: (typeof ORIGENES_CUENTA)[number];
}

export class CuentasDelDiaResponse {
  @ApiProperty({ example: '2026-11-21', description: 'Día local del restaurante (zona horaria del local)' }) fecha!: string;
  @ApiProperty({ type: [CuentaResponse], description: 'De la más reciente a la más antigua' }) items!: CuentaResponse[];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null si no hay más páginas' }) nextCursor!: string | null;
}
