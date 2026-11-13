import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { HistoryController, HistoryService } from './history';
import { DinerPassController, DinerPassService } from './pass';

/** Lo que el comensal hace desde la app. Corre siempre con su userId y sin tenant (RLS del comensal). */
@Module({
  imports: [CheckoutModule],
  controllers: [DinerPassController, HistoryController],
  providers: [DinerPassService, HistoryService],
})
export class DinerModule {}
