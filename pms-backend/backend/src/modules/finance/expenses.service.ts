import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { Page, PageQuery, offsetOf } from '../../common/pagination';
import { DatabaseService, Queryable, many, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { JournalService } from './journal.service';

interface ExpenseRow { id: string; reference_no: string; branch_id: string; category_id: string; expense_date: string; amount: string; method_code: string; description: string; status: string; created_by: string }

/** Day-to-day expenses and other income. Each posts one balanced journal entry; undoing one is a reversing entry, never a delete. */
@Injectable()
export class ExpensesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly journal: JournalService, private readonly audit: AuditService, private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService, private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('finance.expense', {
      onApproved: async (q, r) => {
        const e = await maybeOne<ExpenseRow>(q, `select * from finance.expenses where id = $1 and status = 'pending_approval' for update`, [r.source_id]);
        if (!e) return;
        const entryId = await this.postExpense(q, e);
        await q.query(`update finance.expenses set status = 'posted', entry_id = $2, decided_by = $3, version = version + 1 where id = $1`, [e.id, entryId, r.decided_by]);
      },
      onRejected: async (q, r) => { await q.query(`update finance.expenses set status = 'rejected', decided_by = $2, version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update finance.expenses set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  // ---- categories ----
  listCategories(kind: 'expense' | 'income') {
    return many(this.db, `select c.id, c.code, c.name, c.is_active, c.version, a.id as account_id, a.code as account_code, a.name as account_name from finance.${kind}_categories c join finance.accounts a on a.id = c.account_id order by c.name`);
  }

  async saveCategory(auth: AuthContext, kind: 'expense' | 'income', dto: { id?: string; version?: number; code?: string; name?: string; accountId?: string; isActive?: boolean }) {
    return this.db.tx(async (q) => {
      if (dto.accountId) {
        const a = await maybeOne<{ type: string; is_active: boolean }>(q, `select type, is_active from finance.accounts where id = $1`, [dto.accountId]);
        if (!a || !a.is_active) throw AppError.badRequest('ACCOUNT_NOT_FOUND', 'Choose an active account.');
        if (a.type !== (kind === 'expense' ? 'expense' : 'revenue')) throw AppError.badRequest('WRONG_ACCOUNT_TYPE', kind === 'expense' ? 'Expenses must use an expense account.' : 'Income must use a revenue account.');
      }
      if (!dto.id) {
        if (!dto.code || !dto.name || !dto.accountId) throw AppError.badRequest('MISSING_FIELDS', 'Code, name and account are required.');
        if (await maybeOne(q, `select 1 from finance.${kind}_categories where code = $1`, [dto.code])) throw AppError.conflict('CATEGORY_EXISTS', 'A category with this code already exists.');
        const c = await one(q, `insert into finance.${kind}_categories (code, name, account_id, updated_by) values ($1, $2, $3, $4) returning *`, [dto.code, dto.name, dto.accountId, auth.userId]);
        await this.audit.record({ action: `${kind}_category.created`, entityType: `${kind}_category`, entityId: (c as any).id, newValue: dto }, q);
        return c;
      }
      const c = await updateVersioned(q, `finance.${kind}_categories`, dto.id, dto.version ?? 0, { name: dto.name, account_id: dto.accountId, is_active: dto.isActive }, auth.userId, () => AppError.notFound('CATEGORY_NOT_FOUND', 'Category not found.'));
      await this.audit.record({ action: `${kind}_category.updated`, entityType: `${kind}_category`, entityId: dto.id, newValue: dto }, q);
      return c;
    });
  }

  private async methodAccount(q: Queryable, code: string): Promise<string> {
    const m = await maybeOne<{ is_active: boolean; is_credit: boolean }>(q, `select is_active, is_credit from sales.payment_methods where code = $1`, [code]);
    if (!m || !m.is_active || m.is_credit) throw AppError.badRequest('PAYMENT_METHOD_NOT_FOUND', 'The payment method does not exist or cannot be used here.');
    return this.journal.paymentAccountKey(q, code);
  }

  private async checkRegister(q: Queryable, registerId: string | undefined, branchId: string) {
    if (registerId && !(await maybeOne(q, `select 1 from org.cash_registers where id = $1 and branch_id = $2`, [registerId, branchId]))) throw AppError.badRequest('REGISTER_NOT_FOUND', 'The register does not belong to this branch.');
  }

  // ---- expenses ----
  private async postExpense(q: PoolClient, e: ExpenseRow): Promise<string | null> {
    const cat = await one<{ account_id: string; name: string }>(q, `select account_id, name from finance.expense_categories where id = $1`, [e.category_id]);
    return this.journal.post(q, {
      eventCode: 'expense', description: `Expense ${e.reference_no}: ${cat.name} - ${e.description}`, branchId: e.branch_id, sourceType: 'expense', sourceId: e.id, entryDate: e.expense_date, createdBy: e.created_by,
      lines: [{ account: cat.account_id, debit: e.amount }, { account: await this.journal.paymentAccountKey(q, e.method_code), credit: e.amount }],
    });
  }

  async createExpense(auth: AuthContext, dto: { branchId: string; categoryId: string; amount: string; methodCode: string; expenseDate?: string; payee?: string; description: string; externalRef?: string; registerId?: string }) {
    if (!auth.scopeFor('finance.expense_create').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot record expenses for this branch.');
    const amount = format(parse(dto.amount));
    if (cmp(amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'The amount must be more than zero.');
    const id = await this.db.tx(async (q) => {
      const cat = await maybeOne<{ is_active: boolean }>(q, `select is_active from finance.expense_categories where id = $1`, [dto.categoryId]);
      if (!cat || !cat.is_active) throw AppError.badRequest('CATEGORY_NOT_FOUND', 'The expense category does not exist or is not in use.');
      await this.methodAccount(q, dto.methodCode);
      await this.checkRegister(q, dto.registerId, dto.branchId);
      const date = dto.expenseDate ?? (await this.journal.businessDate(q));
      await this.journal.assertPeriodOpen(q, date);
      const reference = await this.sequences.next(q, 'expense', dto.branchId);
      const e = await one<ExpenseRow>(q, `insert into finance.expenses (reference_no, branch_id, category_id, expense_date, amount, method_code, payee, description, external_ref, register_id, status, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_approval', $11) returning *`,
        [reference, dto.branchId, dto.categoryId, date, amount, dto.methodCode, dto.payee ?? null, dto.description, dto.externalRef ?? null, dto.registerId ?? null, auth.userId]);
      const threshold = await this.settings.get('finance.expense_approval_threshold', dto.branchId, q);
      if (cmp(threshold, '0') > 0 && cmp(amount, threshold) >= 0) {
        await this.approvals.request(q, auth, { actionCode: 'finance.expense', sourceType: 'expense', sourceId: e.id, branchId: dto.branchId, requiredPermission: 'finance.expense_approve', summary: { reference, amount, description: dto.description } });
      } else {
        const entryId = await this.postExpense(q, e);
        await q.query(`update finance.expenses set status = 'posted', entry_id = $2 where id = $1`, [e.id, entryId]);
      }
      await this.audit.record({ action: 'expense.recorded', entityType: 'expense', entityId: e.id, branchId: dto.branchId, newValue: { reference, amount, category: dto.categoryId, method: dto.methodCode } }, q);
      return e.id;
    });
    return this.getExpense(auth, id);
  }

  async getExpense(auth: AuthContext, id: string) {
    const e = await maybeOne<{ branch_id: string }>(this.db, `select e.*, c.name as category_name, c.code as category_code, u.username as created_by_name,
        (select a.id from platform.approval_requests a where a.source_type = 'expense' and a.source_id = e.id order by a.requested_at desc limit 1) as approval_id
        from finance.expenses e join finance.expense_categories c on c.id = e.category_id join iam.users u on u.id = e.created_by where e.id = $1`, [id]);
    if (!e || !auth.scopeFor('finance.read').includes(e.branch_id)) throw AppError.notFound('EXPENSE_NOT_FOUND', 'Expense not found.');
    return e;
  }

  async cancelExpense(auth: AuthContext, id: string) {
    const e = await this.getExpense(auth, id) as unknown as { status: string; created_by: string; approval_id: string | null };
    if (e.created_by !== auth.userId) throw AppError.forbidden('ONLY_REQUESTER_CAN_CANCEL', 'Only the person who recorded the expense can withdraw it.');
    if (e.status !== 'pending_approval' || !e.approval_id) throw AppError.conflict('EXPENSE_NOT_CANCELLABLE', 'Only an expense waiting for approval can be withdrawn.');
    await this.approvals.cancel(auth, e.approval_id);
    return this.getExpense(auth, id);
  }

  async reverseExpense(auth: AuthContext, id: string, reason: string) {
    await this.db.tx(async (q) => {
      const e = await maybeOne<ExpenseRow>(q, `select * from finance.expenses where id = $1 for update`, [id]);
      if (!e || !auth.scopeFor('finance.read').includes(e.branch_id)) throw AppError.notFound('EXPENSE_NOT_FOUND', 'Expense not found.');
      if (!auth.scopeFor('finance.expense_reverse').includes(e.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You cannot reverse expenses for this branch.');
      if (e.status !== 'posted') throw AppError.conflict('EXPENSE_NOT_REVERSIBLE', 'Only a posted expense can be reversed.');
      await this.journal.reverseSource(q, { sourceType: 'expense', sourceId: id, reason, createdBy: auth.userId });
      await q.query(`update finance.expenses set status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3, version = version + 1 where id = $1`, [id, auth.userId, reason]);
      await this.audit.record({ action: 'expense.reversed', entityType: 'expense', entityId: id, branchId: e.branch_id, newValue: { reason } }, q);
    });
    return this.getExpense(auth, id);
  }

  async listExpenses(auth: AuthContext, q: PageQuery & { branchId?: string; categoryId?: string; status?: string; from?: string; to?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('finance.read').sql('e.branch_id', params)];
    const add2 = (c: string, v: unknown) => { params.push(v); where.push(c.replace('?', `$${params.length}`)); };
    if (q.branchId) add2('e.branch_id = ?', q.branchId);
    if (q.categoryId) add2('e.category_id = ?', q.categoryId);
    if (q.status) add2('e.status = ?', q.status);
    if (q.from) add2('e.expense_date >= ?', q.from);
    if (q.to) add2('e.expense_date <= ?', q.to);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from finance.expenses e where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select e.id, e.reference_no, e.branch_id, e.expense_date, e.amount, e.method_code, e.payee, e.description, e.status, c.name as category_name from finance.expenses e
      join finance.expense_categories c on c.id = e.category_id where ${w} order by e.expense_date desc, e.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // ---- other income ----
  async createIncome(auth: AuthContext, dto: { branchId: string; categoryId: string; amount: string; methodCode: string; incomeDate?: string; payer?: string; description: string; externalRef?: string; registerId?: string }) {
    if (!auth.scopeFor('finance.income_manage').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot record income for this branch.');
    const amount = format(parse(dto.amount));
    if (cmp(amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'The amount must be more than zero.');
    const id = await this.db.tx(async (q) => {
      const cat = await maybeOne<{ is_active: boolean; account_id: string; name: string }>(q, `select is_active, account_id, name from finance.income_categories where id = $1`, [dto.categoryId]);
      if (!cat || !cat.is_active) throw AppError.badRequest('CATEGORY_NOT_FOUND', 'The income category does not exist or is not in use.');
      await this.methodAccount(q, dto.methodCode);
      await this.checkRegister(q, dto.registerId, dto.branchId);
      const date = dto.incomeDate ?? (await this.journal.businessDate(q));
      const reference = await this.sequences.next(q, 'income', dto.branchId);
      const i = await one<{ id: string }>(q, `insert into finance.incomes (reference_no, branch_id, category_id, income_date, amount, method_code, payer, description, external_ref, register_id, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [reference, dto.branchId, dto.categoryId, date, amount, dto.methodCode, dto.payer ?? null, dto.description, dto.externalRef ?? null, dto.registerId ?? null, auth.userId]);
      const entryId = await this.journal.post(q, {
        eventCode: 'income', description: `Income ${reference}: ${cat.name} - ${dto.description}`, branchId: dto.branchId, sourceType: 'income', sourceId: i.id, entryDate: date, createdBy: auth.userId,
        lines: [{ account: await this.journal.paymentAccountKey(q, dto.methodCode), debit: amount }, { account: cat.account_id, credit: amount }],
      });
      await q.query(`update finance.incomes set entry_id = $2 where id = $1`, [i.id, entryId]);
      await this.audit.record({ action: 'income.recorded', entityType: 'income', entityId: i.id, branchId: dto.branchId, newValue: { reference, amount, method: dto.methodCode } }, q);
      return i.id;
    });
    return this.getIncome(auth, id);
  }

  async getIncome(auth: AuthContext, id: string) {
    const i = await maybeOne<{ branch_id: string }>(this.db, `select i.*, c.name as category_name from finance.incomes i join finance.income_categories c on c.id = i.category_id where i.id = $1`, [id]);
    if (!i || !auth.scopeFor('finance.read').includes(i.branch_id)) throw AppError.notFound('INCOME_NOT_FOUND', 'Income record not found.');
    return i;
  }

  async reverseIncome(auth: AuthContext, id: string, reason: string) {
    await this.db.tx(async (q) => {
      const i = await maybeOne<{ id: string; branch_id: string; status: string }>(q, `select id, branch_id, status from finance.incomes where id = $1 for update`, [id]);
      if (!i || !auth.scopeFor('finance.read').includes(i.branch_id)) throw AppError.notFound('INCOME_NOT_FOUND', 'Income record not found.');
      if (!auth.scopeFor('finance.expense_reverse').includes(i.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You cannot reverse income for this branch.');
      if (i.status !== 'posted') throw AppError.conflict('INCOME_NOT_REVERSIBLE', 'This income has already been reversed.');
      await this.journal.reverseSource(q, { sourceType: 'income', sourceId: id, reason, createdBy: auth.userId });
      await q.query(`update finance.incomes set status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3, version = version + 1 where id = $1`, [id, auth.userId, reason]);
      await this.audit.record({ action: 'income.reversed', entityType: 'income', entityId: id, branchId: i.branch_id, newValue: { reason } }, q);
    });
    return this.getIncome(auth, id);
  }

  async listIncomes(auth: AuthContext, q: PageQuery & { branchId?: string; categoryId?: string; from?: string; to?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('finance.read').sql('i.branch_id', params)];
    const add2 = (c: string, v: unknown) => { params.push(v); where.push(c.replace('?', `$${params.length}`)); };
    if (q.branchId) add2('i.branch_id = ?', q.branchId);
    if (q.categoryId) add2('i.category_id = ?', q.categoryId);
    if (q.from) add2('i.income_date >= ?', q.from);
    if (q.to) add2('i.income_date <= ?', q.to);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from finance.incomes i where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select i.id, i.reference_no, i.branch_id, i.income_date, i.amount, i.method_code, i.payer, i.description, i.status, c.name as category_name from finance.incomes i
      join finance.income_categories c on c.id = i.category_id where ${w} order by i.income_date desc, i.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
