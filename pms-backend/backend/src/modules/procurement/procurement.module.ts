import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AnalyticsService } from './analytics.service';
import { LinesService } from './lines.service';
import { OrdersService } from './orders.service';
import { PayablesService } from './payables.service';
import { ProcurementController } from './procurement.controller';
import { ReceivingService } from './receiving.service';
import { RequestsService } from './requests.service';
import { ReturnsService } from './returns.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

@Module({
  imports: [FinanceModule, InventoryModule],
  controllers: [SuppliersController, ProcurementController],
  providers: [SuppliersService, LinesService, RequestsService, OrdersService, ReceivingService, PayablesService, ReturnsService, AnalyticsService],
  exports: [SuppliersService, OrdersService],
})
export class ProcurementModule {}
