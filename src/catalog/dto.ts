import { ApiProperty } from '@nestjs/swagger';

class ZonaResponse {
  @ApiProperty({ example: 12, description: 'zona_id del catálogo' }) id!: number;
  @ApiProperty({ example: 'La Floresta' }) nombre!: string;
}

class OcupacionResponse {
  @ApiProperty({
    enum: ['LIBRE', 'MODERADO', 'LLENO'],
    description: 'LIBRE (<50%), MODERADO (50–89%), LLENO (≥90% o "Local lleno" manual)',
  })
  nivel!: 'LIBRE' | 'MODERADO' | 'LLENO';
  @ApiProperty({ example: 40, description: 'Porcentaje de puestos ocupados (0–100)' }) porcentaje!: number;
  @ApiProperty() lleno!: boolean;
}

/** Tarjeta de un restaurante en la vitrina pública. */
export class RestauranteCardResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del restaurante' }) id!: string;
  @ApiProperty({ example: 'Doña Rosa' }) nombre!: string;
  @ApiProperty({ example: 'dona-rosa', description: 'Identificador legible para la URL' }) slug!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Almuerzos caseros de lunes a viernes' }) descripcionCorta!: string | null;
  @ApiProperty({ type: [String], example: ['casero', 'vegetariano'] }) etiquetas!: string[];
  @ApiProperty({ type: ZonaResponse, nullable: true }) zona!: ZonaResponse | null;
  @ApiProperty({ example: 1 }) ciudadId!: number;
  @ApiProperty({ type: String, nullable: true, example: 'Av. 12 de Octubre y Foch' }) direccion!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: -0.2 }) latitud!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: -78.49 }) longitud!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'https://cdn.ejemplo.com/logo.png' }) logoUrl!: string | null;
  @ApiProperty({ example: 350, description: 'Precio del almuerzo suelto, en centavos' }) precioSueltoCentavos!: number;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ description: 'Según el horario del local y su zona horaria' }) abiertoAhora!: boolean;
  @ApiProperty({ type: OcupacionResponse }) ocupacion!: OcupacionResponse;
}

export class RestauranteBusquedaResponse {
  @ApiProperty({ type: [RestauranteCardResponse] }) items!: RestauranteCardResponse[];
  @ApiProperty({ type: String, nullable: true, description: 'Pásalo como `cursor` para la página siguiente; null = no hay más' })
  nextCursor!: string | null;
}

class HorarioResponse {
  @ApiProperty({ example: 1, minimum: 1, maximum: 7, description: 'Día ISO: 1 = lunes … 7 = domingo' }) diaSemana!: number;
  @ApiProperty({ example: '12:00' }) abre!: string;
  @ApiProperty({ example: '15:30' }) cierra!: string;
}

class PlatoVitrinaResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del plato' }) id!: string;
  @ApiProperty({ example: 'Seco de pollo' }) nombre!: string;
  @ApiProperty({ type: String, nullable: true }) descripcion!: string | null;
  @ApiProperty({ type: String, nullable: true }) fotoUrl!: string | null;
  @ApiProperty({ type: [String], example: [] }) etiquetas!: string[];
  @ApiProperty({ type: Number, nullable: true, example: 350, description: 'Centavos; null = solo se sirve dentro del almuerzo' })
  precioCentavos!: number | null;
  @ApiProperty() agotado!: boolean;
}

class SeccionMenuResponse {
  @ApiProperty({ example: 'FUERTE' }) seccion!: string;
  @ApiProperty({ type: [PlatoVitrinaResponse] }) platos!: PlatoVitrinaResponse[];
}

class MenuHoyResponse {
  @ApiProperty({ example: '2026-11-13', description: 'Hoy en la zona horaria del local' }) fecha!: string;
  @ApiProperty({ description: 'false si el menú de hoy no se publicó: `secciones` viene vacío' }) publicado!: boolean;
  @ApiProperty({ type: [SeccionMenuResponse] }) secciones!: SeccionMenuResponse[];
}

class PlanVitrinaResponse {
  @ApiProperty({
    example: '3',
    description: 'Id de la plantilla de plan; es el `planId` de `POST /v1/restaurantes/{slug}/solicitudes-plan`',
  })
  id!: string;
  @ApiProperty({ example: 'SEMANAL' }) tipo!: string;
  @ApiProperty({ example: 'Plan semanal' }) nombre!: string;
  @ApiProperty({ example: 5 }) almuerzos!: number;
  @ApiProperty({ example: 1500, description: 'Centavos' }) precioCentavos!: number;
  @ApiProperty({ example: 14 }) vigenciaDias!: number;
  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5] }) diasValidos!: number[];
  @ApiProperty({ type: [String], example: ['Sopa', 'Segundo'] }) incluye!: string[];
}

export class RestauranteDetalleResponse extends RestauranteCardResponse {
  @ApiProperty({ type: String, nullable: true, example: '+593991234567' }) telefono!: string | null;
  @ApiProperty({ type: [HorarioResponse] }) horarios!: HorarioResponse[];
  @ApiProperty({ type: MenuHoyResponse }) menuHoy!: MenuHoyResponse;
  @ApiProperty({ type: [PlanVitrinaResponse] }) planes!: PlanVitrinaResponse[];
}

export class SolicitudPlanCreadaResponse {
  @ApiProperty({ example: '7', description: 'Id de la solicitud' }) id!: string;
  @ApiProperty({ enum: ['PENDIENTE'] }) estado!: 'PENDIENTE';
  @ApiProperty({ example: 'Plan semanal' }) plan!: string;
  @ApiProperty() creadaEn!: Date;
}

export class CodigoPaseResponse {
  @ApiProperty({ description: 'Texto que se dibuja como QR. Cambia cada 30 s.', example: 'BCD1.…' }) codigo!: string;
  @ApiProperty({ example: 30 }) validoSegundos!: number;
  @ApiProperty({ description: 'Cuándo deja de servir este código (la caja acepta además ±1 paso)' }) expiraEn!: Date;
}
