import { ApiProperty } from '@nestjs/swagger';
import { PlanVendidoResponse } from '../sales/responses';

export class ClienteResponse {
  @ApiProperty({ example: '12', description: 'Id del cliente dentro del local' }) id!: string;
  @ApiProperty({ example: 'Ana Pérez' }) nombre!: string;
  @ApiProperty({ type: String, nullable: true, example: '+593991234567' }) telefono!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'ana@correo.com' }) correo!: string | null;
  @ApiProperty({ type: String, nullable: true }) nota!: string | null;
  @ApiProperty() activo!: boolean;
  @ApiProperty({ description: 'Tiene una cuenta de la app vinculada' }) vinculadoApp!: boolean;
  @ApiProperty({ example: 4, description: 'Suma de los planes vigentes' }) almuerzosDisponibles!: number;
  @ApiProperty({ type: String, nullable: true, example: '2026-11-27' }) proximoVencimiento!: string | null;
}

export class ClientePageResponse {
  @ApiProperty({ type: [ClienteResponse] }) items!: ClienteResponse[];
  @ApiProperty({ type: String, nullable: true, description: 'Cursor de la página siguiente; null = no hay más' }) nextCursor!:
    string | null;
}

export class ClienteDetalleResponse extends ClienteResponse {
  @ApiProperty({ type: [PlanVendidoResponse], description: 'Todos sus planes, del más reciente al más antiguo' })
  planes!: PlanVendidoResponse[];
}
