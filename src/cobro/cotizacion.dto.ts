import { ApiProperty } from '@nestjs/swagger';

// Forma de `Cotizacion` en la API (docs/spec-cobros.md, B.4 y E.1). Solo documentación para OpenAPI.

class LineaCotizacionResponse {
  @ApiProperty({
    example: 'almuerzo#1',
    description:
      'Id estable de la línea. Cada unidad cubierta por el plan es su propia línea `ref#k`. En una mesa empieza por el `ref` opaco del ' +
      'miembro (`<ref>:almuerzo#1`).',
  })
  ref!: string;
  @ApiProperty({
    example: '0',
    description: 'De quién es la línea: `"0"` en pedidos y QR; en una mesa, el `ref` opaco del miembro (`miembros[].ref`)',
  })
  personaRef!: string;
  @ApiProperty({
    example: '0',
    description: 'Quien paga la línea (el anfitrión en una mesa INVITO_YO). Mismo formato que `personaRef`',
  })
  pagadorRef!: string;
  @ApiProperty({ enum: ['ALMUERZO', 'A_LA_CARTA', 'EXTRA', 'BEBIDA', 'OFERTA', 'LIBRE'] }) tipo!: string;
  @ApiProperty({ type: String, nullable: true }) nombre!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'public_id del plato' }) platoId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) ofertaId!: string | null;
  @ApiProperty({ example: 1 }) cantidad!: number;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({ example: 350 }) precioUnitarioCentavos!: number;
  @ApiProperty({ example: 350 }) subtotalCentavos!: number;
  @ApiProperty({ example: 25 }) recargoUnitarioCentavos!: number;
  @ApiProperty({ example: 25 }) recargoCentavos!: number;
  @ApiProperty({ enum: ['PLAN', 'OFERTA', 'CAJA'], description: 'De dónde sale el precio de la línea' }) fuente!: string;
  @ApiProperty({ enum: ['PROPIO', 'ANFITRION'], description: 'Quién paga la línea' }) pagador!: string;
  @ApiProperty({ example: 350 }) cubiertoPorPlanCentavos!: number;
  @ApiProperty({ example: 25 }) porCobrarCentavos!: number;
  @ApiProperty({ type: String, nullable: true, enum: ['PLATO_AGOTADO', 'DUPLICADO', 'LIMITE_SAAS'] }) omitida!: string | null;
}

class TotalPagadorResponse {
  @ApiProperty({ example: '0', description: 'Mismo formato que `lineas[].pagadorRef`' }) pagadorRef!: string;
  @ApiProperty() subtotal!: number;
  @ApiProperty() recargo!: number;
  @ApiProperty() total!: number;
  @ApiProperty() cubierto!: number;
  @ApiProperty() saldo!: number;
}

export class AvisoCotizacionResponse {
  @ApiProperty({ enum: ['OFERTA_AGOTADA', 'OFERTA_EXPIRADA', 'PLATO_AGOTADO', 'DUPLICADO', 'LIMITE_SAAS', 'PLAN_NO_ALCANZA'] })
  codigo!: string;
  @ApiProperty({ type: String, nullable: true, description: 'El `ref` de la línea (en una mesa, con el `ref` opaco del miembro)' })
  lineaRef!: string | null;
}

export class CotizacionResponse {
  @ApiProperty({ example: true, description: 'Siempre `true` en esta entrega: es una estimación, el cobro real lo fija la caja' })
  estimada!: boolean;
  @ApiProperty({ type: [LineaCotizacionResponse] }) lineas!: LineaCotizacionResponse[];
  @ApiProperty({ type: [TotalPagadorResponse] }) porPagador!: TotalPagadorResponse[];
  @ApiProperty({ example: 950 }) subtotalCentavos!: number;
  @ApiProperty({ example: 50, description: 'Recargo para llevar por unidad (almuerzo y platos a la carta)' }) recargoCentavos!: number;
  @ApiProperty({ example: 1000 }) totalCentavos!: number;
  @ApiProperty({ example: 350, description: 'Lo que cubre el plan (precio del almuerzo × unidades cubiertas)' })
  cubiertoPorPlanCentavos!: number;
  @ApiProperty({ example: 650, description: 'total − cubierto' }) saldoPorCobrarCentavos!: number;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ type: [AvisoCotizacionResponse] }) avisos!: AvisoCotizacionResponse[];
}
