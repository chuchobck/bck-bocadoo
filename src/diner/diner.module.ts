import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { DinerPassController, DinerPassService } from './pass';

/** Lo que el comensal hace desde la app. Corre siempre con su userId y sin tenant (RLS del comensal). */
@Module({
  imports: [CheckoutModule],
  controllers: [DinerPassController],
  providers: [DinerPassService],
})
export class DinerModule {}
