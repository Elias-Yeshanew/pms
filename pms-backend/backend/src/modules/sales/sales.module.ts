import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { InventoryModule } from '../inventory/inventory.module';
import { CustomersService } from './customers.service';
import { DiscountsService } from './discounts.service';
import { PaymentMethodsService } from './payment-methods.service';
import { PrescriptionsService } from './prescriptions.service';
import { SalesController } from './sales.controller';
import { SalesReturnsService } from './sales-returns.service';
import { SalesService } from './sales.service';

@Module({
  imports: [FinanceModule, InventoryModule],
  controllers: [SalesController],
  providers: [CustomersService, PaymentMethodsService, PrescriptionsService, DiscountsService, SalesService, SalesReturnsService],
  exports: [SalesService, CustomersService],
})
export class SalesModule {}
