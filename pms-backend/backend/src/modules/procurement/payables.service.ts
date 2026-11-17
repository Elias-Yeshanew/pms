import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, divide, format, mul, parse, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { JournalService } from '../finance/journal.service';

const invNotFound = () => AppError.notFound('INVOICE_NOT_FOUND', 'Supplier invoice not found.');
const payNotFound = () => AppError.notFound('PAYMENT_NOT_FOUND', 'Payment not found.');
const addDays = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const BALANCE = '(i.total - i.paid_total - i.credited_total)';

interface InvoiceRow { id: string; reference_no: string; supplier_id: string; branch_id: string; total: string; paid_total: string; credited_total: string; status: string; created_by: string; purchase_order_id: string }

/**
 * Money owed to suppliers. An invoice is matched against the goods that were actually accepted; if it asks for
 * more than the tolerance allows, someone else must approve it. Payments can be partial and can be reversed, but
 * are never deleted, so the history always explains the balance.
 */
@Injectable()
export class PayablesService implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly approvals: ApprovalsService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService, private readonly journal: JournalService) {}

  onModuleInit() {
    this.approvals.registerHandler('procurement.invoice', {
      onApproved: async (q, r) => { const u = await q.query(`update procurement.supplier_invoices set status = 'open', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); if (u.rowCount) await this.postInvoice(q, r.source_id); },
      onRejected: async (q, r) => { await q.query(`update procurement.supplier_invoices set status = 'rejected', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
      onCancelled: async (q, r) => { await q.query(`update procurement.supplier_invoices set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  // ---------- invoices ----------
  async createInvoice(auth: AuthContext, dto: { purchaseOrderId: string; invoiceNo: string; invoiceDate: string; dueDate?: string; subtotal: string; taxTotal: string; total: string; note?: string }) {
    const head = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from procurement.purchase_orders where id = $1`, [dto.purchaseOrderId]);
    if (!head || !auth.scopeFor('procurement.read').includes(head.branch_id)) throw AppError.notFound('ORDER_NOT_FOUND', 'Purchase order not found.');
    if (!auth.scopeFor('procurement.invoice').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to record invoices for this branch.');
    if (cmp(add(dto.subtotal, dto.taxTotal), dto.total) !== 0) throw AppError.badRequest('TOTAL_MISMATCH', 'The total must equal the subtotal plus tax.');
    if (cmp(dto.total, '0') <= 0) throw AppError.badRequest('INVALID_TOTAL', 'The invoice total must be greater than zero.');
    const today = await this.settings.businessDate();
    if (dto.invoiceDate > today) throw AppError.badRequest('INVOICE_DATE_IN_FUTURE', 'The invoice date cannot be in the future.');

    const result = await this.db.tx(async (q) => {
      const po = await one<{ id: string; branch_id: string; supplier_id: string; status: string; payment_terms_days: number; reference_no: string }>(q, `select id, branch_id, supplier_id, status, payment_terms_days, reference_no from procurement.purchase_orders where id = $1 for update`, [dto.purchaseOrderId]);
      if (!['approved', 'partially_received', 'received', 'closed'].includes(po.status)) throw AppError.conflict('ORDER_NOT_INVOICEABLE', `An order that is ${po.status.replace(/_/g, ' ')} cannot be invoiced.`);
      if (await maybeOne(q, `select 1 from procurement.supplier_invoices where supplier_id = $1 and invoice_no = $2`, [po.supplier_id, dto.invoiceNo])) throw AppError.conflict('INVOICE_EXISTS', 'This supplier invoice number has already been recorded.');
      const dueDate = dto.dueDate ?? addDays(dto.invoiceDate, po.payment_terms_days);
      if (dueDate < dto.invoiceDate) throw AppError.badRequest('INVALID_DUE_DATE', 'The due date cannot be before the invoice date.');

      // Three-way match: what we ordered, what we accepted, what the supplier now asks for
      const dp = await this.settings.get('business.currency_decimals', null, q);
      const m = await one<{ accepted: string; invoiced: string }>(q,
        `select coalesce(round(sum(i.line_total * i.accepted_base / i.base_quantity), $2), 0)::numeric(18,4) as accepted,
                (select coalesce(sum(x.total), 0)::numeric(18,4) from procurement.supplier_invoices x where x.purchase_order_id = $1 and x.status not in ('rejected', 'cancelled')) as invoiced
           from procurement.purchase_order_items i where i.order_id = $1`, [po.id, dp]);
      const toInvoice = sub(m.accepted, m.invoiced);
      const variance = sub(format(parse(dto.total)), cmp(toInvoice, '0') > 0 ? toInvoice : '0');
      const tol = await this.settings.get('procurement.invoice_tolerance_percent', null, q);
      const allowed = cmp(toInvoice, '0') > 0 ? mul(toInvoice, divide(tol, '100')) : '0.0000';
      const needsApproval = cmp(variance, allowed) > 0;

      const reference = await this.sequences.next(q, 'supplier_invoice', po.branch_id);
      const inv = await one<{ id: string }>(q, `insert into procurement.supplier_invoices (reference_no, supplier_id, branch_id, purchase_order_id, invoice_no, invoice_date, due_date, subtotal, tax_total, total, status, variance, note, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [reference, po.supplier_id, po.branch_id, po.id, dto.invoiceNo.trim(), dto.invoiceDate, dueDate, dto.subtotal, dto.taxTotal, dto.total, needsApproval ? 'pending_approval' : 'open', variance, dto.note ?? null, auth.userId]);
      await this.audit.record({ action: 'supplier_invoice.recorded', entityType: 'supplier_invoice', entityId: inv.id, branchId: po.branch_id, newValue: { reference, ...dto, variance, needsApproval } }, q);
      if (!needsApproval) await this.postInvoice(q, inv.id);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'procurement.invoice', sourceType: 'supplier_invoice', sourceId: inv.id, branchId: po.branch_id, requiredPermission: 'procurement.invoice_approve', summary: { reference, invoiceNo: dto.invoiceNo, variance, acceptedValue: toInvoice } });
      return { id: inv.id, warnings: needsApproval ? [{ code: 'INVOICE_EXCEEDS_ACCEPTED_GOODS', message: 'The invoice is more than the value of the goods accepted, so it needs approval.', variance, toInvoice }] : [] };
    });
    return { ...(await this.getInvoice(auth, result.id)), warnings: result.warnings };
  }

  /** Books a supplier invoice: the goods received-not-invoiced account is cleared and what we owe the supplier goes up. */
  private async postInvoice(q: PoolClient, id: string) {
    const i = await one<{ reference_no: string; branch_id: string; subtotal: string; tax_total: string; total: string; created_by: string; invoice_no: string }>(q, `select reference_no, branch_id, subtotal, tax_total, total, created_by, invoice_no from procurement.supplier_invoices where id = $1`, [id]);
    await this.journal.post(q, {
      eventCode: 'invoice', description: `Supplier invoice ${i.reference_no} (${i.invoice_no})`, branchId: i.branch_id, sourceType: 'supplier_invoice', sourceId: id, createdBy: i.created_by,
      lines: [{ account: 'grni', debit: i.subtotal }, { account: 'tax_input', debit: i.tax_total }, { account: 'payable', credit: i.total }],
    });
  }

  async cancelInvoice(auth: AuthContext, id: string) {
    const inv = await this.getInvoice(auth, id) as unknown as InvoiceRow & { approval_id: string | null };
    if (!auth.scopeFor('procurement.invoice').includes(inv.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to cancel this invoice.');
    if (inv.status === 'pending_approval' && inv.approval_id && inv.created_by === auth.userId) { await this.approvals.cancel(auth, inv.approval_id); return this.getInvoice(auth, id); }
    await this.db.tx(async (q) => {
      const i = await one<InvoiceRow>(q, `select * from procurement.supplier_invoices where id = $1 for update`, [id]);
      if (i.status !== 'open' || cmp(i.paid_total, '0') > 0 || cmp(i.credited_total, '0') > 0) throw AppError.conflict('INVOICE_NOT_CANCELLABLE', 'Only an unpaid invoice that is not waiting for approval can be cancelled.');
      await q.query(`update procurement.supplier_invoices set status = 'cancelled', version = version + 1 where id = $1`, [id]);
      await this.journal.reverseSource(q, { sourceType: 'supplier_invoice', sourceId: id, eventCode: 'invoice', reason: 'Invoice cancelled', createdBy: auth.userId });
      await this.audit.record({ action: 'supplier_invoice.cancelled', entityType: 'supplier_invoice', entityId: id, branchId: i.branch_id }, q);
    });
    return this.getInvoice(auth, id);
  }

  async getInvoice(auth: AuthContext, id: string) {
    const i = await maybeOne<InvoiceRow>(this.db,
      `select i.*, ${BALANCE}::numeric(18,4) as balance, s.name as supplier_name, po.reference_no as order_reference,
              (select a.id from platform.approval_requests a where a.source_type = 'supplier_invoice' and a.source_id = i.id order by a.requested_at desc limit 1) as approval_id
         from procurement.supplier_invoices i join procurement.suppliers s on s.id = i.supplier_id join procurement.purchase_orders po on po.id = i.purchase_order_id where i.id = $1`, [id]);
    if (!i || !auth.scopeFor('procurement.read').includes(i.branch_id)) throw invNotFound();
    return i;
  }

  async listInvoices(auth: AuthContext, q: PageQuery & { supplierId?: string; status?: string; overdue?: boolean; purchaseOrderId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('procurement.read').sql('i.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.supplierId) add2('i.supplier_id = ?', q.supplierId);
    if (q.status) add2('i.status = ?', q.status);
    if (q.purchaseOrderId) add2('i.purchase_order_id = ?', q.purchaseOrderId);
    if (q.overdue) { where.push(`i.status in ('open', 'partially_paid')`); add2('i.due_date < ?', await this.settings.businessDate()); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.supplier_invoices i where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select i.id, i.reference_no, i.supplier_id, s.name as supplier_name, i.invoice_no, i.invoice_date, i.due_date, i.total, i.paid_total, i.credited_total, ${BALANCE}::numeric(18,4) as balance, i.status
        from procurement.supplier_invoices i join procurement.suppliers s on s.id = i.supplier_id where ${w} order by i.due_date, i.invoice_no limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // ---------- payments ----------
  private async lockInvoices(q: PoolClient, ids: string[]): Promise<InvoiceRow[]> {
    return many<InvoiceRow>(q, `select * from procurement.supplier_invoices where id = any($1::uuid[]) order by id for update`, [ids]);
  }

  private async refreshInvoiceStatus(q: PoolClient, ids: string[]) {
    await q.query(`update procurement.supplier_invoices set status = case when paid_total + credited_total >= total then 'paid' when paid_total + credited_total > 0 then 'partially_paid' else 'open' end, version = version + 1
        where id = any($1::uuid[]) and status in ('open', 'partially_paid', 'paid')`, [ids]);
  }

  async recordPayment(auth: AuthContext, dto: { supplierId: string; paymentDate?: string; method: string; externalRef?: string; note?: string; allocations: Array<{ invoiceId: string; amount: string }> }) {
    const ids = dto.allocations.map((a) => a.invoiceId);
    if (new Set(ids).size !== ids.length) throw AppError.badRequest('DUPLICATE_INVOICE', 'An invoice appears more than once in the payment.');
    const today = await this.settings.businessDate();
    const paymentDate = dto.paymentDate ?? today;
    if (paymentDate > today) throw AppError.badRequest('PAYMENT_DATE_IN_FUTURE', 'The payment date cannot be in the future.');
    const id = await this.db.tx(async (q) => {
      const supplier = await maybeOne(q, `select 1 from procurement.suppliers where id = $1`, [dto.supplierId]);
      if (!supplier) throw AppError.badRequest('SUPPLIER_NOT_FOUND', 'The supplier does not exist.');
      const invoices = await this.lockInvoices(q, ids);
      if (invoices.length !== ids.length) throw AppError.badRequest('INVOICE_NOT_FOUND', 'An invoice does not exist.');
      let amount = '0.0000';
      for (const a of dto.allocations) {
        const inv = invoices.find((i) => i.id === a.invoiceId)!;
        if (!auth.scopeFor('procurement.read').includes(inv.branch_id)) throw invNotFound();
        if (!auth.scopeFor('procurement.pay').includes(inv.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to pay invoices for this branch.');
        if (inv.supplier_id !== dto.supplierId) throw AppError.badRequest('INVOICE_SUPPLIER_MISMATCH', 'An invoice belongs to a different supplier.');
        if (!['open', 'partially_paid'].includes(inv.status)) throw AppError.conflict('INVOICE_NOT_PAYABLE', `Invoice ${inv.reference_no} is ${inv.status.replace(/_/g, ' ')} and cannot be paid.`);
        if (cmp(a.amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'Payment amounts must be greater than zero.');
        const balance = sub(sub(format(parse(inv.total)), format(parse(inv.paid_total))), format(parse(inv.credited_total)));
        if (cmp(a.amount, balance) > 0) throw AppError.conflict('OVERPAYMENT', `Invoice ${inv.reference_no} only has ${balance} outstanding.`, { invoiceId: inv.id, balance, attempted: format(parse(a.amount)) });
        amount = add(amount, a.amount);
      }
      const reference = await this.sequences.next(q, 'supplier_payment');
      const p = await one<{ id: string }>(q, `insert into procurement.supplier_payments (reference_no, supplier_id, payment_date, amount, method, external_ref, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [reference, dto.supplierId, paymentDate, amount, dto.method, dto.externalRef ?? null, dto.note ?? null, auth.userId]);
      for (const a of dto.allocations) {
        await q.query(`insert into procurement.supplier_payment_allocations (payment_id, invoice_id, amount) values ($1, $2, $3)`, [p.id, a.invoiceId, a.amount]);
        await q.query(`update procurement.supplier_invoices set paid_total = paid_total + $2 where id = $1`, [a.invoiceId, a.amount]);
      }
      await this.refreshInvoiceStatus(q, ids);
      const perBranch = new Map<string, string>();
      for (const a of dto.allocations) { const b = invoices.find((i) => i.id === a.invoiceId)!.branch_id; perBranch.set(b, add(perBranch.get(b) ?? '0.0000', a.amount)); }
      const payKey = await this.journal.paymentAccountKey(q, dto.method);
      await this.journal.post(q, { eventCode: 'supplier_payment', description: `Supplier payment ${reference}`, branchId: perBranch.size === 1 ? [...perBranch.keys()][0] : null, sourceType: 'supplier_payment', sourceId: p.id, createdBy: auth.userId,
        lines: [...perBranch.entries()].flatMap(([b, amt]) => [{ account: 'payable', debit: amt, branchId: b }, { account: payKey, credit: amt, branchId: b }]) });
      await this.audit.record({ action: 'supplier_payment.recorded', entityType: 'supplier_payment', entityId: p.id, newValue: { reference, amount, ...dto } }, q);
      return p.id;
    });
    return this.getPayment(auth, id);
  }

  async reversePayment(auth: AuthContext, id: string, reason: string) {
    await this.db.tx(async (q) => {
      const p = await maybeOne<{ id: string; status: string; reference_no: string; amount: string }>(q, `select * from procurement.supplier_payments where id = $1 for update`, [id]);
      if (!p) throw payNotFound();
      if (p.status !== 'posted') throw AppError.conflict('PAYMENT_ALREADY_REVERSED', 'This payment has already been reversed.');
      const allocs = await many<{ invoice_id: string; amount: string }>(q, `select invoice_id, amount from procurement.supplier_payment_allocations where payment_id = $1`, [id]);
      const invoices = await this.lockInvoices(q, allocs.map((a) => a.invoice_id));
      for (const i of invoices) if (!auth.scopeFor('procurement.payment_reverse').includes(i.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to reverse payments for this branch.');
      for (const a of allocs) await q.query(`update procurement.supplier_invoices set paid_total = paid_total - $2 where id = $1`, [a.invoice_id, a.amount]);
      await this.refreshInvoiceStatus(q, allocs.map((a) => a.invoice_id));
      await this.journal.reverseSource(q, { sourceType: 'supplier_payment', sourceId: id, reason, createdBy: auth.userId });
      await q.query(`update procurement.supplier_payments set status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3 where id = $1`, [id, auth.userId, reason]);
      await this.audit.record({ action: 'supplier_payment.reversed', entityType: 'supplier_payment', entityId: id, oldValue: { amount: p.amount }, newValue: { reason } }, q);
    });
    return this.getPayment(auth, id);
  }

  async getPayment(auth: AuthContext, id: string) {
    const p = await maybeOne<{ id: string }>(this.db, `select p.*, s.name as supplier_name, cu.username as created_by_name, ru.username as reversed_by_name from procurement.supplier_payments p
        join procurement.suppliers s on s.id = p.supplier_id join iam.users cu on cu.id = p.created_by left join iam.users ru on ru.id = p.reversed_by where p.id = $1`, [id]);
    if (!p) throw payNotFound();
    const allocations = await many<{ branch_id: string }>(this.db, `select a.invoice_id, i.reference_no as invoice_reference, i.invoice_no, i.branch_id, a.amount from procurement.supplier_payment_allocations a join procurement.supplier_invoices i on i.id = a.invoice_id where a.payment_id = $1`, [id]);
    if (!allocations.some((a) => auth.scopeFor('procurement.read').includes(a.branch_id))) throw payNotFound();
    return { ...p, allocations };
  }

  async listPayments(auth: AuthContext, q: PageQuery & { supplierId?: string; status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [`exists (select 1 from procurement.supplier_payment_allocations a join procurement.supplier_invoices i on i.id = a.invoice_id where a.payment_id = p.id and ${auth.scopeFor('procurement.read').sql('i.branch_id', params)})`];
    if (q.supplierId) { params.push(q.supplierId); where.push(`p.supplier_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.supplier_payments p where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select p.id, p.reference_no, p.supplier_id, s.name as supplier_name, p.payment_date, p.amount, p.method, p.status from procurement.supplier_payments p join procurement.suppliers s on s.id = p.supplier_id
        where ${w} order by p.payment_date desc, p.reference_no desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // ---------- credits ----------
  listCredits(auth: AuthContext, supplierId?: string) {
    const params: unknown[] = [supplierId ?? null];
    const scope = auth.scopeFor('procurement.read').sql('r.branch_id', params);
    return many(this.db, `select c.id, c.supplier_id, s.name as supplier_name, c.return_id, r.reference_no as return_reference, c.amount, c.applied_amount, (c.amount - c.applied_amount)::numeric(18,4) as remaining, c.created_at
        from procurement.supplier_credits c join procurement.suppliers s on s.id = c.supplier_id join procurement.purchase_returns r on r.id = c.return_id
       where ($1::uuid is null or c.supplier_id = $1) and ${scope} order by c.created_at desc`, params);
  }

  async applyCredit(auth: AuthContext, creditId: string, dto: { invoiceId: string; amount: string }) {
    await this.db.tx(async (q) => {
      const c = await maybeOne<{ id: string; supplier_id: string; amount: string; applied_amount: string }>(q, `select * from procurement.supplier_credits where id = $1 for update`, [creditId]);
      if (!c) throw AppError.notFound('CREDIT_NOT_FOUND', 'Credit not found.');
      const [inv] = await this.lockInvoices(q, [dto.invoiceId]);
      if (!inv || !auth.scopeFor('procurement.read').includes(inv.branch_id)) throw invNotFound();
      if (!auth.scopeFor('procurement.pay').includes(inv.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to apply credits for this branch.');
      if (inv.supplier_id !== c.supplier_id) throw AppError.badRequest('INVOICE_SUPPLIER_MISMATCH', 'The credit and the invoice belong to different suppliers.');
      if (!['open', 'partially_paid'].includes(inv.status)) throw AppError.conflict('INVOICE_NOT_PAYABLE', 'This invoice cannot take a credit.');
      if (cmp(dto.amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'The amount must be greater than zero.');
      const remaining = sub(format(parse(c.amount)), format(parse(c.applied_amount)));
      const balance = sub(sub(format(parse(inv.total)), format(parse(inv.paid_total))), format(parse(inv.credited_total)));
      if (cmp(dto.amount, remaining) > 0) throw AppError.conflict('CREDIT_EXCEEDED', 'The credit does not have that much left.', { remaining });
      if (cmp(dto.amount, balance) > 0) throw AppError.conflict('OVERPAYMENT', 'The invoice does not owe that much.', { balance });
      await q.query(`update procurement.supplier_credits set applied_amount = applied_amount + $2 where id = $1`, [creditId, dto.amount]);
      await q.query(`update procurement.supplier_invoices set credited_total = credited_total + $2 where id = $1`, [inv.id, dto.amount]);
      await q.query(`insert into procurement.supplier_credit_applications (credit_id, invoice_id, amount, applied_by) values ($1, $2, $3, $4)`, [creditId, inv.id, dto.amount, auth.userId]);
      await this.refreshInvoiceStatus(q, [inv.id]);
      await this.journal.post(q, { eventCode: 'supplier_credit', description: `Supplier credit applied to ${inv.reference_no}`, branchId: inv.branch_id, sourceType: 'supplier_credit', sourceId: creditId, createdBy: auth.userId,
        lines: [{ account: 'payable', debit: format(parse(dto.amount)) }, { account: 'supplier_credits', credit: format(parse(dto.amount)) }] });
      await this.audit.record({ action: 'supplier_credit.applied', entityType: 'supplier_credit', entityId: creditId, branchId: inv.branch_id, newValue: dto }, q);
    });
    return this.getInvoice(auth, dto.invoiceId);
  }

  // ---------- balances, statements, aging ----------
  private async assertSupplier(id: string) {
    if (!(await maybeOne(this.db, `select 1 from procurement.suppliers where id = $1`, [id]))) throw AppError.notFound('SUPPLIER_NOT_FOUND', 'Supplier not found.');
  }

  async balance(auth: AuthContext, supplierId: string) {
    await this.assertSupplier(supplierId);
    const params: unknown[] = [supplierId];
    const scope = auth.scopeFor('procurement.read').sql('i.branch_id', params);
    const b = await one<{ payable: string; pending: string }>(this.db,
      `select coalesce(sum(${BALANCE}) filter (where i.status in ('open', 'partially_paid')), 0)::numeric(18,4) as payable,
              coalesce(sum(${BALANCE}) filter (where i.status = 'pending_approval'), 0)::numeric(18,4) as pending
         from procurement.supplier_invoices i where i.supplier_id = $1 and ${scope}`, params);
    const credits = await one<{ v: string }>(this.db, `select coalesce(sum(amount - applied_amount), 0)::numeric(18,4) as v from procurement.supplier_credits where supplier_id = $1`, [supplierId]);
    const s = await one<{ credit_limit: string; payment_terms_days: number }>(this.db, `select credit_limit, payment_terms_days from procurement.suppliers where id = $1`, [supplierId]);
    return { supplierId, payable: b.payable, pendingApproval: b.pending, unappliedCredits: credits.v, net: sub(b.payable, credits.v), creditLimit: format(parse(s.credit_limit)), paymentTermsDays: s.payment_terms_days };
  }

  /** Every invoice, payment, reversal and credit for the supplier in date order, with a running balance. */
  async statement(auth: AuthContext, supplierId: string, from?: string, to?: string) {
    await this.assertSupplier(supplierId);
    const params: unknown[] = [supplierId];
    const scope = auth.scopeFor('procurement.read').sql('i.branch_id', params);
    const rows = await many<{ date: string; kind: string; reference: string; description: string; debit: string; credit: string; at: Date }>(this.db,
      `select * from (
         select to_char(i.invoice_date, 'YYYY-MM-DD') as date, 'invoice' as kind, i.reference_no as reference, 'Invoice ' || i.invoice_no as description, i.total as debit, 0::numeric as credit, i.created_at as at
           from procurement.supplier_invoices i where i.supplier_id = $1 and i.status not in ('rejected', 'cancelled', 'pending_approval') and ${scope}
         union all
         select to_char(p.payment_date, 'YYYY-MM-DD'), 'payment', p.reference_no, 'Payment (' || p.method || ')', 0, a.amount, p.created_at
           from procurement.supplier_payments p join procurement.supplier_payment_allocations a on a.payment_id = p.id join procurement.supplier_invoices i on i.id = a.invoice_id where p.supplier_id = $1 and ${scope}
         union all
         select to_char(p.reversed_at, 'YYYY-MM-DD'), 'payment_reversal', p.reference_no, 'Reversal: ' || coalesce(p.reversal_reason, ''), a.amount, 0, p.reversed_at
           from procurement.supplier_payments p join procurement.supplier_payment_allocations a on a.payment_id = p.id join procurement.supplier_invoices i on i.id = a.invoice_id where p.supplier_id = $1 and p.status = 'reversed' and ${scope}
         union all
         select to_char(c.created_at, 'YYYY-MM-DD'), 'credit_note', coalesce(r.reference_no, 'CREDIT'), 'Credit for returned goods', 0, c.amount, c.created_at
           from procurement.supplier_credits c left join procurement.purchase_returns r on r.id = c.return_id where c.supplier_id = $1 and (r.id is null or ${auth.scopeFor('procurement.read').sql('r.branch_id', params)})
       ) x order by x.date, x.at`, params);
    let running = '0.0000', opening = '0.0000';
    const lines: Array<typeof rows[number] & { balance: string }> = [];
    for (const r of rows) {
      running = sub(add(running, format(parse(r.debit))), format(parse(r.credit)));
      if (from && r.date < from) { opening = running; continue; }
      if (to && r.date > to) continue;
      lines.push({ ...r, debit: format(parse(r.debit)), credit: format(parse(r.credit)), balance: running });
    }
    return { supplierId, from: from ?? null, to: to ?? null, openingBalance: opening, closingBalance: lines.length ? lines[lines.length - 1].balance : opening, lines: lines.map(({ at, ...rest }) => rest) };
  }

  /** What is owed, grouped by how late it is. */
  async aging(auth: AuthContext, filter: { branchId?: string; supplierId?: string }) {
    const today = await this.settings.businessDate();
    const params: unknown[] = [today];
    const where = [`i.status in ('open', 'partially_paid')`, auth.scopeFor('procurement.read').sql('i.branch_id', params)];
    if (filter.branchId) { params.push(filter.branchId); where.push(`i.branch_id = $${params.length}`); }
    if (filter.supplierId) { params.push(filter.supplierId); where.push(`i.supplier_id = $${params.length}`); }
    const rows = await many<{ supplier_id: string; supplier_name: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; total: string }>(this.db,
      `select i.supplier_id, s.name as supplier_name,
              coalesce(sum(${BALANCE}) filter (where i.due_date >= $1::date), 0)::numeric(18,4) as current,
              coalesce(sum(${BALANCE}) filter (where $1::date - i.due_date between 1 and 30), 0)::numeric(18,4) as d1_30,
              coalesce(sum(${BALANCE}) filter (where $1::date - i.due_date between 31 and 60), 0)::numeric(18,4) as d31_60,
              coalesce(sum(${BALANCE}) filter (where $1::date - i.due_date between 61 and 90), 0)::numeric(18,4) as d61_90,
              coalesce(sum(${BALANCE}) filter (where $1::date - i.due_date > 90), 0)::numeric(18,4) as d90_plus,
              sum(${BALANCE})::numeric(18,4) as total
         from procurement.supplier_invoices i join procurement.suppliers s on s.id = i.supplier_id where ${where.join(' and ')} group by i.supplier_id, s.name order by s.name`, params);
    const totals = rows.reduce((t, r) => ({ current: add(t.current, r.current), d1_30: add(t.d1_30, r.d1_30), d31_60: add(t.d31_60, r.d31_60), d61_90: add(t.d61_90, r.d61_90), d90_plus: add(t.d90_plus, r.d90_plus), total: add(t.total, r.total) }),
      { current: '0.0000', d1_30: '0.0000', d31_60: '0.0000', d61_90: '0.0000', d90_plus: '0.0000', total: '0.0000' });
    return { asOf: today, suppliers: rows, totals };
  }
}
