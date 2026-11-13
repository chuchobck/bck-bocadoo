import { ApiProperty } from '@nestjs/swagger';
import { CATEGORIAS, SECCIONES } from './dto';

export class PlatoResponse {
  @ApiProperty({ example: '15', description: 'Id del plato en el catálogo del local' }) id!: string;
  @ApiProperty({ enum: CATEGORIAS }) categoria!: string;
  @ApiProperty({ enum: SECCIONES, nullable: true, type: String }) seccion!: string | null;
  @ApiProperty({ example: 'Seco de pollo' }) nombre!: string;
  @ApiProperty({ type: String, nullable: true }) descripcion!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 350, description: 'Centavos; null = solo dentro del almuerzo' }) precioCentavos!:
    number | null;
  @ApiProperty({ type: String, nullable: true }) fotoUrl!: string | null;
  @ApiProperty({ type: [String], example: [] }) etiquetas!: string[];
  @ApiProperty() activo!: boolean;
}

export class ItemMenuResponse {
  @ApiProperty({ example: '101', description: 'Id del renglón del menú' }) id!: string;
  @ApiProperty({ example: '15' }) platoId!: string;
  @ApiProperty({ example: 'Seco de pollo' }) nombre!: string;
  @ApiProperty({ enum: CATEGORIAS }) categoria!: string;
  @ApiProperty({ type: String, nullable: true }) descripcion!: string | null;
  @ApiProperty({ type: String, nullable: true }) fotoUrl!: string | null;
  @ApiProperty({ type: [String], example: [] }) etiquetas!: string[];
  @ApiProperty({ enum: SECCIONES, nullable: true, type: String }) seccion!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 350, description: 'Precio del catálogo (centavos)' }) precioCentavos!:
    number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Precio de ese día si difiere (centavos)' }) precioDelDiaCentavos!:
    number | null;
  @ApiProperty({ type: Number, nullable: true, example: 40, description: 'Porciones disponibles; null = sin límite' }) porciones!:
    number | null;
  @ApiProperty() agotado!: boolean;
  @ApiProperty({ type: Date, nullable: true, description: 'Hora en que se acabó' }) agotadoEn!: Date | null;
  @ApiProperty({ example: 1 }) orden!: number;
}

export class MenuDiaResponse {
  @ApiProperty({ example: '2026-11-13' }) fecha!: string;
  @ApiProperty({ description: 'false = borrador: los comensales no lo ven' }) publicado!: boolean;
  @ApiProperty({ type: Date, nullable: true }) publicadoEn!: Date | null;
  @ApiProperty({ type: [ItemMenuResponse] }) items!: ItemMenuResponse[];
}
