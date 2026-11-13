import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Email, Text } from '../security/sanitize';

export class RegisterDto {
  @ApiProperty({ example: 'María Guamán' }) @Text() @IsString() @Length(2, 100) nombre!: string;
  @ApiProperty({ example: 'maria@correo.com' }) @Email() @IsEmail() @MaxLength(254) correo!: string;
  @ApiProperty({ minLength: 10, maxLength: 128 }) @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @ApiPropertyOptional({ example: 'maria.guaman' })
  @IsOptional()
  @Text()
  @IsString()
  @Matches(/^[a-z0-9._]{3,30}$/, { message: 'nombreUsuario: 3 a 30 caracteres entre a-z, 0-9, punto y guion bajo' })
  nombreUsuario?: string;
  @ApiProperty({ description: 'Debe ser true' })
  @IsBoolean()
  @Equals(true, { message: 'Debes aceptar los términos' })
  aceptaTerminos!: boolean;
}

export class RestauranteNuevoDto {
  @ApiProperty({ example: 'La Cuchara de San Blas' }) @Text() @IsString() @Length(2, 100) nombre!: string;
  @ApiProperty({ description: 'ciudad_id del catálogo (1 = Quito)', example: 1 }) @IsInt() @Min(1) ciudadId!: number;
}

export class RegisterOwnerDto extends RegisterDto {
  @ApiProperty({ type: RestauranteNuevoDto }) @ValidateNested() @Type(() => RestauranteNuevoDto) restaurante!: RestauranteNuevoDto;
}

export class LoginDto {
  @ApiProperty({ description: 'Correo o nombre de usuario', example: 'maria@correo.com' })
  @Email()
  @IsString()
  @Length(3, 254)
  identificador!: string;
  @ApiProperty() @IsString() @Length(1, 128) password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token opaco recibido en el login o en el refresh anterior' })
  @IsString()
  @Length(43, 43)
  refreshToken!: string;
}

export class TokenResponseDto {
  @ApiProperty({ description: 'JWT ES256 de vida corta (15 min)' }) accessToken!: string;
  @ApiProperty({ description: 'Opaco y rotativo: úsalo una sola vez en /v1/auth/refresh' }) refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: 'Bearer';
  @ApiProperty({ description: 'Segundos de vida del access token', example: 900 }) expiresIn!: number;
  @ApiProperty() usuario!: { id: string; nombre: string };
}

export class MeRestauranteDto {
  @ApiProperty({ format: 'uuid', description: 'public_id del restaurante: va en el encabezado `x-restaurant-id`' }) id!: string;
  @ApiProperty({ example: 'Doña Rosa' }) nombre!: string;
  @ApiProperty({ enum: ['DUENO', 'CAJERO'] }) rol!: string;
}

export class MeResponseDto {
  @ApiProperty({ example: { id: '0b6f3c1e-8c1a-4f0e-9d5a-6f1c2f7a9e10', nombre: 'María Guamán' } }) usuario!: {
    id: string;
    nombre: string;
  };
  @ApiProperty({ type: [MeRestauranteDto], description: 'Vacío para un comensal sin trabajo en ningún local' })
  restaurantes!: MeRestauranteDto[];
}

export class RegisterResponseDto {
  @ApiProperty() usuario!: { id: string; nombre: string; correo: string };
  @ApiPropertyOptional() restaurante?: { id: string; nombre: string; slug: string; estado: string };
}
