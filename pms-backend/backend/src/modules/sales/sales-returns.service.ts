import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, parse, roundDiv, roundTo, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService, PostEntry } from '../inventory/ledger.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { JournalService } from '../finance/journal.service';
import { SettingsService } from '../platform/settings.service';
import { CustomersService } from './customers.service';

const notFound = () => AppError.notFound('RETURN_NOT_FOUND', 'Sales return not found.');
export interface ReturnLineInput { saleItemId: string; quantity: string; unitId?: string }

/** Share of a line's total that belongs to `part` of `whole` base units, rounded to the currency. */
const share = (lineTotal: string, part: string, whole: string, dp: number) => format(roundTo(roundDiv(parse(lineTotal) * parse(part), parse(whole), 'half_up'), dp, 'half_up'));

/**
 * Taking goods back. The refund is worked out from what the customer actually paid for those units (discount and tax
 * included). Returned goods go to quarantine, never straight back on the shelf: an inspector decides whether they can be sold again.
 */
@Injectable()
export class SalesReturnsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly inventory: InventoryService, private readonly ledger: LedgerService, private readonly customers: CustomersService,
    private readonly approvals: ApprovalsService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
    private readonly journal: JournalService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('sales.return', {
      onApproved: (q, r, auth) => this.post(q, r.source_id, auth),
      onRejected: async (q, r) => { await q.query(`update sales.sales_returns set status = 'rejected', decided_by = $2, version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update sales.sales_returns set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  async create(auth: AuthContext, dto: { saleId: string; reason: string; refundMethodCode?: string; refundReference?: string; items: ReturnLineInput[] }) {
    const sale = await maybeOne<{ id: string; branch_id: string; status: string; sold_at: Date; paid_total: string; reference_no: string }>(this.db, `select id, branch_id, status, sold_at, paid_total, reference_no from sales.sales where id = $1`, [dto.saleId]);
    if (!sale || !auth.scopeFor('sales.read').includes(sale.branch_id)) throw AppError.notFound('SALE_NOT_FOUND', 'Sale not found.');
    if (!auth.scopeFor('sales.return').includes(sale.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to take returns at this branch.');
    const needsApproval = await this.settings.get('sales.return_approval_required');
    if (!needsApproval && !auth.can('sales.return_approve', sale.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Returns are posted immediately, so you need the return-approval permission.');

    const id = await this.db.tx(async (q) => {
      const s = await one<{ status: string; sold_at: Date }>(q, `select status, sold_at from sales.sales where id = $1 for update`, [dto.saleId]);
      if (!['completed', 'partially_returned'].includes(s.status)) throw AppError.conflict('SALE_NOT_RETURNABLE', s.status === 'cancelled' ? 'A cancelled sale cannot be returned.' : 'Everything on this sale has already been returned.');
      const days = await this.settings.get('sales.return_window_days', sale.branch_id, q);
      if (days > 0 && Date.now() - new Date(s.sold_at).getTime() > days * 86400000) throw AppError.conflict('RETURN_WINDOW_PASSED', `Items can only be returned within ${days} days of the sale.`);
      let methodId: string | null = null;
      if (cmp(sale.paid_total, '0') > 0) {
        if (!dto.refundMethodCode) throw AppError.badRequest('REFUND_METHOD_REQUIRED', 'Choose how the customer is refunded.');
        const m = await maybeOne<{ id: string; is_credit: boolean; requires_reference: boolean; is_active: boolean }>(q, `select id, is_credit, requires_reference, is_active from sales.payment_methods where code = $1`, [dto.refundMethodCode]);
        if (!m || !m.is_active || m.is_credit) throw AppError.badRequest('PAYMENT_METHOD_NOT_FOUND', 'The refund method does not exist, is not in use, or cannot be used for refunds.');
        if (m.requires_reference && !dto.refundReference?.trim()) throw AppError.badRequest('REFERENCE_REQUIRED', 'This refund method needs a reference.');
        methodId = m.id;
      }
      const dp = await this.settings.get('business.currency_decimals', null, q);
      const seen = new Set<string>();
      const prepared: Array<{ itemId: string; productId: string; quantity: string; base: string; refund: string }> = [];
      for (const it of dto.items) {
        if (seen.has(it.saleItemId)) throw AppError.badRequest('DUPLICATE_LINE', 'The same sale line appears twice.');
        seen.add(it.saleItemId);
        const si = await maybeOne<{ id: string; product_id: string; unit_id: string; base_quantity: string; returned_base: string; line_total: string }>(q, `select id, product_id, unit_id, base_quantity, returned_base, line_total from sales.sale_items where id = $1 and sale_id = $2 for update`, [it.saleItemId, dto.saleId]);
        if (!si) throw AppError.badRequest('ITEM_NOT_IN_SALE', 'A line does not belong to this sale.');
        const base = await this.inventory.toBase(q, si.product_id, it.unitId ?? si.unit_id, it.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        const pending = await one<{ n: string }>(q, `select coalesce(sum(ri.base_quantity), 0)::numeric(18,4) as n from sales.sales_return_items ri join sales.sales_returns r on r.id = ri.return_id where ri.sale_item_id = $1 and r.status = 'pending_approval'`, [si.id]);
        const remaining = sub(sub(format(parse(si.base_quantity)), format(parse(si.returned_base))), pending.n);
        if (cmp(base, remaining) > 0) throw AppError.conflict('RETURN_EXCEEDS_SALE', 'More is being returned than was sold (counting returns already made or waiting).', { remaining, attempted: base });
        const before = add(format(parse(si.returned_base)), pending.n);
        prepared.push({ itemId: si.id, productId: si.product_id, quantity: format(parse(it.quantity)), base, refund: sub(share(si.line_total, add(before, base), si.base_quantity, dp), share(si.line_total, before, si.base_quantity, dp)) });
      }
      const reference = await this.sequences.next(q, 'sales_return', sale.branch_id);
      const r = await one<{ id: string }>(q, `insert into sales.sales_returns (reference_no, sale_id, branch_id, reason, refund_method_id, refund_reference, refund_total, requested_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [reference, dto.saleId, sale.branch_id, dto.reason.trim(), methodId, dto.refundReference ?? null, prepared.reduce((t, p) => add(t, p.refund), '0.0000'), auth.userId]);
      for (const p of prepared) await q.query(`insert into sales.sales_return_items (return_id, sale_item_id, product_id, quantity, base_quantity, refund_amount) values ($1, $2, $3, $4, $5, $6)`, [r.id, p.itemId, p.productId, p.quantity, p.base, p.refund]);
      await this.audit.record({ action: 'sale.return_requested', entityType: 'sales_return', entityId: r.id, branchId: sale.branch_id, newValue: { reference, saleReference: sale.reference_no, lines: prepared.length } }, q);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'sales.return', sourceType: 'sales_return', sourceId: r.id, branchId: sale.branch_id, requiredPermission: 'sales.return_approve', summary: { reference, sale: sale.reference_no, reason: dto.reason } });
      else await this.post(q, r.id, auth);
      return r.id;
    });
    return this.get(auth, id);
  }

  /** Puts the goods into quarantine, records the refund, and updates the sale and the customer's account. */
  private async post(q: PoolClient, id: string, auth: AuthContext) {
    const ret = await one<{ id: string; reference_no: string; sale_id: string; branch_id: string; status: string; refund_method_id: string | null; refund_reference: string | null; requested_by: string }>(q, `select * from sales.sales_returns where id = $1 for update`, [id]);
    if (ret.status !== 'pending_approval') throw AppError.conflict('RETURN_NOT_PENDING', 'This return is no longer pending.');
    const sale = await one<{ status: string; customer_id: string | null; credit_total: string; credit_returned: string; reference_no: string }>(q, `select status, customer_id, credit_total, credit_returned, reference_no from sales.sales where id = $1 for update`, [ret.sale_id]);
    if (!['completed', 'partially_returned'].includes(sale.status)) throw AppError.conflict('SALE_NOT_RETURNABLE', 'The sale can no longer take returns.');
    const dp = await this.settings.get('business.currency_decimals', null, q);
    const items = await many<{ id: string; sale_item_id: string; product_id: string; base_quantity: string }>(q, `select id, sale_item_id, product_id, base_quantity from sales.sales_return_items where return_id = $1 order by id`, [id]);
    const entries: PostEntry[] = [];
    let total = '0.0000';
    let taxRefunded = '0.0000';
    for (const it of items) {
      const si = await one<{ base_quantity: string; returned_base: string; line_total: string; tax_amount: string }>(q, `select base_quantity, returned_base, line_total, tax_amount from sales.sale_items where id = $1 for update`, [it.sale_item_id]);
      const base = format(parse(it.base_quantity));
      if (cmp(add(format(parse(si.returned_base)), base), si.base_quantity) > 0) throw AppError.conflict('RETURN_EXCEEDS_SALE', 'More is being returned than was sold.');
      let left = base;
      const allocs = await many<{ id: string; batch_id: string; warehouse_id: string; location_id: string | null; base_quantity: string; returned_base: string }>(q, `select id, batch_id, warehouse_id, location_id, base_quantity, returned_base from sales.sale_item_allocations where sale_item_id = $1 and returned_base < base_quantity order by id for update`, [it.sale_item_id]);
      for (const a of allocs) {
        if (cmp(left, '0') === 0) break;
        const room = sub(format(parse(a.base_quantity)), format(parse(a.returned_base)));
        const take = cmp(room, left) < 0 ? room : left;
        await q.query(`update sales.sale_item_allocations set returned_base = returned_base + $2 where id = $1`, [a.id, take]);
        await q.query(`insert into sales.sales_return_allocations (return_item_id, allocation_id, batch_id, warehouse_id, location_id, base_quantity) values ($1, $2, $3, $4, $5, $6)`, [it.id, a.id, a.batch_id, a.warehouse_id, a.location_id, take]);
        entries.push({ productId: it.product_id, batchId: a.batch_id, warehouseId: a.warehouse_id, locationId: a.location_id, status: 'quarantined', quantityDelta: take, movementType: 'sale_return', referenceNo: ret.reference_no, sourceType: 'sales_return', sourceId: id, reason: `Returned from sale ${sale.reference_no}, awaiting inspection`, createdBy: ret.requested_by });
        left = sub(left, take);
      }
      const refund = sub(share(si.line_total, add(format(parse(si.returned_base)), base), si.base_quantity, dp), share(si.line_total, format(parse(si.returned_base)), si.base_quantity, dp));
      await q.query(`update sales.sale_items set returned_base = returned_base + $2 where id = $1`, [it.sale_item_id, base]);
      await q.query(`update sales.sales_return_items set refund_amount = $2 where id = $1`, [it.id, refund]);
      total = add(total, refund);
      taxRefunded = add(taxRefunded, sub(share(si.tax_amount, add(format(parse(si.returned_base)), base), si.base_quantity, dp), share(si.tax_amount, format(parse(si.returned_base)), si.base_quantity, dp)));
    }
    await this.ledger.post(q, entries);
    // Refund: first reduce what the customer still owes on account, the rest goes back by the chosen method
    const owed = sale.customer_id ? sub(format(parse(sale.credit_total)), format(parse(sale.credit_returned))) : '0.0000';
    const account = cmp(owed, total) < 0 ? owed : total;
    const payout = sub(total, account);
    if (cmp(account, '0') > 0) {
      await q.query(`insert into sales.sale_refunds (sale_id, return_id, kind, amount, to_account, created_by) values ($1, $2, 'return', $3, true, $4)`, [ret.sale_id, id, account, auth.userId]);
      await this.customers.postEntry(q, { customerId: sale.customer_id!, type: 'return_credit', amount: format(-parse(account)), branchId: ret.branch_id, sourceType: 'sales_return', sourceId: id, referenceNo: ret.reference_no, createdBy: auth.userId });
      await q.query(`update sales.sales set credit_returned = credit_returned + $2 where id = $1`, [ret.sale_id, account]);
    }
    if (cmp(payout, '0') > 0) {
      if (!ret.refund_method_id) throw AppError.badRequest('REFUND_METHOD_REQUIRED', 'Choose how the customer is refunded.');
      await q.query(`insert into sales.sale_refunds (sale_id, return_id, kind, method_id, amount, reference, created_by) values ($1, $2, 'return', $3, $4, $5, $6)`, [ret.sale_id, id, ret.refund_method_id, payout, ret.refund_reference, auth.userId]);
    }
    const refundAccount = ret.refund_method_id && cmp(payout, '0') > 0 ? await this.journal.paymentAccountKey(q, (await one<{ code: string }>(q, `select code from sales.payment_methods where id = $1`, [ret.refund_method_id])).code) : null;
    await this.journal.post(q, {
      eventCode: 'sale.return', description: `Return ${ret.reference_no} of sale ${sale.reference_no}`, branchId: ret.branch_id, sourceType: 'sales_return', sourceId: id, createdBy: auth.userId,
      lines: [
        { account: 'sales_returns', debit: sub(total, taxRefunded) }, { account: 'tax_output', debit: taxRefunded },
        { account: 'receivable', credit: account }, ...(refundAccount ? [{ account: refundAccount, credit: payout }] : []),
      ],
    });
    const open = await one<{ n: string }>(q, `select count(*) as n from sales.sale_items where sale_id = $1 and returned_base < base_quantity`, [ret.sale_id]);
    await q.query(`update sales.sales set status = $2, version = version + 1 where id = $1`, [ret.sale_id, Number(open.n) === 0 ? 'returned' : 'partially_returned']);
    await q.query(`update sales.sales_returns set status = 'posted', refund_total = $2, decided_by = $3, posted_at = now(), version = version + 1 where id = $1`, [id, total, auth.userId]);
    await this.audit.record({ action: 'sale.return_posted', entityType: 'sales_return', entityId: id, branchId: ret.branch_id, newValue: { reference: ret.reference_no, refund: total, toAccount: account } }, q);
  }

  /** Decides, line by line, what happens to returned goods: back on sale (if still in date) or damaged. */
  async inspect(auth: AuthContext, id: string, dto: { items: Array<{ itemId: string; disposition: 'resale' | 'damaged'; note?: string }> }) {
    const head = await this.get(auth, id) as unknown as { branch_id: string; status: string; requested_by: string };
    if (!auth.scopeFor('sales.return_inspect').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to inspect returned goods at this branch.');
    if (head.requested_by === auth.userId) throw AppError.forbidden('INSPECTOR_MUST_DIFFER', 'Returned goods must be inspected by someone other than the person who took them back.');
    await this.db.tx(async (q) => {
      const r = await one<{ status: string; reference_no: string }>(q, `select status, reference_no from sales.sales_returns where id = $1 for update`, [id]);
      if (r.status !== 'posted') throw AppError.conflict('RETURN_NOT_POSTED', 'Only a return that has been accepted can be inspected.');
      const today = await this.settings.businessDate(new Date(), q);
      const entries: PostEntry[] = [];
      for (const d of dto.items) {
        const item = await maybeOne<{ id: string; product_id: string; disposition: string }>(q, `select id, product_id, disposition from sales.sales_return_items where id = $1 and return_id = $2 for update`, [d.itemId, id]);
        if (!item) throw AppError.badRequest('ITEM_NOT_IN_RETURN', 'A line does not belong to this return.');
        if (item.disposition !== 'pending') throw AppError.conflict('ALREADY_INSPECTED', 'This line has already been inspected.');
        const allocs = await many<{ batch_id: string; warehouse_id: string; location_id: string | null; base_quantity: string; expired: boolean }>(q,
          `select a.batch_id, a.warehouse_id, a.location_id, a.base_quantity, (sb.expiry_date < $2::date) as expired from sales.sales_return_allocations a join inventory.stock_batches sb on sb.id = a.batch_id where a.return_item_id = $1`, [item.id, today]);
        if (d.disposition === 'resale' && allocs.some((a) => a.expired)) throw AppError.conflict('BATCH_EXPIRED', 'Goods from an expired batch cannot go back on sale.');
        for (const a of allocs) {
          const common = { productId: item.product_id, batchId: a.batch_id, warehouseId: a.warehouse_id, locationId: a.location_id, referenceNo: r.reference_no, sourceType: 'sales_return', sourceId: id, createdBy: auth.userId };
          const to = d.disposition === 'resale' ? 'available' : 'damaged';
          entries.push({ ...common, status: 'quarantined', quantityDelta: format(-parse(a.base_quantity)), movementType: d.disposition === 'resale' ? 'release' : 'damage', reason: `Return inspection: ${d.disposition}` }, { ...common, status: to, quantityDelta: format(parse(a.base_quantity)), movementType: d.disposition === 'resale' ? 'release' : 'damage', reason: `Return inspection: ${d.disposition}` });
        }
        await q.query(`update sales.sales_return_items set disposition = $2, inspected_by = $3, inspected_at = now(), note = $4 where id = $1`, [item.id, d.disposition, auth.userId, d.note ?? null]);
      }
      await this.ledger.post(q, entries);
      await this.audit.record({ action: 'sale.return_inspected', entityType: 'sales_return', entityId: id, branchId: head.branch_id, newValue: dto.items }, q);
    });
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string) {
    const r = await this.get(auth, id) as unknown as { status: string; approval_id: string | null };
    if (r.status !== 'pending_approval' || !r.approval_id) throw AppError.conflict('RETURN_NOT_CANCELLABLE', 'Only a pending return can be cancelled.');
    await this.approvals.cancel(auth, r.approval_id);
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const r = await maybeOne<{ branch_id: string }>(this.db, `select r.*, s.reference_no as sale_reference, ru.username as requested_by_name, m.code as refund_method_code,
        (select a.id from platform.approval_requests a where a.source_type = 'sales_return' and a.source_id = r.id order by a.requested_at desc limit 1) as approval_id
        from sales.sales_returns r join sales.sales s on s.id = r.sale_id join iam.users ru on ru.id = r.requested_by left join sales.payment_methods m on m.id = r.refund_method_id where r.id = $1`, [id]);
    if (!r || !auth.scopeFor('sales.read').includes(r.branch_id)) throw notFound();
    const items = await many(this.db, `select i.id, i.sale_item_id, i.product_id, p.sku, p.name as product_name, i.quantity, i.base_quantity, i.refund_amount, i.disposition, i.inspected_at, i.note from sales.sales_return_items i join catalog.products p on p.id = i.product_id where i.return_id = $1 order by p.name`, [id]);
    const refunds = await many(this.db, `select f.amount, f.to_account, m.code as method_code from sales.sale_refunds f left join sales.payment_methods m on m.id = f.method_id where f.return_id = $1`, [id]);
    return { ...r, items, refunds };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; saleId?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('sales.read').sql('r.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.status) add2('r.status = ?', q.status);
    if (q.saleId) add2('r.sale_id = ?', q.saleId);
    if (q.branchId) add2('r.branch_id = ?', q.branchId);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from sales.sales_returns r where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select r.id, r.reference_no, r.sale_id, r.branch_id, r.status, r.reason, r.refund_total, r.requested_at, r.posted_at from sales.sales_returns r where ${w} order by r.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
