import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Length, Matches, MaxLength, MinLength, Min, ValidateNested } from 'class-validator';
import { Email, Text } from '../security/sanitize';

export class RegisterDto {
  @ApiProperty({ example: 'María Guamán' }) @Text() @IsString() @Length(2, 100) nombre!: string;
  @ApiProperty({ example: 'maria@correo.com' }) @Email() @IsEmail() @MaxLength(254) correo!: string;
  @ApiProperty({ minLength: 10, maxLength: 128 }) @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @ApiPropertyOptional({ example: 'maria.guaman' })
  @IsOptional() @Text() @IsString() @Matches(/^[a-z0-9._]{3,30}$/, { message: 'nombreUsuario: 3 a 30 caracteres entre a-z, 0-9, punto y guion bajo' })
  nombreUsuario?: string;
  @ApiProperty({ description: 'Debe ser true' }) @IsBoolean() @Equals(true, { message: 'Debes aceptar los términos' }) aceptaTerminos!: boolean;
}

export class RestauranteNuevoDto {
  @ApiProperty({ example: 'La Cuchara de San Blas' }) @Text() @IsString() @Length(2, 100) nombre!: string;
  @ApiProperty({ description: 'ciudad_id del catálogo (1 = Quito)', example: 1 }) @IsInt() @Min(1) ciudadId!: number;
}

export class RegisterOwnerDto extends RegisterDto {
  @ApiProperty({ type: RestauranteNuevoDto }) @ValidateNested() @Type(() => RestauranteNuevoDto) restaurante!: RestauranteNuevoDto;
}

export class RegisterResponseDto {
  @ApiProperty() usuario!: { id: string; nombre: string; correo: string };
  @ApiPropertyOptional() restaurante?: { id: string; nombre: string; slug: string; estado: string };
}
