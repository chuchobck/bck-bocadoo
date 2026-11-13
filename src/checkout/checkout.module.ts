import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CashController, CashService } from './cash';
import { CheckoutController, CheckoutService, PassController } from './checkout';
import { ClaimsController, ClaimsService } from './claims';
import { PosController, PosService } from './pos';

@Module({
  imports: [AuthModule],
  controllers: [PassController, CheckoutController, PosController, CashController, ClaimsController],
  providers: [CheckoutService, PosService, CashService, ClaimsService],
})
export class CheckoutModule {}
