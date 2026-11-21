import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Text } from '../security/sanitize';
import { ejemploCedulaRuc } from './country/ejemplos';

/** Campos NOT NULL: si vienen, no pueden ser null. */
export const present = () => ValidateIf((_: unknown, v: unknown) => v !== undefined);

/**
 * Datos de negocio opcionales del restaurante. Los comparten `register-owner` (dentro de `restaurante`) y
 * `PATCH /v1/restaurante`. Aquí solo se valida la forma; las reglas por país (teléfono, cédula/RUC, coordenadas dentro
 * del país, puestos ≥ mesas) las aplica `validarPerfil` porque necesitan el país y los valores ya guardados.
 */
export class PerfilNegocioDto {
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @Text() @IsString() @MaxLength(200) direccion?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: -0.2 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitud?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: -78.49 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitud?: number | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0991234567',
    description:
      'Ecuador: móvil 09XXXXXXXX (10 dígitos); también acepta el mismo número en E.164 (+5939XXXXXXXX). Se guarda y responde en E.164.',
  })
  @IsOptional()
  @Text()
  @IsString()
  @MaxLength(16)
  telefono?: string | null;
  @ApiPropertyOptional({ description: 'Puestos del local; base del cálculo de ocupación (1..1000)' })
  @present()
  @IsInt()
  @Min(1)
  @Max(1000)
  puestos?: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 200,
    description: 'Cantidad de mesas del local (informativa). Debe ser ≤ puestos; si solo llega una de las dos se compara con la guardada.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  mesas?: number | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: ejemploCedulaRuc(),
    description:
      'Cédula (10 dígitos) o RUC (13) válidos del país del local. Dato privado: nunca sale en endpoints públicos y en GET /v1/restaurante se enmascara.',
  })
  @IsOptional()
  @Text()
  @IsString()
  @Matches(/^[0-9]{10}([0-9]{3})?$/, { message: 'cedulaRuc debe tener 10 (cédula) o 13 (RUC) dígitos' })
  cedulaRuc?: string | null;
  @ApiPropertyOptional({ minimum: 100, maximum: 5000, example: 300, description: 'Precio del almuerzo, en centavos enteros (100..5000)' })
  @present()
  @IsInt()
  @Min(100)
  @Max(5000)
  precioAlmuerzoCentavos?: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 5000,
    description: 'Precio de solo el segundo, en centavos; null = no se vende',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  precioSoloSegundoCentavos?: number | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 5000,
    description: 'Precio de solo la sopa, en centavos; null = no se vende',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  precioSoloSopaCentavos?: number | null;
  @ApiPropertyOptional({ description: 'Recargo por llevar, en centavos. Los locales nuevos parten en 25.' })
  @present()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  recargoParaLlevarCentavos?: number;
}
