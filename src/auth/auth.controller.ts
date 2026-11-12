import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../authz/public.decorator';
import { AuthService } from './auth.service';
import { RegisterDto, RegisterOwnerDto, RegisterResponseDto } from './dto';

const info = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Post('register') @HttpCode(201)
  @ApiOperation({ summary: 'Registrar una cuenta de comensal' })
  register(@Body() dto: RegisterDto, @Req() req: FastifyRequest): Promise<RegisterResponseDto> {
    return this.auth.register(dto, info(req));
  }

  @Public() @Post('register-owner') @HttpCode(201)
  @ApiOperation({ summary: 'Registrar una cuenta de dueño con su restaurante (en borrador)' })
  registerOwner(@Body() dto: RegisterOwnerDto, @Req() req: FastifyRequest): Promise<RegisterResponseDto> {
    return this.auth.registerOwner(dto, info(req));
  }
}
