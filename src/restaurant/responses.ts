import { ApiProperty } from '@nestjs/swagger';
import { OcupacionResponse } from '../catalog/dto';

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
  @ApiProperty({ type: Number, nullable: true, example: 12, description: 'Cantidad de mesas (informativa); null si no se indicó' })
  mesas!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '*********0001',
    description: 'Cédula/RUC enmascarada: solo los últimos 4 dígitos. El valor completo no se devuelve nunca; null si no se indicó.',
  })
  cedulaRuc!: string | null;
  @ApiProperty({ example: 350, description: 'Centavos' }) precioSueltoCentavos!: number;
  @ApiProperty({ example: 350, description: 'Centavos. Igual a `precioSueltoCentavos` (mismo dato, nombre del perfil)' })
  precioAlmuerzoCentavos!: number;
  @ApiProperty({ type: Number, nullable: true, example: 200, description: 'Centavos; null = no se vende solo el segundo' })
  precioSoloSegundoCentavos!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 150, description: 'Centavos; null = no se vende solo la sopa' })
  precioSoloSopaCentavos!: number | null;
  @ApiProperty({ example: 25, description: 'Centavos' }) recargoParaLlevarCentavos!: number;
  @ApiProperty({ type: Date, nullable: true, description: 'Hasta cuándo dura "Local lleno"; null si no está activo' })
  llenoManualHasta!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'Hasta cuándo dura "Concurrido" manual; null si no está activo' })
  concurridoManualHasta!: Date | null;
  @ApiProperty({ example: 'ACTIVO', description: 'BORRADOR, ACTIVO, PAUSADO o BAJA' }) estado!: string;
  @ApiProperty() creadoEn!: Date;
  @ApiProperty() actualizadoEn!: Date;
}

/** Perfil del local para su personal (GET): suma la ocupación vigente, igual que la vitrina. */
export class MiRestauranteResponse extends RestauranteResponse {
  @ApiProperty({ description: 'true si no falta ningún dato de `datosPendientes`. Informativo: no bloquea ninguna operación.' })
  perfilCompleto!: boolean;

  @ApiProperty({
    type: [String],
    enum: ['cedulaRuc', 'telefono', 'direccion', 'coordenadas', 'mesas', 'puestos', 'precioAlmuerzo'],
    description:
      'Datos del perfil que faltan. `puestos` falta mientras el dueño no lo haya indicado; `precioAlmuerzo` mientras el precio sea 0; `coordenadas` si falta latitud o longitud.',
  })
  datosPendientes!: string[];

  @ApiProperty({
    description: 'true solo si hay menú publicado hoy y TODAS las sopas y TODOS los segundos (FUERTE) del día están agotados',
  })
  menuAgotado!: boolean;

  @ApiProperty({
    type: OcupacionResponse,
    nullable: true,
    description: 'Ocupación vigente (misma que ve el comensal). null si el local no está ACTIVO (p. ej. PAUSADO).',
  })
  ocupacion!: OcupacionResponse | null;
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
  @ApiProperty({ description: 'true solo si el nivel manual quedó en LLENO' }) lleno!: boolean;
  @ApiProperty({ enum: ['LIBRE', 'CONCURRIDO', 'LLENO'], description: 'Nivel manual aplicado' }) nivel!: string;
  @ApiProperty({ type: Date, nullable: true, description: 'Cuándo expira solo "Lleno" (20 minutos); null si no está activo' })
  llenoManualHasta!: Date | null;
  @ApiProperty({ type: Date, nullable: true, description: 'Cuándo expira solo "Concurrido" (20 minutos); null si no está activo' })
  concurridoManualHasta!: Date | null;
}
