import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../authz/public.decorator';
import { DbService } from '../db/db.service';

class HealthResponse {
  @ApiProperty({ example: 'ok' }) status!: string;
  @ApiProperty({ example: 'bck-bocadoo' }) servicio!: string;
  @ApiProperty({ example: '2026-11-13T17:00:00.000Z' }) hora!: string;
}

class RolesDbResponse {
  @ApiProperty({ example: 'bck_api', description: 'Rol con el que corre la API (sujeto a RLS)' }) app!: string;
  @ApiProperty({ example: 'bck_servicio', description: 'Rol de servicio (auth y cron)' }) service!: string;
}

class ReadyResponse {
  @ApiProperty({ example: 'ok' }) status!: string;
  @ApiProperty({ type: RolesDbResponse }) db!: RolesDbResponse;
}

@Public()
@ApiTags('salud')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio (liveness, no toca la base)' })
  @ApiOkResponse({ type: HealthResponse })
  check() {
    return { status: 'ok', servicio: 'bck-bocadoo', hora: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Listo para recibir tráfico (readiness): ambos roles de base de datos responden' })
  @ApiOkResponse({ type: ReadyResponse })
  @ApiResponse({ status: 503, description: 'La base de datos no responde (`ServiceUnavailable`)' })
  async ready() {
    try {
      const roles = await this.db.ping();
      return { status: 'ok', db: roles };
    } catch {
      // El detalle del fallo va al log (filtro de 5xx), nunca al cliente.
      throw new ServiceUnavailableException('Base de datos no disponible.');
    }
  }
}
