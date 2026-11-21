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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Text } from '../security/sanitize';
import { PerfilNegocioDto, present } from './profile.dto';

export class UpdateRestauranteDto extends PerfilNegocioDto {
  @ApiPropertyOptional() @present() @Text() @IsString() @Length(2, 100) nombre?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(200) descripcionCorta?: string | null;
  @ApiPropertyOptional({ type: [String], example: ['casero', 'vegetariano'] })
  @present()
  @IsArray()
  @ArrayMaxSize(10)
  @Text()
  @IsString({ each: true })
  @Length(1, 30, { each: true })
  etiquetas?: string[];
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  logoUrl?: string | null;
  @ApiPropertyOptional() @present() @IsBoolean() anotarMesa?: boolean;
  @ApiPropertyOptional({ enum: ['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'] })
  @present()
  @IsIn(['ANTES_DE_SERVIR', 'DESPUES_DE_SERVIR'])
  momentoCobro?: string;
  @ApiPropertyOptional({
    description:
      'Precio del almuerzo suelto, en centavos. Es el mismo dato que `precioAlmuerzoCentavos` (100..5000); se conserva por compatibilidad.',
  })
  @present()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  precioSueltoCentavos?: number;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'zona_id del catálogo (debe ser de la ciudad del local)' })
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

export const NIVELES_MANUALES = ['LIBRE', 'CONCURRIDO', 'LLENO'] as const;
export type NivelManual = (typeof NIVELES_MANUALES)[number];

export class LlenoDto {
  @ApiPropertyOptional({
    description:
      'Compatibilidad: true = nivel LLENO por 20 minutos; false = nivel LIBRE. Si también llega `nivel`, gana `nivel`. Debe venir `lleno` o `nivel`.',
  })
  @present()
  @IsBoolean()
  lleno?: boolean;

  @ApiPropertyOptional({
    enum: NIVELES_MANUALES,
    description:
      'Estado manual del local. LLENO y CONCURRIDO duran 20 minutos y expiran solos; LIBRE los quita. Tiene prioridad sobre `lleno`.',
  })
  @present()
  @IsIn(NIVELES_MANUALES)
  nivel?: NivelManual;
}
