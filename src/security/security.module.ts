import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard, UserRateLimitGuard } from './rate-limit';
import { RefsMesaService } from './refs-mesa.service';
import { SecurityEventsService } from './security-events.service';

// Este módulo se importa antes que AuthzModule: el límite de peticiones corre antes que cualquier otro guard.
@Global()
@Module({
  providers: [
    SecurityEventsService,
    RefsMesaService,
    RateLimitGuard,
    UserRateLimitGuard,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
  ],
  exports: [SecurityEventsService, RateLimitGuard, UserRateLimitGuard],
})
export class SecurityModule {}
