import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, SessionsService],
  exports: [AuthService, PasswordService, TokenService, SessionsService],
})
export class AuthModule {}
