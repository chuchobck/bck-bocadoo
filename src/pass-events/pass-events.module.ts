import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PassEventBus } from './bus';
import { DEFAULT_LIMITS, PASS_STREAM_LIMITS, PassEventsController, PassStreamHub, type PassStreamLimits } from './stream';

/** Eventos del pase en tiempo real: el bus lo usan caja y pedidos para avisar al comensal; el stream lo expone por SSE. */
@Global()
@Module({
  controllers: [PassEventsController],
  providers: [
    PassEventBus,
    PassStreamHub,
    {
      provide: PASS_STREAM_LIMITS,
      inject: [ENV],
      useFactory: (env: Env): PassStreamLimits => ({ ...DEFAULT_LIMITS, total: env.PASS_EVENTS_MAX_CONNECTIONS }),
    },
  ],
  exports: [PassEventBus],
})
export class PassEventsModule {}
