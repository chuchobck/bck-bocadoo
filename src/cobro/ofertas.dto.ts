import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';
import { UUID_RE } from '../diner/common';

/** Una oferta flash pedida como ítem (`ofertas` de un pedido o de la selección de una mesa). Solo ofertas con plato. */
export class OfertaItemDto {
  @ApiProperty({ format: 'uuid', description: 'public_id de la oferta flash (con plato) del local' })
  @Matches(UUID_RE, { message: 'oferta debe ser un UUID' })
  oferta!: string;
  @ApiProperty({ type: 'integer', example: 1, minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) cantidad!: number;
}

/** Una oferta del pedido o de la selección, con su precio de oferta. */
export class OfertaPedidaResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id de la oferta' }) id!: string;
  @ApiProperty() titulo!: string;
  @ApiProperty({ type: 'integer' }) cantidad!: number;
  @ApiProperty({ description: 'Precio de la oferta al pedir (centavos, congelado)' }) precioUnitarioCentavos!: number;
  @ApiProperty() subtotalCentavos!: number;
}
