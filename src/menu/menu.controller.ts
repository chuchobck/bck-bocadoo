import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { FechaOHoyPipe, IdPipe } from '../common/pipes';
import { ActualizarPlatoDto, AgotadoDto, CATEGORIAS, CopiarMenuDto, CrearPlatoDto, DefinirMenuDto } from './dto';
import { MenuService } from './menu.service';

class ListarPlatosQuery {
  @IsOptional() @IsIn(CATEGORIAS) categoria?: string;
  @IsOptional() @IsIn(['true', 'false']) soloActivos?: string;
}

@ApiTags('menú')
@Controller('v1/menu/platos')
export class DishesController {
  constructor(private readonly menu: MenuService) {}

  @Roles('DUENO', 'CAJERO')
  @Get()
  @ApiOperation({ summary: 'Catálogo de platos del restaurante' })
  list(@Query() q: ListarPlatosQuery) {
    return this.menu.listDishes(q.categoria, q.soloActivos === 'true');
  }

  @Roles('DUENO')
  @Post()
  @ApiOperation({ summary: 'Crear un plato en el catálogo' })
  create(@Body() dto: CrearPlatoDto) {
    return this.menu.createDish(dto);
  }

  @Roles('DUENO')
  @Patch(':id')
  @ApiOperation({ summary: 'Editar o desactivar un plato', description: 'Los platos no se borran: se desactivan.' })
  update(@Param('id', IdPipe) id: string, @Body() dto: ActualizarPlatoDto) {
    return this.menu.updateDish(id, dto);
  }
}

const FECHA = { name: 'fecha', description: 'AAAA-MM-DD o `hoy` (según la zona horaria del restaurante)', example: 'hoy' } as const;

@ApiTags('menú')
@Controller('v1/menu')
export class DailyMenuController {
  constructor(private readonly menu: MenuService) {}

  @Roles('DUENO', 'CAJERO')
  @Get(':fecha')
  @ApiParam(FECHA)
  @ApiOperation({ summary: 'Menú de un día (incluye borrador)' })
  get(@Param('fecha', FechaOHoyPipe) fecha: string) {
    return this.menu.getMenu(fecha);
  }

  @Roles('DUENO')
  @Put(':fecha')
  @ApiParam(FECHA)
  @ApiOperation({
    summary: 'Definir el menú del día',
    description:
      'Lista completa y libre: sin límite de sopas o segundos. Lo que quede fuera se quita; lo que se mantiene conserva su estado de agotado.',
  })
  set(@Param('fecha', FechaOHoyPipe) fecha: string, @Body() dto: DefinirMenuDto) {
    return this.menu.setMenu(fecha, dto);
  }

  @Roles('DUENO')
  @Post(':fecha/publicar')
  @HttpCode(200)
  @ApiParam(FECHA)
  @ApiOperation({ summary: 'Publicar el menú en la vitrina' })
  publish(@Param('fecha', FechaOHoyPipe) fecha: string) {
    return this.menu.publish(fecha);
  }

  @Roles('DUENO')
  @Post(':fecha/despublicar')
  @HttpCode(200)
  @ApiParam(FECHA)
  @ApiOperation({ summary: 'Sacar el menú de la vitrina' })
  unpublish(@Param('fecha', FechaOHoyPipe) fecha: string) {
    return this.menu.unpublish(fecha);
  }

  @Roles('DUENO')
  @Post(':fecha/copiar')
  @HttpCode(200)
  @ApiParam(FECHA)
  @ApiOperation({
    summary: 'Copiar el menú de otro día',
    description: 'Por defecto, el último menú anterior con platos. Queda como borrador y sin agotados.',
  })
  copy(@Param('fecha', FechaOHoyPipe) fecha: string, @Body() dto: CopiarMenuDto) {
    return this.menu.copy(fecha, dto.desde, dto.reemplazar ?? false);
  }

  @Roles('DUENO', 'CAJERO')
  @Patch(':fecha/items/:id/agotado')
  @ApiParam(FECHA)
  @ApiOperation({ summary: 'Marcar o quitar "agotado" en un plato del menú', description: 'Guarda a qué hora se acabó.' })
  setSoldOut(@Param('fecha', FechaOHoyPipe) fecha: string, @Param('id', IdPipe) id: string, @Body() dto: AgotadoDto) {
    return this.menu.setSoldOut(fecha, id, dto.agotado);
  }
}
