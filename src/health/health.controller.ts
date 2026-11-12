import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('salud')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Estado del servicio' })
  check() {
    return { status: 'ok', servicio: 'bck-bocadoo', hora: new Date().toISOString() };
  }
}
