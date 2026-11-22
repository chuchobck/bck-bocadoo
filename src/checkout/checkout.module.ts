import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CuentasController, CuentasService } from '../cobro/cuentas';
import { CashController, CashService } from './cash';
import { CheckoutController, CheckoutService, PassController } from './checkout';
import { ClaimsController, ClaimsService } from './claims';
import { MovementsController, MovementsService } from './movements';
import { PosController, PosService } from './pos';

@Module({
  imports: [AuthModule],
  controllers: [
    PassController,
    CheckoutController,
    PosController,
    CashController,
    ClaimsController,
    MovementsController,
    CuentasController,
  ],
  providers: [CheckoutService, PosService, CashService, ClaimsService, MovementsService, CuentasService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
