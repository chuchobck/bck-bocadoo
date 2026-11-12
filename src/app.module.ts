import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: loadEnv().LOG_LEVEL,
        genReqId: (req) => (req as { id?: string }).id ?? (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        autoLogging: false,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        transport: loadEnv().NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
