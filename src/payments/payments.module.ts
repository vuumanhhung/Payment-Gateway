import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentService } from './payments.services';
import { GatesModule } from 'src/gateways/gates.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';

@Module({
  imports: [GatesModule],
  controllers: [PaymentsController, CheckoutController],
  providers: [PaymentService, CheckoutService],
  exports: [PaymentService],
})
export class PaymentsModule {}
