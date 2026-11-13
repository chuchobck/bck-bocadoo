import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { DinerClaimsController, DinerClaimsService } from './claims';
import { HistoryController, HistoryService } from './history';
import { DinerPassController, DinerPassService } from './pass';

/** Lo que el comensal hace desde la app. Corre siempre con su userId y sin tenant (RLS del comensal). */
@Module({
  imports: [CheckoutModule],
  controllers: [DinerPassController, HistoryController, DinerClaimsController],
  providers: [DinerPassService, HistoryService, DinerClaimsService],
})
export class DinerModule {}
