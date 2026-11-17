import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermission } from '../../common/decorators';
import type { AuthContext } from '../../common/auth-types';
import { AccountsService } from './accounts.service';
import { ExpensesService } from './expenses.service';
import {
  AsOfQuery, CloseSessionDto, CreateAccountDto, CreateExpenseDto, CreateIncomeDto, CreatePeriodDto, DailyClosingQuery, EntriesQuery, ExpensesQuery, GenerateYearDto, IncomesQuery,
  ManualJournalDto, OpenSessionDto, RangeQuery, FinanceReasonDto, ReopenPeriodDto, SaveCategoryDto, SessionsQuery, SetMappingDto, UpdateAccountDto,
} from './finance.dto';
import { ReportsService } from './reports.service';
import { SessionsService } from './sessions.service';

const id = () => Param('id', ParseUUIDPipe);

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('finance')
export class FinanceController {
  constructor(private readonly accounts: AccountsService, private readonly expenses: ExpensesService, private readonly sessions: SessionsService, private readonly reports: ReportsService) {}

  // ---- chart of accounts and posting accounts ----
  @Get('accounts') @RequirePermission('finance.read') listAccounts(@Query('includeInactive') inactive?: string) { return this.accounts.listAccounts(inactive === 'true'); }
  @Post('accounts') @RequirePermission('finance.accounts_manage') createAccount(@Auth() a: AuthContext, @Body() d: CreateAccountDto) { return this.accounts.createAccount(a, d); }
  @Patch('accounts/:id') @RequirePermission('finance.accounts_manage') updateAccount(@Auth() a: AuthContext, @id() i: string, @Body() d: UpdateAccountDto) { return this.accounts.updateAccount(a, i, d); }
  @Get('account-mappings') @RequirePermission('finance.read') listMappings() { return this.accounts.listMappings(); }
  @Put('account-mappings/:key') @RequirePermission('finance.accounts_manage') setMapping(@Auth() a: AuthContext, @Param('key') key: string, @Body() d: SetMappingDto) { return this.accounts.setMapping(a, key, d.accountId); }

  // ---- fiscal periods ----
  @Get('periods') @RequirePermission('finance.read') listPeriods() { return this.accounts.listPeriods(); }
  @Post('periods') @RequirePermission('finance.period_manage') createPeriod(@Auth() a: AuthContext, @Body() d: CreatePeriodDto) { return this.accounts.createPeriod(a, d); }
  @Post('periods/generate-year') @HttpCode(200) @RequirePermission('finance.period_manage') generateYear(@Auth() a: AuthContext, @Body() d: GenerateYearDto) { return this.accounts.generateYear(a, d.year); }
  @Post('periods/:id/close') @HttpCode(200) @RequirePermission('finance.period_manage') closePeriod(@Auth() a: AuthContext, @id() i: string) { return this.accounts.setPeriodStatus(a, i, 'closed'); }
  @Post('periods/:id/reopen') @HttpCode(200) @RequirePermission('finance.period_manage') reopenPeriod(@Auth() a: AuthContext, @id() i: string, @Body() d: ReopenPeriodDto) { return this.accounts.setPeriodStatus(a, i, 'open', d.note); }

  // ---- journal ----
  @Get('journal') @RequirePermission('finance.read') listEntries(@Auth() a: AuthContext, @Query() q: EntriesQuery) { return this.accounts.listEntries(a, q); }
  @Get('journal/:id') @RequirePermission('finance.read') getEntry(@Auth() a: AuthContext, @id() i: string) { return this.accounts.getEntry(a, i); }
  @Post('manual-journals') @RequirePermission('finance.journal_create') manualJournal(@Auth() a: AuthContext, @Body() d: ManualJournalDto) { return this.accounts.requestManualJournal(a, d); }

  // ---- expenses and other income ----
  @Get('expense-categories') @RequirePermission('finance.read') expenseCategories() { return this.expenses.listCategories('expense'); }
  @Post('expense-categories') @RequirePermission('finance.accounts_manage') saveExpenseCategory(@Auth() a: AuthContext, @Body() d: SaveCategoryDto) { return this.expenses.saveCategory(a, 'expense', d); }
  @Patch('expense-categories/:id') @RequirePermission('finance.accounts_manage') updateExpenseCategory(@Auth() a: AuthContext, @id() i: string, @Body() d: SaveCategoryDto) { return this.expenses.saveCategory(a, 'expense', { ...d, id: i }); }
  @Get('income-categories') @RequirePermission('finance.read') incomeCategories() { return this.expenses.listCategories('income'); }
  @Post('income-categories') @RequirePermission('finance.accounts_manage') saveIncomeCategory(@Auth() a: AuthContext, @Body() d: SaveCategoryDto) { return this.expenses.saveCategory(a, 'income', d); }
  @Patch('income-categories/:id') @RequirePermission('finance.accounts_manage') updateIncomeCategory(@Auth() a: AuthContext, @id() i: string, @Body() d: SaveCategoryDto) { return this.expenses.saveCategory(a, 'income', { ...d, id: i }); }

  @Get('expenses') @RequirePermission('finance.read') listExpenses(@Auth() a: AuthContext, @Query() q: ExpensesQuery) { return this.expenses.listExpenses(a, q); }
  @Post('expenses') @RequirePermission('finance.expense_create') createExpense(@Auth() a: AuthContext, @Body() d: CreateExpenseDto) { return this.expenses.createExpense(a, d); }
  @Get('expenses/:id') @RequirePermission('finance.read') getExpense(@Auth() a: AuthContext, @id() i: string) { return this.expenses.getExpense(a, i); }
  @Post('expenses/:id/cancel') @HttpCode(200) @RequirePermission('finance.expense_create') cancelExpense(@Auth() a: AuthContext, @id() i: string) { return this.expenses.cancelExpense(a, i); }
  @Post('expenses/:id/reverse') @HttpCode(200) @RequirePermission('finance.expense_reverse') reverseExpense(@Auth() a: AuthContext, @id() i: string, @Body() d: FinanceReasonDto) { return this.expenses.reverseExpense(a, i, d.reason); }

  @Get('incomes') @RequirePermission('finance.read') listIncomes(@Auth() a: AuthContext, @Query() q: IncomesQuery) { return this.expenses.listIncomes(a, q); }
  @Post('incomes') @RequirePermission('finance.income_manage') createIncome(@Auth() a: AuthContext, @Body() d: CreateIncomeDto) { return this.expenses.createIncome(a, d); }
  @Get('incomes/:id') @RequirePermission('finance.read') getIncome(@Auth() a: AuthContext, @id() i: string) { return this.expenses.getIncome(a, i); }
  @Post('incomes/:id/reverse') @HttpCode(200) @RequirePermission('finance.expense_reverse') reverseIncome(@Auth() a: AuthContext, @id() i: string, @Body() d: FinanceReasonDto) { return this.expenses.reverseIncome(a, i, d.reason); }

  // ---- register sessions ----
  @Get('register-sessions') @RequirePermission('finance.register_operate') listSessions(@Auth() a: AuthContext, @Query() q: SessionsQuery) { return this.sessions.list(a, q); }
  @Post('register-sessions') @RequirePermission('finance.register_operate') openSession(@Auth() a: AuthContext, @Body() d: OpenSessionDto) { return this.sessions.open(a, d); }
  @Get('register-sessions/current/:id') @RequirePermission('finance.register_operate') currentSession(@Auth() a: AuthContext, @id() i: string) { return this.sessions.current(a, i); }
  @Get('register-sessions/:id') @RequirePermission('finance.register_operate') getSession(@Auth() a: AuthContext, @id() i: string) { return this.sessions.get(a, i); }
  @Post('register-sessions/:id/close') @HttpCode(200) @RequirePermission('finance.register_operate') closeSession(@Auth() a: AuthContext, @id() i: string, @Body() d: CloseSessionDto) { return this.sessions.close(a, i, d); }

  // ---- reports ----
  @Get('reports/trial-balance') @RequirePermission('finance.read') trial(@Auth() a: AuthContext, @Query() q: RangeQuery) { return this.reports.trialBalance(a, q); }
  @Get('reports/income-statement') @RequirePermission('finance.read') income(@Auth() a: AuthContext, @Query() q: RangeQuery) { return this.reports.incomeStatement(a, q); }
  @Get('reports/branch-performance') @RequirePermission('finance.read') branches(@Auth() a: AuthContext, @Query() q: RangeQuery) { return this.reports.branchPerformance(a, q); }
  @Get('reports/balance-sheet') @RequirePermission('finance.read') balanceSheet(@Auth() a: AuthContext, @Query() q: AsOfQuery) { return this.reports.balanceSheet(a, q); }
  @Get('reports/cash-flow') @RequirePermission('finance.read') cashFlow(@Auth() a: AuthContext, @Query() q: RangeQuery) { return this.reports.cashFlow(a, q); }
  @Get('reports/tax-summary') @RequirePermission('finance.read') tax(@Auth() a: AuthContext, @Query() q: RangeQuery) { return this.reports.taxSummary(a, q); }
  @Get('reports/general-ledger/:id') @RequirePermission('finance.read') ledger(@Auth() a: AuthContext, @id() i: string, @Query() q: RangeQuery) { return this.reports.generalLedger(a, i, q); }
  @Get('reports/daily-closing') @RequirePermission('finance.read') daily(@Auth() a: AuthContext, @Query() q: DailyClosingQuery) { return this.reports.dailyClosing(a, q.branchId, q.date); }
  @Get('reconcile') @RequirePermission('finance.read') reconcile(@Auth() a: AuthContext) { return this.reports.reconcile(a); }
}
