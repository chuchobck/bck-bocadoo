import { ApiProperty } from '@nestjs/swagger';

export class RestauranteResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id' }) id!: string;
  @ApiProperty({ example: 'Doña Rosa' }) nombre!: string;
  @ApiProperty({ example: 'dona-rosa' }) slug!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Almuerzos caseros' }) descripcionCorta!: string | null;
  @ApiProperty({ type: [String], example: ['casero'] }) etiquetas!: string[];
  @ApiProperty({ example: 'EC' }) paisCodigo!: string;
  @ApiProperty({ example: 1 }) ciudadId!: number;
  @ApiProperty({ type: Number, nullable: true, example: 12 }) zonaId!: number | null;
  @ApiProperty({ example: 'USD' }) monedaCodigo!: string;
  @ApiProperty({ example: 'America/Guayaquil' }) zonaHoraria!: string;
  @ApiProperty({ type: String, nullable: true }) direccion!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: -0.2 }) latitud!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: -78.49 }) longitud!: number | null;
  @ApiProperty({ type: String, nullable: true, example: '+593991234567' }) telefono!: string | null;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
  @ApiProperty({ example: 30, description: 'Puestos del local' }) puestos!: number;
  @ApiProperty({ description: 'Los comensales pueden anotar su mesa' }) anotarMesa!: boolean;
  @ApiProperty({ enum: ['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'] }) momentoCobro!: string;
  @ApiProperty({ example: 350, description: 'Centavos' }) precioSueltoCentavos!: number;
  @ApiProperty({ example: 25, description: 'Centavos' }) recargoParaLlevarCentavos!: number;
  @ApiProperty({ type: Date, nullable: true, description: 'Hasta cuándo dura "Local lleno"; null si no está activo' })
  llenoManualHasta!: Date | null;
  @ApiProperty({ example: 'ACTIVO', description: 'BORRADOR, ACTIVO, PAUSADO o BAJA' }) estado!: string;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty() actualizadoEn!: Date;
}

export class HorarioResponse {
  @ApiProperty({ example: 1, minimum: 1, maximum: 7, description: 'Día ISO: 1 = lunes … 7 = domingo' }) diaSemana!: number;
  @ApiProperty({ example: '12:00' }) abre!: string;
  @ApiProperty({ example: '15:30' }) cierra!: string;
}

export class MesaResponse {
  @ApiProperty({ example: '4', description: 'Id de la mesa dentro del local' }) id!: string;
  @ApiProperty({ example: 'Mesa 1' }) etiqueta!: string;
  @ApiProperty({ example: 4 }) capacidad!: number;
  @ApiProperty() activo!: boolean;
}

export class LlenoResponse {
  @ApiProperty() lleno!: boolean;
  @ApiProperty({ type: Date, nullable: true, description: 'Cuándo expira solo (20 minutos); null si se quitó' })
  llenoManualHasta!: Date | null;
}
