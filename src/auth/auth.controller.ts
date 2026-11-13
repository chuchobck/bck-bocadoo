import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser, type AuthUser } from '../authz/current-user';
import { Public } from '../authz/public.decorator';
import { ApiProblems } from '../common/errors';
import { DbService } from '../db/db.service';
import { RateLimit } from '../security/rate-limit';
import { AuthService } from './auth.service';
import { LoginDto, MeResponseDto, RefreshDto, RegisterDto, RegisterOwnerDto, RegisterResponseDto, TokenResponseDto } from './dto';
import { SessionsService } from './sessions.service';

const info = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly db: DbService,
  ) {}

  @Public()
  @RateLimit('signup')
  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar una cuenta de comensal' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiProblems({ 409: ['CONFLICT'], 429: ['TOO_MANY_REQUESTS'] })
  register(@Body() dto: RegisterDto, @Req() req: FastifyRequest): Promise<RegisterResponseDto> {
    return this.auth.register(dto, info(req));
  }

  @Public()
  @RateLimit('signup')
  @Post('register-owner')
  @HttpCode(201)
  @ApiOperation({ summary: 'Registrar una cuenta de dueño con su restaurante (en borrador)' })
  @ApiCreatedResponse({ type: RegisterResponseDto })
  @ApiProblems({ 400: ['BAD_REQUEST'], 409: ['CONFLICT'], 429: ['TOO_MANY_REQUESTS'] })
  registerOwner(@Body() dto: RegisterOwnerDto, @Req() req: FastifyRequest): Promise<RegisterResponseDto> {
    return this.auth.registerOwner(dto, info(req));
  }

  @Public()
  @RateLimit('auth')
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Iniciar sesión con correo o nombre de usuario' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiProblems({ 429: ['TOO_MANY_REQUESTS'] })
  login(@Body() dto: LoginDto, @Req() req: FastifyRequest): Promise<TokenResponseDto> {
    return this.auth.login(dto, info(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotar el refresh token y obtener un access token nuevo',
    description: 'Cada refresh token sirve una sola vez. Reutilizar uno viejo revoca toda la sesión.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  refresh(@Body() dto: RefreshDto, @Req() req: FastifyRequest): Promise<TokenResponseDto> {
    return this.auth.refresh(dto.refreshToken, info(req));
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cerrar la sesión de este dispositivo' })
  @ApiNoContentResponse({ description: 'Sesión cerrada (también si el token ya no valía)' })
  async logout(@Body() dto: RefreshDto, @Req() req: FastifyRequest): Promise<void> {
    await this.sessions.logout(dto.refreshToken, info(req));
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cerrar la sesión en todos los dispositivos' })
  @ApiNoContentResponse({ description: 'Todas las sesiones del usuario revocadas' })
  async logoutAll(@CurrentUser() user: AuthUser, @Req() req: FastifyRequest): Promise<void> {
    await this.sessions.logoutAll(user.userId, info(req));
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Mi usuario y los restaurantes donde trabajo' })
  @ApiOkResponse({ type: MeResponseDto })
  async me(@CurrentUser() user: AuthUser): Promise<MeResponseDto> {
    // Corre como bck_api con el usuario del request: RLS solo deja ver las filas propias.
    return this.db.forRequest(
      async (q) => {
        const u = await q.query<{ nombre: string }>('SELECT nombre FROM usuario WHERE usuario_id = app_user_id()');
        const r = await q.query<{ id: string; nombre: string; rol: string }>(
          `SELECT r.public_id AS id, r.nombre, p.rol FROM personal_restaurante p
           JOIN restaurante r ON r.restaurante_id = p.restaurante_id
          WHERE p.usuario_id = app_user_id() AND p.activo ORDER BY r.nombre`,
        );
        return { usuario: { id: user.publicId, nombre: u.rows[0]?.nombre ?? '' }, restaurantes: r.rows };
      },
      { readOnly: true },
    );
  }
}
