import { Module } from '@nestjs/common';
import { GatesModule } from 'src/gateways/gates.module';
import { PaymentsModule } from 'src/payments/payments.module';
import { AdminController, AdminPageController } from './admin.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminSessionGuard } from './admin-session.guard';
import { AdminService } from './admin.service';

@Module({
  imports: [GatesModule, PaymentsModule],
  controllers: [AdminController, AdminPageController],
  providers: [AdminAuthService, AdminSessionGuard, AdminService],
})
export class AdminModule {}
