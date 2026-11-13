import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';
import { UsersLookupService } from './users-lookup.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, SessionsService, UsersLookupService],
  exports: [AuthService, PasswordService, TokenService, SessionsService, UsersLookupService],
})
export class AuthModule {}
