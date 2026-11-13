import { ApiProperty } from '@nestjs/swagger';

class ClienteRefResponse {
  @ApiProperty({ example: '12', description: 'Id del cliente dentro del local' }) id!: string;
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
}

class ReversoPagoResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: -1500, description: 'Centavos (negativo: pago inverso)' }) montoCentavos!: number;
}

class PagoPlanResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'CONFIRMADO', description: 'PENDIENTE, CONFIRMADO o RECHAZADO' }) estado!: string;
  @ApiProperty({ example: 'EFECTIVO' }) metodo!: string;
  @ApiProperty({ example: 1500, description: 'Centavos' }) montoCentavos!: number;
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ type: String, nullable: true }) comprobanteUrl!: string | null;
  @ApiProperty({ type: ReversoPagoResponse, nullable: true }) reverso!: ReversoPagoResponse | null;
}

/** Un plan vendido a un cliente, con su pago. */
export class PlanVendidoResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del plan vendido' }) id!: string;
  @ApiProperty({ type: ClienteRefResponse }) cliente!: ClienteRefResponse;
  @ApiProperty({ type: String, nullable: true, example: '3', description: 'Plantilla de la que salió; null si es una migración' }) planId!:
    string | null;
  @ApiProperty({ enum: ['VENTA', 'MIGRADA'], description: 'MIGRADA = saldo de la cartulina de papel' }) origen!: string;
  @ApiProperty({ example: 'Plan semanal' }) nombrePlan!: string;
  @ApiProperty({ example: 5 }) almuerzosTotales!: number;
  @ApiProperty({ example: 5 }) almuerzosRestantes!: number;
  @ApiProperty({ example: 1500, description: 'Centavos' }) precioPagadoCentavos!: number;
  @ApiProperty({ example: 300, description: 'Centavos por almuerzo' }) precioUnitarioCentavos!: number;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5] }) diasValidos!: number[];
  @ApiProperty() compradaEn!: Date;
  @ApiProperty({ example: '2026-11-27', description: 'Último día de validez (zona horaria del local)' }) venceEl!: string;
  @ApiProperty({ enum: ['ACTIVA', 'AGOTADA', 'VENCIDA', 'ANULADA'] }) estado!: string;
  @ApiProperty({ type: Date, nullable: true }) anuladaEn!: Date | null;
  @ApiProperty({ type: String, nullable: true }) anotacion!: string | null;
  @ApiProperty({ type: PagoPlanResponse, nullable: true }) pago!: PagoPlanResponse | null;
}

class PlanSolicitadoResponse {
  @ApiProperty({ example: '3' }) id!: string;
  @ApiProperty({ example: 'Plan semanal' }) nombre!: string;
  @ApiProperty({ example: 1500 }) precioCentavos!: number;
  @ApiProperty({ example: 5 }) almuerzos!: number;
}

export class SolicitudPendienteResponse {
  @ApiProperty({ example: '7' }) id!: string;
  @ApiProperty() creadaEn!: Date;
  @ApiProperty({ type: ClienteRefResponse }) cliente!: ClienteRefResponse;
  @ApiProperty({ type: PlanSolicitadoResponse }) plan!: PlanSolicitadoResponse;
}

export class SolicitudRechazadaResponse {
  @ApiProperty({ example: '7' }) id!: string;
  @ApiProperty({ enum: ['RECHAZADA'] }) estado!: string;
}
