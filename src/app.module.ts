import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { AuthzModule } from './authz/authz.module';
import { DbModule } from './db/db.module';
import { MenuModule } from './menu/menu.module';
import { RestaurantModule } from './restaurant/restaurant.module';
import { SecurityModule } from './security/security.module';
import { StaffModule } from './staff/staff.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    SecurityModule,
    AuthModule,
    AuthzModule,
    RestaurantModule,
    StaffModule,
    MenuModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: loadEnv().LOG_LEVEL,
        genReqId: (req) => (req as { id?: string }).id ?? (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        autoLogging: false,
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.refreshToken',
          '*.accessToken',
        ],
        transport: loadEnv().NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
