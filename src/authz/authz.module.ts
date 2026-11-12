import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [AuthModule],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AuthzModule {}
