import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { likePattern, offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, parse } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../finance/journal.service';
import { SequenceService } from '../platform/sequence.service';

const notFound = () => AppError.notFound('CUSTOMER_NOT_FOUND', 'Customer not found.');
const COLS = `id, code, name, phone, email, address, notes, credit_limit, balance, status, version, created_at`;

export type LedgerType = 'credit_sale' | 'payment' | 'payment_reversal' | 'return_credit' | 'cancel_credit' | 'adjustment';

/**
 * Customers and what they owe. The balance only ever changes together with an append-only ledger row, under a row lock,
 * exactly like stock. A reconciliation check compares the two.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly db: DatabaseService, private readonly sequences: SequenceService, private readonly audit: AuditService, private readonly journal: JournalService) {}

  /** The one way a customer's balance changes. Positive amounts make the customer owe more. */
  async postEntry(q: PoolClient, e: { customerId: string; type: LedgerType; amount: string; branchId?: string | null; sourceType: string; sourceId?: string | null; referenceNo?: string | null; note?: string | null; createdBy: string; enforceLimit?: boolean }): Promise<string> {
    const c = await maybeOne<{ balance: string; credit_limit: string; status: string }>(q, `select balance, credit_limit, status from sales.customers where id = $1 for update`, [e.customerId]);
    if (!c) throw notFound();
    const amount = format(parse(e.amount));
    const next = add(format(parse(c.balance)), amount);
    if (e.enforceLimit && cmp(amount, '0') > 0) {
      if (c.status !== 'active') throw AppError.conflict('CUSTOMER_INACTIVE', 'This customer is inactive.');
      if (cmp(c.credit_limit, '0') <= 0) throw AppError.conflict('NO_CREDIT_ALLOWED', 'This customer has no credit limit, so sales on account are not allowed.');
      if (cmp(next, c.credit_limit) > 0) throw AppError.conflict('CREDIT_LIMIT_EXCEEDED', 'This sale would take the customer past their credit limit.', { creditLimit: format(parse(c.credit_limit)), balance: format(parse(c.balance)), attempted: amount });
    }
    await q.query(`update sales.customers set balance = $2 where id = $1`, [e.customerId, next]);
    await q.query(`insert into sales.customer_ledger (customer_id, entry_type, amount, balance_after, branch_id, source_type, source_id, reference_no, note, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
      [e.customerId, e.type, amount, next, e.branchId ?? null, e.sourceType, e.sourceId ?? null, e.referenceNo ?? null, e.note ?? null, e.createdBy]);
    return next;
  }

  async create(auth: AuthContext, dto: { name: string; phone?: string; email?: string; address?: string; notes?: string; creditLimit?: string }) {
    const id = await this.db.tx(async (q) => {
      const code = await this.sequences.next(q, 'customer');
      const c = await one<{ id: string }>(q, `insert into sales.customers (code, name, phone, email, address, notes, credit_limit, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, coalesce($7::numeric, 0), $8, $8) returning id`,
        [code, dto.name.trim(), dto.phone ?? null, dto.email ?? null, dto.address ?? null, dto.notes ?? null, dto.creditLimit ?? null, auth.userId]);
      if (dto.creditLimit && cmp(dto.creditLimit, '0') > 0 && !auth.can('customers.credit')) throw AppError.forbidden('PERMISSION_DENIED', 'You need the credit permission to set a credit limit.');
      await this.audit.record({ action: 'customer.created', entityType: 'customer', entityId: c.id, newValue: { code, ...dto } }, q);
      return c.id;
    });
    return this.getRaw(id);
  }

  private async getRaw(id: string) {
    const c = await maybeOne(this.db, `select ${COLS} from sales.customers where id = $1`, [id]);
    if (!c) throw notFound();
    return c;
  }

  /** Viewing a customer is recorded, because the record holds personal information. */
  async get(auth: AuthContext, id: string) {
    const c = await this.getRaw(id);
    await this.audit.record({ action: 'customer.viewed', entityType: 'customer', entityId: id });
    return c;
  }

  async update(auth: AuthContext, id: string, dto: { version: number; name?: string; phone?: string; email?: string; address?: string; notes?: string; creditLimit?: string; status?: 'active' | 'inactive' }) {
    if (dto.creditLimit !== undefined && !auth.can('customers.credit')) throw AppError.forbidden('PERMISSION_DENIED', 'You need the credit permission to change a credit limit.');
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'sales.customers', id, dto.version, { name: dto.name?.trim(), phone: dto.phone, email: dto.email, address: dto.address, notes: dto.notes, credit_limit: dto.creditLimit, status: dto.status }, auth.userId, notFound);
      await this.audit.record({ action: 'customer.updated', entityType: 'customer', entityId: id, newValue: dto }, q);
    });
    return this.getRaw(id);
  }

  async list(q: PageQuery & { status?: string; owing?: boolean }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.owing) where.push('balance > 0');
    if (q.search) { params.push(likePattern(q.search)); where.push(`(name ilike $${params.length} or phone ilike $${params.length} or code ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from sales.customers where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select ${COLS} from sales.customers where ${w} order by name limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // ---- payments on account ----
  async receivePayment(auth: AuthContext, customerId: string, dto: { branchId: string; registerId?: string; methodCode: string; amount: string; reference?: string }) {
    if (!auth.scopeFor('customers.payment').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot receive payments for this branch.');
    const id = await this.db.tx(async (q) => {
      const method = await maybeOne<{ id: string; is_credit: boolean; requires_reference: boolean; is_active: boolean }>(q, `select id, is_credit, requires_reference, is_active from sales.payment_methods where code = $1`, [dto.methodCode]);
      if (!method || !method.is_active) throw AppError.badRequest('PAYMENT_METHOD_NOT_FOUND', 'The payment method does not exist or is not in use.');
      if (method.is_credit) throw AppError.badRequest('INVALID_PAYMENT_METHOD', 'A payment cannot be made "on account".');
      if (method.requires_reference && !dto.reference?.trim()) throw AppError.badRequest('REFERENCE_REQUIRED', 'This payment method needs a reference.');
      if (cmp(dto.amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'The amount must be greater than zero.');
      if (!(await maybeOne(q, `select 1 from org.branches where id = $1`, [dto.branchId]))) throw AppError.badRequest('BRANCH_NOT_FOUND', 'The branch does not exist.');
      if (dto.registerId && !(await maybeOne(q, `select 1 from org.cash_registers where id = $1 and branch_id = $2`, [dto.registerId, dto.branchId]))) throw AppError.badRequest('REGISTER_NOT_FOUND', 'The register does not belong to this branch.');
      const reference = await this.sequences.next(q, 'customer_payment', dto.branchId);
      const p = await one<{ id: string }>(q, `insert into sales.customer_payments (reference_no, customer_id, branch_id, register_id, method_id, amount, reference, received_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [reference, customerId, dto.branchId, dto.registerId ?? null, method.id, format(parse(dto.amount)), dto.reference ?? null, auth.userId]);
      await this.postEntry(q, { customerId, type: 'payment', amount: format(-parse(dto.amount)), branchId: dto.branchId, sourceType: 'customer_payment', sourceId: p.id, referenceNo: reference, createdBy: auth.userId });
      await this.journal.post(q, { eventCode: 'customer.payment', description: `Customer payment ${reference}`, branchId: dto.branchId, sourceType: 'customer_payment', sourceId: p.id, createdBy: auth.userId,
        lines: [{ account: await this.journal.paymentAccountKey(q, dto.methodCode), debit: format(parse(dto.amount)) }, { account: 'receivable', credit: format(parse(dto.amount)) }] });
      await this.audit.record({ action: 'customer.payment_received', entityType: 'customer_payment', entityId: p.id, branchId: dto.branchId, newValue: { reference, customerId, amount: dto.amount, method: dto.methodCode } }, q);
      return p.id;
    });
    return this.getPayment(auth, id);
  }

  async getPayment(auth: AuthContext, id: string) {
    const p = await maybeOne<{ branch_id: string }>(this.db, `select p.*, m.code as method_code, m.name as method_name, c.name as customer_name, u.username as received_by_name from sales.customer_payments p
        join sales.payment_methods m on m.id = p.method_id join sales.customers c on c.id = p.customer_id join iam.users u on u.id = p.received_by where p.id = $1`, [id]);
    if (!p || !auth.scopeFor('customers.read').includes(p.branch_id)) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found.');
    return p;
  }

  async reversePayment(auth: AuthContext, id: string, reason: string) {
    await this.db.tx(async (q) => {
      const p = await maybeOne<{ id: string; customer_id: string; branch_id: string; amount: string; status: string; reference_no: string }>(q, `select * from sales.customer_payments where id = $1 for update`, [id]);
      if (!p || !auth.scopeFor('customers.read').includes(p.branch_id)) throw AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found.');
      if (!auth.scopeFor('customers.payment_reverse').includes(p.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to reverse payments for this branch.');
      if (p.status !== 'posted') throw AppError.conflict('PAYMENT_ALREADY_REVERSED', 'This payment has already been reversed.');
      await q.query(`update sales.customer_payments set status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3 where id = $1`, [id, auth.userId, reason]);
      await this.postEntry(q, { customerId: p.customer_id, type: 'payment_reversal', amount: format(parse(p.amount)), branchId: p.branch_id, sourceType: 'customer_payment', sourceId: id, referenceNo: p.reference_no, note: reason, createdBy: auth.userId });
      await this.journal.reverseSource(q, { sourceType: 'customer_payment', sourceId: id, reason, createdBy: auth.userId });
      await this.audit.record({ action: 'customer.payment_reversed', entityType: 'customer_payment', entityId: id, branchId: p.branch_id, newValue: { reason } }, q);
    });
    return this.getPayment(auth, id);
  }

  async listPayments(auth: AuthContext, customerId: string) {
    await this.getRaw(customerId);
    const params: unknown[] = [customerId];
    const scope = auth.scopeFor('customers.read').sql('p.branch_id', params);
    return many(this.db, `select p.id, p.reference_no, p.branch_id, p.amount, p.status, m.code as method_code, p.received_at from sales.customer_payments p join sales.payment_methods m on m.id = p.method_id
      where p.customer_id = $1 and ${scope} order by p.received_at desc`, params);
  }

  async statement(auth: AuthContext, customerId: string, from?: string, to?: string) {
    const c = await this.getRaw(customerId) as { name: string; balance: string };
    const rows = await many<{ date: string; entry_type: string; amount: string; balance_after: string; reference_no: string | null; note: string | null; created_at: Date }>(this.db,
      `select to_char(created_at, 'YYYY-MM-DD') as date, entry_type, amount, balance_after, reference_no, note, created_at from sales.customer_ledger where customer_id = $1 order by created_at, id`, [customerId]);
    let opening = '0.0000';
    const lines = [];
    for (const r of rows) {
      if (from && r.date < from) { opening = format(parse(r.balance_after)); continue; }
      if (to && r.date > to) continue;
      lines.push({ date: r.date, type: r.entry_type, reference: r.reference_no, note: r.note, charge: cmp(r.amount, '0') > 0 ? format(parse(r.amount)) : '0.0000', payment: cmp(r.amount, '0') < 0 ? format(-parse(r.amount)) : '0.0000', balance: format(parse(r.balance_after)) });
    }
    await this.audit.record({ action: 'customer.statement_viewed', entityType: 'customer', entityId: customerId });
    return { customerId, name: c.name, from: from ?? null, to: to ?? null, openingBalance: opening, closingBalance: lines.length ? lines[lines.length - 1].balance : opening, currentBalance: format(parse(c.balance)), lines };
  }

  /** Balances that do not equal the sum of their ledger entries. An empty list means they agree. */
  reconcile() {
    return many(this.db, `select c.id, c.code, c.balance, coalesce(sum(l.amount), 0)::numeric(18,4) as ledger_total from sales.customers c left join sales.customer_ledger l on l.customer_id = c.id group by c.id having c.balance <> coalesce(sum(l.amount), 0)`);
  }
}
