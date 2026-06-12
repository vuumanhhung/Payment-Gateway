import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CheckoutService } from './checkout.service';

@Controller('api/payment-requests')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Get('targets')
  getTargets() {
    return this.checkoutService.getTargets();
  }

  @Post()
  create(@Body() body: { amount: number; gatewayName: string }) {
    return this.checkoutService.create(body);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.checkoutService.getById(id);
  }

  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.checkoutService.verify(id);
  }
}
