import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { CustomersModule } from './customers/customers';
import { PlansModule } from './plans/plans';
import { SalesModule } from './sales/sales';
import { AuthzModule } from './authz/authz.module';
import { DbModule } from './db/db.module';
import { DinerModule } from './diner/diner.module';
import { EventsModule } from './events/events';
import { FeedbackModule } from './feedback/feedback';
import { LoyaltyModule } from './loyalty/loyalty';
import { MenuModule } from './menu/menu.module';
import { OffersModule } from './offers/offers';
import { OrdersModule } from './orders/orders';
import { ReportsModule } from './reports/reports.module';
import { RestaurantModule } from './restaurant/restaurant.module';
import { SaasModule } from './saas/saas';
import { SecurityModule } from './security/security.module';
import { StaffModule } from './staff/staff.module';
import { TablesModule } from './tables/tables';
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
    CatalogModule,
    PlansModule,
    CustomersModule,
    SalesModule,
    CheckoutModule,
    DinerModule,
    OrdersModule,
    TablesModule,
    FeedbackModule,
    LoyaltyModule,
    OffersModule,
    ReportsModule,
    SaasModule,
    EventsModule,
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
