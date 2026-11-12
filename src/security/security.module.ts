import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit';
import { SecurityEventsService } from './security-events.service';

// Este módulo se importa antes que AuthzModule: el límite de peticiones corre antes que cualquier otro guard.
@Global()
@Module({
  providers: [SecurityEventsService, { provide: APP_GUARD, useClass: RateLimitGuard }],
  exports: [SecurityEventsService],
})
export class SecurityModule {}
