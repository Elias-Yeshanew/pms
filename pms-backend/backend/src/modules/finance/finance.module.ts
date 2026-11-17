import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { ExpensesService } from './expenses.service';
import { FinanceController } from './finance.controller';
import { JournalService } from './journal.service';
import { ReportsService } from './reports.service';
import { SessionsService } from './sessions.service';
import { TaxController } from './tax.controller';
import { TaxService } from './tax.service';

@Module({
  controllers: [TaxController, FinanceController],
  providers: [TaxService, JournalService, AccountsService, ExpensesService, SessionsService, ReportsService],
  exports: [TaxService, JournalService, SessionsService],
})
export class FinanceModule {}
