import { ApiProperty } from '@nestjs/swagger';

export class PersonalResponse {
  @ApiProperty({ format: 'uuid', description: 'public_id del usuario' }) usuarioId!: string;
  @ApiProperty({ example: 'Luis Andrade' }) nombre!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Luis' }) nombreVisible!: string | null;
  @ApiProperty({ enum: ['DUENO', 'CAJERO'] }) rol!: string;
  @ApiProperty() activo!: boolean;
}
