import { ApiProperty } from '@nestjs/swagger';
import type { CotizacionRespuesta } from '../cobro/adaptador';
import { AvisoCotizacionResponse, CotizacionResponse } from '../cobro/cotizacion.dto';
import { CuentaResponse } from '../cobro/cuenta.dto';
import { SeleccionMiembroResponse } from '../tables/selection';

export class ConsumoRevertidoResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del consumo' }) id!: string;
  @ApiProperty({ example: true }) revertido!: boolean;
}

class MiembroMesaResponse {
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
  @ApiProperty() esAnfitrion!: boolean;
  @ApiProperty() paraLlevar!: boolean;
  @ApiProperty({
    description: 'Salió de la mesa (`POST /v1/mis/mesas/{id}/salir`): no cuenta en `personas`, no se cobra y su `cotizacion` es null',
  })
  salio!: boolean;
  @ApiProperty({ description: 'Es cliente del local (tiene ficha)' }) tieneCuenta!: boolean;
  @ApiProperty({ example: 4 }) almuerzosDisponibles!: number;
  @ApiProperty({
    type: SeleccionMiembroResponse,
    description: 'Lo que eligió este miembro (la caja ve la de todos). Vacía = aún no eligió.',
  })
  seleccion!: SeleccionMiembroResponse;
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización estimada de lo que pide este miembro con su plan de hoy (sin selección cuenta 1 almuerzo; en INVITO_YO paga el anfitrión). ' +
      'En `POST /v1/caja/mesas/{id}/validar` es la final (`estimada: false`) de lo que se le cobró; con `aplicarSeleccion: false`, la informativa de E.5 ' +
      '(1 almuerzo y su `paraLlevar`, con el plan de antes de descontar). `null` si el miembro salió o si el local no tiene precio de almuerzo.',
  })
  cotizacion!: CotizacionRespuesta | null;
}

export class MesaVistaResponse {
  @ApiProperty({ example: 'CADA_UNO', description: 'CADA_UNO o INVITO_YO' }) modo!: string;
  @ApiProperty({ example: 'ABIERTA' }) estado!: string;
  @ApiProperty() horaLlegada!: Date;
  @ApiProperty({ type: Date, nullable: true }) validadaEn!: Date | null;
  @ApiProperty({ example: 3, description: 'Miembros que siguen en la mesa (sin los que salieron)' }) personas!: number;
  @ApiProperty({ example: 2, description: 'Cuántos almuerzos cubren los planes' }) cubiertos!: number;
  @ApiProperty({ type: [MiembroMesaResponse] }) miembros!: MiembroMesaResponse[];
  @ApiProperty({
    type: CotizacionResponse,
    nullable: true,
    description:
      'Cotización de toda la mesa con la selección de cada miembro (sin los que salieron). Estimada en la vista previa; en `validar`, la final ' +
      '(`estimada: false`); con `aplicarSeleccion: false`, la informativa de 1 almuerzo por miembro.',
  })
  cotizacion!: CotizacionRespuesta | null;
}

class ResultadoMiembroResponse {
  @ApiProperty({ example: 'Ana Pérez' }) miembro!: string;
  @ApiProperty({
    example: 'OK',
    description:
      'El del escáner (OK, OK_ADVERTENCIA, SIN_PLAN, SIN_SALDO, VENCIDO, DIA_NO_VALIDO, DUPLICADO, LIMITE_SAAS) para el almuerzo de este miembro, ' +
      'o `SIN_ALMUERZO` si su selección no lleva almuerzo (solo con `aplicarSeleccion`).',
  })
  resultado!: string;
  @ApiProperty() descontado!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) consumoId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'Cuenta donde quedó lo de este miembro (en INVITO_YO, la del anfitrión). null si su pagador no tiene nada por cobrar.',
  })
  cuentaId!: string | null;
}

export class MesaValidadaResponse extends MesaVistaResponse {
  @ApiProperty({ description: 'La mesa ya se había validado: no se descontó nada esta vez (sí vienen sus `cuentas`)' })
  yaValidada!: boolean;
  @ApiProperty({ type: [ResultadoMiembroResponse], description: 'Uno por miembro que sigue en la mesa. Vacío si `yaValidada`.' })
  resultados!: ResultadoMiembroResponse[];
  @ApiProperty({ example: 2, description: 'Almuerzos descontados de planes' }) descontados!: number;
  @ApiProperty({
    example: 1,
    description:
      'Almuerzos a cobrar aparte. Con `aplicarSeleccion`: los almuerzos que van a una cuenta a precio suelto (no cuenta los omitidos por ' +
      'DUPLICADO o LIMITE_SAAS ni a quien no pidió almuerzo). Con `aplicarSeleccion: false`: miembros no descontados, como antes.',
  })
  porCobrar!: number;
  @ApiProperty({
    type: [CuentaResponse],
    description:
      'Cuentas de cobro de la mesa: una ABIERTA por pagador con algo por cobrar (una sola en INVITO_YO). Vacío con `aplicarSeleccion: false` ' +
      'o si nadie debe nada. En un reintento (`yaValidada`), las que la mesa ya tiene.',
  })
  cuentas!: CuentaResponse[];
  @ApiProperty({
    type: [AvisoCotizacionResponse],
    description: 'Avisos del cobro (PLAN_NO_ALCANZA, PLATO_AGOTADO, DUPLICADO, LIMITE_SAAS). Vacío en un reintento.',
  })
  avisos!: { codigo: string; lineaRef: string | null }[];
}

class ItemVentaResponse {
  @ApiProperty({ example: 'Almuerzo' }) nombre!: string;
  @ApiProperty() esAlmuerzo!: boolean;
  @ApiProperty({ example: 2 }) cantidad!: number;
  @ApiProperty({ example: 350 }) precioUnitarioCentavos!: number;
  @ApiProperty({ example: 700 }) subtotalCentavos!: number;
}

class PagoVentaResponse {
  @ApiProperty({
    format: 'uuid',
    description: 'public_id del pago: con él se confirma o rechaza un pago PENDIENTE (`POST /v1/pagos/{id}/confirmar`)',
  })
  id!: string;
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
  @ApiProperty({ example: 1400, description: 'Ventas sueltas, pedidos, ofertas y cuentas de cobro, centavos' }) posCentavos!: number;
  @ApiProperty({
    example: 500,
    description: 'De `posCentavos`, lo cobrado en cuentas de cobro (QR, pedido, mesa) con este método, neto de reversos. No suma aparte.',
  })
  cuentasCentavos!: number;
  @ApiProperty({
    example: 1400,
    description:
      'De `totalCentavos`, lo que dejó CONFIRMADO un cajero (al cobrar o al confirmar), neto de reversos: un reverso resta del grupo de quien ' +
      'confirmó el pago original. No suma aparte.',
  })
  confirmadoPorCajeroCentavos!: number;
  @ApiProperty({ example: 3000, description: 'De `totalCentavos`, lo que dejó CONFIRMADO el dueño, neto de reversos. No suma aparte.' })
  confirmadoPorDuenoCentavos!: number;
  @ApiProperty({
    example: 0,
    description:
      'De `totalCentavos`, pagos de antes de registrar quién confirma (sin dato), netos de reversos. Cajero + dueño + sin registro = `totalCentavos`.',
  })
  confirmadoSinRegistroCentavos!: number;
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

class CuentasAbiertasResponse {
  @ApiProperty({ example: 2, description: 'Cuentas de cobro ABIERTAS de ese día local' }) cantidad!: number;
  @ApiProperty({
    example: 850,
    description: 'Σ saldo pendiente de esas cuentas, centavos (lo pagado, aunque esté PENDIENTE, ya se descontó)',
  })
  saldoCentavos!: number;
}

class CuentasCobradasResponse {
  @ApiProperty({ example: 3, description: 'Cuentas de cobro COBRADAS de ese día local' }) cantidad!: number;
  @ApiProperty({
    example: 1200,
    description:
      'Cobrado en cuentas ese día (pagos CONFIRMADOS netos de reversos, todos los métodos), centavos. Ya está en `totalCentavos`.',
  })
  totalCentavos!: number;
}

export class CierreCajaResponse {
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ example: 4400 }) efectivoEsperadoCentavos!: number;
  @ApiProperty({ example: 6000 }) totalCentavos!: number;
  @ApiProperty({ type: [MetodoCierreResponse] }) porMetodo!: MetodoCierreResponse[];
  @ApiProperty({ example: 20 }) almuerzosServidos!: number;
  @ApiProperty({ example: 14 }) almuerzosConPlan!: number;
  @ApiProperty({
    example: 6,
    description:
      'Almuerzos vendidos a precio suelto: POS más líneas de almuerzo de cuentas COBRADAS (QR sin plan o con recargo, pedidos y mesas). ' +
      'Los de cuentas ABIERTAS o ANULADAS no cuentan; los del plan van en `almuerzosConPlan`.',
  })
  almuerzosSueltos!: number;
  @ApiProperty({ example: 3, description: 'Para llevar: planes, POS y cuentas COBRADAS' }) almuerzosParaLlevar!: number;
  @ApiProperty({ example: 1, description: 'Pagos por confirmar ese día' }) pagosPendientes!: number;
  @ApiProperty({
    type: CuentasAbiertasResponse,
    description:
      'Cuentas de cobro que siguen ABIERTAS (se fueron sin pagar o falta cobrar): se informan, no bloquean el cierre (I-15). No cambian los ' +
      'totales: los pagos de cuentas ya están en `porMetodo` (en `posCentavos`), una sola vez.',
  })
  cuentasAbiertas!: CuentasAbiertasResponse;
  @ApiProperty({
    type: CuentasCobradasResponse,
    description:
      'Lo cobrado en cuentas de cobro ese día. Informativo: ya está en `efectivoEsperadoCentavos` (la parte en efectivo) y en `totalCentavos`.',
  })
  cuentasCobradas!: CuentasCobradasResponse;
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
