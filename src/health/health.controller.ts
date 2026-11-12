import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbService } from '../db/db.service';

@ApiTags('salud')
@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  @ApiOperation({ summary: 'Estado del servicio (liveness, no toca la base)' })
  check() {
    return { status: 'ok', servicio: 'bck-bocadoo', hora: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Listo para recibir tráfico (readiness): ambos roles de base de datos responden' })
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
