import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { QrSecretService } from './qr-secret.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';
import { UsersLookupService } from './users-lookup.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, SessionsService, UsersLookupService, QrSecretService],
  exports: [AuthService, PasswordService, TokenService, SessionsService, UsersLookupService, QrSecretService],
})
export class AuthModule {}
