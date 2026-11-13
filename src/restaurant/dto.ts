import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Text } from '../security/sanitize';

/** Campos NOT NULL: si vienen, no pueden ser null. */
const present = () => ValidateIf((_: unknown, v: unknown) => v !== undefined);

export class UpdateRestauranteDto {
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(2, 100) nombre?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(200) descripcionCorta?: string | null;
  @ApiPropertyOptional({ type: [String], example: ['casero', 'vegetariano'] })
  @present()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 30, { each: true })
  etiquetas?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(200) direccion?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 6 }) @Min(-90) @Max(90) latitud?: number | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber({ maxDecimalPlaces: 6 }) @Min(-180) @Max(180) longitud?: number | null;
  @ApiPropertyOptional({ nullable: true, example: '+593990000001' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9][0-9]{6,14}$/, { message: 'telefono debe estar en formato E.164, p. ej. +593990000001' })
  telefono?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) @MaxLength(500) logoUrl?:
    string | null;
  @ApiPropertyOptional({ description: 'Puestos del local; base del cálculo de ocupación' })
  @present()
  @IsInt()
  @Min(1)
  @Max(1000)
  puestos?: number;
  @ApiPropertyOptional() @present() @IsBoolean() anotarMesa?: boolean;
  @ApiPropertyOptional({ enum: ['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'] })
  @present()
  @IsIn(['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'])
  momentoCobro?: string;
  @ApiPropertyOptional({ description: 'Precio del almuerzo suelto, en centavos' })
  @present()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  precioSueltoCentavos?: number;
  @ApiPropertyOptional({ description: 'Recargo por llevar, en centavos' })
  @present()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  recargoParaLlevarCentavos?: number;
  @ApiPropertyOptional({ nullable: true, description: 'zona_id del catálogo (debe ser de la ciudad del local)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  zonaId?: number | null;
}

const HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export class HorarioDto {
  @ApiProperty({ description: 'ISO: 1 = lunes … 7 = domingo' }) @IsInt() @Min(1) @Max(7) diaSemana!: number;
  @ApiProperty({ example: '12:00' }) @IsString() @Matches(HORA, { message: 'abre debe ser HH:MM' }) abre!: string;
  @ApiProperty({ example: '15:30' }) @IsString() @Matches(HORA, { message: 'cierra debe ser HH:MM' }) cierra!: string;
}

export class ReemplazarHorariosDto {
  @ApiProperty({ type: [HorarioDto], description: 'Reemplaza todos los horarios; [] los deja sin horario' })
  @IsArray()
  @ArrayMaxSize(21)
  @ValidateNested({ each: true })
  @Type(() => HorarioDto)
  horarios!: HorarioDto[];
}

export class CrearMesaDto {
  @ApiProperty({ example: 'Mesa 4' }) @Text() @IsString() @Length(1, 20) etiqueta!: string;
  @ApiProperty({ example: 4 }) @IsInt() @Min(1) @Max(50) capacidad!: number;
}

export class ActualizarMesaDto {
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(1, 20) etiqueta?: string;
  @ApiPropertyOptional() @present() @IsInt() @Min(1) @Max(50) capacidad?: number;
  @ApiPropertyOptional() @present() @IsBoolean() activo?: boolean;
}

export class LlenoDto {
  @ApiProperty({ description: 'true marca "Local lleno" por 20 minutos; false lo quita' }) @IsBoolean() lleno!: boolean;
}
