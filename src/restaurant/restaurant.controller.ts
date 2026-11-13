import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IdPipe } from '../common/pipes';
import { Roles } from '../authz/roles.decorator';
import { ActualizarMesaDto, CrearMesaDto, LlenoDto, ReemplazarHorariosDto, UpdateRestauranteDto } from './dto';
import { RestaurantService } from './restaurant.service';
import { HorarioResponse, LlenoResponse, MesaResponse, RestauranteResponse } from './responses';

@ApiTags('restaurante')
@Controller('v1/restaurante')
export class RestaurantController {
  constructor(private readonly service: RestaurantService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Perfil de mi restaurante (el de x-restaurant-id)' })
  @ApiOkResponse({ type: RestauranteResponse })
  get() {
    return this.service.get();
  }

  @Roles('DUENO')
  @Patch()
  @ApiOperation({
    summary: 'Editar el perfil: nombre, contacto, puestos, precios, zona…',
    description: 'No cambia estado, slug, moneda ni país.',
  })
  @ApiOkResponse({ type: RestauranteResponse })
  update(@Body() dto: UpdateRestauranteDto) {
    return this.service.update(dto);
  }

  @Roles('DUENO')
  @Post('activar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Publicar el local en la vitrina', description: 'Exige precio de almuerzo suelto y al menos un horario.' })
  @ApiOkResponse({ type: RestauranteResponse })
  activate() {
    return this.service.activate();
  }

  @Roles('DUENO')
  @Post('pausar')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sacar el local de la vitrina sin borrarlo' })
  @ApiOkResponse({ type: RestauranteResponse })
  pause() {
    return this.service.pause();
  }

  @Roles('DUENO', 'CAJERO')
  @Get('horarios')
  @ApiOperation({ summary: 'Horarios de atención' })
  @ApiOkResponse({ type: HorarioResponse, isArray: true })
  horarios() {
    return this.service.getHorarios();
  }

  @Roles('DUENO')
  @Put('horarios')
  @ApiOperation({
    summary: 'Reemplazar todos los horarios',
    description: 'Varios tramos por día (p. ej. almuerzo y merienda); no se pueden traslapar.',
  })
  @ApiOkResponse({ type: HorarioResponse, isArray: true })
  replaceHorarios(@Body() dto: ReemplazarHorariosDto) {
    return this.service.replaceHorarios(dto.horarios);
  }

  @Roles('DUENO', 'CAJERO')
  @Get('mesas')
  @ApiOperation({ summary: 'Mesas del local' })
  @ApiOkResponse({ type: MesaResponse, isArray: true })
  mesas() {
    return this.service.listMesas();
  }

  @Roles('DUENO')
  @Post('mesas')
  @ApiOperation({ summary: 'Crear una mesa' })
  @ApiCreatedResponse({ type: MesaResponse })
  createMesa(@Body() dto: CrearMesaDto) {
    return this.service.createMesa(dto);
  }

  @Roles('DUENO')
  @Patch('mesas/:id')
  @ApiOperation({ summary: 'Editar o desactivar una mesa' })
  @ApiOkResponse({ type: MesaResponse })
  updateMesa(@Param('id', IdPipe) id: string, @Body() dto: ActualizarMesaDto) {
    return this.service.updateMesa(id, dto);
  }

  @Roles('DUENO', 'CAJERO')
  @Post('lleno')
  @HttpCode(200)
  @ApiOperation({ summary: 'Marcar o quitar "Local lleno"', description: 'Dura 20 minutos y expira solo.' })
  @ApiOkResponse({ type: LlenoResponse })
  setFull(@Body() dto: LlenoDto) {
    return this.service.setFull(dto.lleno);
  }
}
