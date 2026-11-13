import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
  Min,
  Max,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Text } from '../security/sanitize';

export const CATEGORIAS = ['ALMUERZO', 'A_LA_CARTA', 'EXTRA', 'BEBIDA'] as const;
export const SECCIONES = ['JUGO', 'SOPA', 'FUERTE', 'POSTRE', 'ADICIONAL'] as const;

const present = () => ValidateIf((_: unknown, v: unknown) => v !== undefined);

export class CrearPlatoDto {
  @ApiProperty({ enum: CATEGORIAS }) @IsIn(CATEGORIAS) categoria!: (typeof CATEGORIAS)[number];
  @ApiPropertyOptional({ enum: SECCIONES, nullable: true, description: 'Sección habitual dentro del almuerzo' })
  @IsOptional()
  @IsIn(SECCIONES)
  seccion?: (typeof SECCIONES)[number] | null;
  @ApiProperty({ example: 'Seco de pollo' }) @Text() @IsString() @Length(1, 100) nombre!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(300) descripcion?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Centavos. Vacío = solo se sirve dentro del almuerzo' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  precioCentavos?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  fotoUrl?: string | null;
  @ApiPropertyOptional({ type: [String], example: ['vegetariano', 'picante'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 30, { each: true })
  etiquetas?: string[];
}

export class ActualizarPlatoDto {
  @ApiPropertyOptional({ enum: CATEGORIAS }) @present() @IsIn(CATEGORIAS) categoria?: (typeof CATEGORIAS)[number];
  @ApiPropertyOptional({ enum: SECCIONES, nullable: true }) @IsOptional() @IsIn(SECCIONES) seccion?: (typeof SECCIONES)[number] | null;
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(1, 100) nombre?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(300) descripcion?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @IsInt() @Min(0) @Max(100_000_000) precioCentavos?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  fotoUrl?: string | null;
  @ApiPropertyOptional({ type: [String] })
  @present()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 30, { each: true })
  etiquetas?: string[];
  @ApiPropertyOptional() @present() @IsBoolean() activo?: boolean;
}

export class ItemMenuDto {
  @ApiProperty({ description: 'Id del plato del catálogo' })
  @IsString()
  @Matches(/^[1-9][0-9]{0,17}$/, { message: 'platoId inválido' })
  platoId!: string;
  @ApiProperty({ enum: SECCIONES }) @IsIn(SECCIONES) seccion!: (typeof SECCIONES)[number];
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Precio de ese día si difiere del catálogo (centavos)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  precioCentavos?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Porciones disponibles; vacío = sin límite' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  porciones?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(1000) orden?: number;
}

export class DefinirMenuDto {
  @ApiProperty({ type: [ItemMenuDto], description: 'Menú completo del día, sin límite por sección. Quita lo que no esté en la lista.' })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ItemMenuDto)
  items!: ItemMenuDto[];
}

export class CopiarMenuDto {
  @ApiPropertyOptional({ example: '2026-11-12', description: 'Fecha de origen; por defecto, el último menú anterior con platos' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  desde?: string;
  @ApiPropertyOptional({ description: 'Si el día destino ya tiene platos, true los reemplaza' })
  @IsOptional()
  @IsBoolean()
  reemplazar?: boolean;
}

export class AgotadoDto {
  @ApiProperty() @IsBoolean() agotado!: boolean;
}
