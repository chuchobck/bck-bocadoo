import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Roles } from '../authz/roles.decorator';
import { UuidPipe } from '../common/pipes';
import { RateLimit } from '../security/rate-limit';
import { Email, Text } from '../security/sanitize';
import { StaffService } from './staff.service';
import { PersonalResponse } from './responses';

class InviteCashierDto {
  @ApiProperty({ example: 'cajero@correo.com' }) @Email() @IsEmail() @MaxLength(254) correo!: string;
  @ApiPropertyOptional({ description: 'Nombre que verá el local; por defecto, el de su cuenta' })
  @IsOptional()
  @Text()
  @IsString()
  @Length(1, 60)
  nombreVisible?: string;
}

class SetActiveDto {
  @ApiProperty() @IsBoolean() activo!: boolean;
}

@ApiTags('personal')
@Controller('v1/restaurante/personal')
export class StaffController {
  constructor(private readonly service: StaffService) {}

  @Roles('DUENO')
  @Get()
  @ApiOperation({ summary: 'Personal del restaurante (dueño y cajeros)' })
  @ApiOkResponse({ type: PersonalResponse, isArray: true })
  list() {
    return this.service.list();
  }

  @Roles('DUENO')
  @RateLimit('invite')
  @Post('cajeros')
  @ApiOperation({
    summary: 'Agregar un cajero por su correo',
    description: 'La persona debe haberse registrado antes. Límite de intentos por hora.',
  })
  @ApiCreatedResponse({ type: PersonalResponse })
  invite(@Body() dto: InviteCashierDto) {
    return this.service.inviteCashier(dto.correo, dto.nombreVisible);
  }

  @Roles('DUENO')
  @Patch(':usuarioId')
  @ApiOperation({ summary: 'Activar o desactivar a un cajero', description: 'Un cajero desactivado pierde el acceso de inmediato.' })
  @ApiOkResponse({ type: PersonalResponse })
  setActive(@Param('usuarioId', UuidPipe) usuarioId: string, @Body() dto: SetActiveDto) {
    return this.service.setActive(usuarioId, dto.activo);
  }
}
