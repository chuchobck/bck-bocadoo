import { ApiProperty } from '@nestjs/swagger';

export class ConsumoRevertidoResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del consumo' }) id!: string;
  @ApiProperty({ example: true }) revertido!: boolean;
}

class MiembroMesaResponse {
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
  @ApiProperty() esAnfitrion!: boolean;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({ description: 'Es cliente del local (tiene ficha)' }) tieneCuenta!: boolean;
  @ApiProperty({ example: 4 }) almuerzosDisponibles!: number;
}

export class MesaVistaResponse {
  @ApiProperty({ example: 'CADA_UNO', description: 'CADA_UNO o INVITO_YO' }) modo!: string;
  @ApiProperty({ example: 'ABIERTA' }) estado!: string;
  @ApiProperty() horaLlegada!: Date;
  @ApiProperty({ type: Date, nullable: true }) validadaEn!: Date | null;
  @ApiProperty({ example: 3 }) personas!: number;
  @ApiProperty({ example: 2, description: 'Cuántos almuerzos cubren los planes' }) cubiertos!: number;
  @ApiProperty({ type: [MiembroMesaResponse] }) miembros!: MiembroMesaResponse[];
}

class ResultadoMiembroResponse {
  @ApiProperty({ example: 'Ana Pérez' }) miembro!: string;
  @ApiProperty({ example: 'OK' }) resultado!: string;
  @ApiProperty() descontado!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) consumoId!: string | null;
}

export class MesaValidadaResponse extends MesaVistaResponse {
  @ApiProperty({ description: 'La mesa ya se había validado: no se descontó nada esta vez' }) yaValidada!: boolean;
  @ApiProperty({ type: [ResultadoMiembroResponse] }) resultados!: ResultadoMiembroResponse[];
  @ApiProperty({ example: 2 }) descontados!: number;
  @ApiProperty({ example: 1, description: 'Almuerzos a cobrar aparte' }) porCobrar!: number;
}

class ItemVentaResponse {
  @ApiProperty({ example: 'Almuerzo' }) nombre!: string;
  @ApiProperty() esAlmuerzo!: boolean;
  @ApiProperty({ example: 2 }) cantidad!: number;
  @ApiProperty({ example: 350 }) precioUnitarioCentavos!: number;
  @ApiProperty({ example: 700 }) subtotalCentavos!: number;
}

class PagoVentaResponse {
  @ApiProperty({ example: 'CONFIRMADO' }) estado!: string;
  @ApiProperty({ type: String, nullable: true, example: 'EFECTIVO' }) metodo!: string | null;
}

export class VentaResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id de la venta' }) id!: string;
  @ApiProperty({ example: 17, description: 'Número de ticket del día' }) ticket!: number;
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ example: 700, description: 'Centavos' }) totalCentavos!: number;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({ type: String, nullable: true, example: 'Mesa 3' }) mesaTexto!: string | null;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ description: 'true si ya se deshizo (pago inverso registrado)' }) deshecha!: boolean;
  @ApiProperty({ type: PagoVentaResponse, nullable: true }) pago!: PagoVentaResponse | null;
  @ApiProperty({ type: [ItemVentaResponse] }) items!: ItemVentaResponse[];
}

class MetodoCierreResponse {
  @ApiProperty({ example: 'EFECTIVO' }) metodo!: string;
  @ApiProperty({ example: 'Efectivo' }) nombre!: string;
  @ApiProperty() esEfectivo!: boolean;
  @ApiProperty({ example: 3000, description: 'Cobros de planes, centavos' }) planesCentavos!: number;
  @ApiProperty({ example: 1400, description: 'Ventas sueltas, pedidos y ofertas, centavos' }) posCentavos!: number;
  @ApiProperty({ example: 4400 }) totalCentavos!: number;
}

class CierreRegistradoResponse {
  @ApiProperty({ example: 4400 }) efectivoEsperadoCentavos!: number;
  @ApiProperty({ example: 4400 }) efectivoContadoCentavos!: number;
  @ApiProperty({ example: 0 }) diferenciaCentavos!: number;
  @ApiProperty({ type: String, nullable: true }) nota!: string | null;
  @ApiProperty() cerradoEn!: Date;
  @ApiProperty({ example: 'Luis' }) cerradoPor!: string;
  @ApiProperty({ description: 'Hubo cobros o reversos en efectivo después de cerrar: conviene reabrir y recontar' })
  movimientosDespuesDelCierre!: boolean;
}

export class CierreCajaResponse {
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ example: 4400 }) efectivoEsperadoCentavos!: number;
  @ApiProperty({ example: 6000 }) totalCentavos!: number;
  @ApiProperty({ type: [MetodoCierreResponse] }) porMetodo!: MetodoCierreResponse[];
  @ApiProperty({ example: 20 }) almuerzosServidos!: number;
  @ApiProperty({ example: 14 }) almuerzosConPlan!: number;
  @ApiProperty({ example: 6 }) almuerzosSueltos!: number;
  @ApiProperty({ example: 3 }) almuerzosParaLlevar!: number;
  @ApiProperty({ example: 1, description: 'Pagos por confirmar ese día' }) pagosPendientes!: number;
  @ApiProperty({ type: CierreRegistradoResponse, nullable: true, description: 'null si la caja no se cerró' })
  cierre!: CierreRegistradoResponse | null;
}

class ClienteRef {
  @ApiProperty({ example: '12' }) id!: string;
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
}
class ConsumoReclamado {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fecha!: Date;
  @ApiProperty({ example: 'QR' }) canal!: string;
  @ApiProperty({ example: 'Plan semanal' }) plan!: string;
}

export class ReclamoPersonalResponse {
  @ApiProperty({ example: '9' }) id!: string;
  @ApiProperty({ enum: ['PENDIENTE', 'DEVUELTO', 'RECHAZADO'] }) estado!: string;
  @ApiProperty({ example: 'Me descontaron dos veces' }) mensaje!: string;
  @ApiProperty({ type: String, nullable: true }) respuesta!: string | null;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty({ type: Date, nullable: true }) resueltoEn!: Date | null;
  @ApiProperty({ type: ClienteRef }) cliente!: ClienteRef;
  @ApiProperty({ type: ConsumoReclamado }) consumo!: ConsumoReclamado;
}
