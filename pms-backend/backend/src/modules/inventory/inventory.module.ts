import { Module } from '@nestjs/common';
import { AdjustmentsService } from './adjustments.service';
import { CountsService } from './counts.service';
import { TransfersService } from './transfers.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { FinanceModule } from '../finance/finance.module';
import { LedgerService } from './ledger.service';

@Module({
  imports: [FinanceModule],
  controllers: [InventoryController],
  providers: [LedgerService, InventoryService, AdjustmentsService, TransfersService, CountsService],
  exports: [LedgerService, InventoryService],
})
export class InventoryModule {}
