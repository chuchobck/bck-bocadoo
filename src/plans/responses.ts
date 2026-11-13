import { ApiProperty } from '@nestjs/swagger';

export class PlantillaPlanResponse {
  @ApiProperty({ example: '3', description: 'Id de la plantilla' }) id!: string;
  @ApiProperty({ example: 'SEMANAL', enum: ['SEMANAL', 'QUINCENAL', 'MENSUAL', 'LIBRE'] }) tipo!: string;
  @ApiProperty({ example: 'Plan semanal' }) nombre!: string;
  @ApiProperty({ example: 5 }) almuerzos!: number;
  @ApiProperty({ example: 1500, description: 'Centavos' }) precioCentavos!: number;
  @ApiProperty({ example: 14 }) vigenciaDias!: number;
  @ApiProperty({ type: Number, nullable: true, example: 20, description: 'Máximo de planes activos a la vez; null = sin límite' }) cupos!:
    number | null;
  @ApiProperty({ type: Number, nullable: true, example: 12 }) cuposDisponibles!: number | null;
  @ApiProperty({ example: 8, description: 'Planes activos vendidos de esta plantilla' }) vendidosActivos!: number;
  @ApiProperty({ type: [Number], example: [1, 2, 3, 4, 5] }) diasValidos!: number[];
  @ApiProperty({ type: [String], example: ['Sopa', 'Segundo'] }) incluye!: string[];
  @ApiProperty({ description: 'Se muestra en la vitrina pública' }) visibleEnMarketplace!: boolean;
  @ApiProperty() activo!: boolean;
}
