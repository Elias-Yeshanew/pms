import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { add, cmp, format, parse } from '../../domain/decimal';
import { lineTotal } from '../../domain/pricing';
import { AuditService } from '../audit/audit.service';
import { TaxService } from '../finance/tax.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { LinesService, ResolvedLine } from './lines.service';

const notFound = () => AppError.notFound('ORDER_NOT_FOUND', 'Purchase order not found.');

export interface OrderLineInput { productId: string; unitId?: string; quantity: string; unitPrice: string }
interface PricedLine extends ResolvedLine { unitPrice: string; taxRate: string; lineNet: string; taxAmount: string; lineTotal: string }
interface OrderRow { id: string; reference_no: string; branch_id: string; warehouse_id: string; supplier_id: string; status: string; order_date: string; expected_date: string | null; created_by: string; total: string; revision: number; version: number }

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly lines: LinesService, private readonly tax: TaxService, private readonly inventory: InventoryService,
    private readonly approvals: ApprovalsService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('procurement.order', {
      onApproved: (q, r, auth) => this.markApproved(q, r.source_id, auth.userId),
      onRejected: async (q, r) => { await q.query(`update procurement.purchase_orders set status = 'rejected', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
      onCancelled: async (q, r) => { await q.query(`update procurement.purchase_orders set status = 'draft', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
    this.approvals.registerHandler('procurement.order_revision', {
      onApproved: (q, r, auth) => this.applyRevision(q, r, auth),
      onRejected: async (q, r) => { await q.query(`update procurement.purchase_order_revisions set status = 'rejected' where id = $1 and status = 'pending'`, [r.source_id]); },
      onCancelled: async (q, r) => { await q.query(`update procurement.purchase_order_revisions set status = 'cancelled' where id = $1 and status = 'pending'`, [r.source_id]); },
    });
  }

  // ---------- pricing ----------
  private async price(q: Queryable, lines: ResolvedLine[], inputs: OrderLineInput[], orderDate: string): Promise<PricedLine[]> {
    const dp = await this.settings.get('business.currency_decimals', null, q);
    const out: PricedLine[] = [];
    for (const [i, l] of lines.entries()) {
      const unitPrice = inputs[i].unitPrice;
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(unitPrice)) throw AppError.badRequest('INVALID_PRICE', 'A unit price is not a valid amount.');
      const amount = lineTotal(unitPrice, l.quantity, 'half_up', dp);
      if (l.taxCategoryId) {
        const t = await this.tax.calculate({ taxCategoryId: l.taxCategoryId, amount, date: orderDate }, q);
        out.push({ ...l, unitPrice: format(parse(unitPrice)), taxRate: t.rule.ratePercent, lineNet: t.net, taxAmount: t.tax, lineTotal: t.gross });
      } else out.push({ ...l, unitPrice: format(parse(unitPrice)), taxRate: '0.0000', lineNet: amount, taxAmount: '0.0000', lineTotal: amount });
    }
    return out;
  }

  private totals(items: PricedLine[]) {
    return items.reduce((t, i) => ({ subtotal: add(t.subtotal, i.lineNet), tax: add(t.tax, i.taxAmount), total: add(t.total, i.lineTotal) }), { subtotal: '0.0000', tax: '0.0000', total: '0.0000' });
  }

  private async writeItems(q: PoolClient, orderId: string, items: PricedLine[]) {
    for (const i of items) {
      await q.query(`insert into procurement.purchase_order_items (order_id, product_id, unit_id, quantity, base_quantity, unit_price, tax_rate, line_net, tax_amount, line_total) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [orderId, i.productId, i.unitId, i.quantity, i.baseQuantity, i.unitPrice, i.taxRate, i.lineNet, i.taxAmount, i.lineTotal]);
    }
  }

  private async assertSupplier(q: Queryable, supplierId: string) {
    const s = await maybeOne<{ status: string }>(q, `select status from procurement.suppliers where id = $1`, [supplierId]);
    if (!s) throw AppError.badRequest('SUPPLIER_NOT_FOUND', 'The supplier does not exist.');
    if (s.status !== 'active') throw AppError.conflict('SUPPLIER_NOT_ACTIVE', `The supplier is ${s.status}; orders cannot be placed with it.`);
  }

  // ---------- creating and editing ----------
  async create(auth: AuthContext, dto: { supplierId: string; warehouseId: string; purchaseRequestId?: string; orderDate?: string; expectedDate?: string; note?: string; items: OrderLineInput[] }) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'procurement.order', dto.warehouseId);
    const orderDate = dto.orderDate ?? (await this.settings.businessDate());
    if (dto.expectedDate && dto.expectedDate < orderDate) throw AppError.badRequest('INVALID_DATES', 'The expected delivery date cannot be before the order date.');
    const id = await this.db.tx(async (q) => {
      await this.assertSupplier(q, dto.supplierId);
      if (dto.purchaseRequestId) {
        const pr = await maybeOne<{ status: string; branch_id: string }>(q, `select status, branch_id from procurement.purchase_requests where id = $1 for update`, [dto.purchaseRequestId]);
        if (!pr || pr.branch_id !== branchId) throw AppError.badRequest('REQUEST_NOT_FOUND', 'The purchase request does not exist for this branch.');
        if (pr.status !== 'approved') throw AppError.conflict('REQUEST_NOT_APPROVED', 'Only an approved purchase request can be turned into an order.');
        await q.query(`update procurement.purchase_requests set status = 'converted', version = version + 1 where id = $1`, [dto.purchaseRequestId]);
      }
      const resolved = await this.lines.resolve(q, dto.items);
      const priced = await this.price(q, resolved, dto.items, orderDate);
      const t = this.totals(priced);
      const reference = await this.sequences.next(q, 'purchase_order', branchId);
      const o = await one<{ id: string }>(q, `insert into procurement.purchase_orders (reference_no, branch_id, warehouse_id, supplier_id, purchase_request_id, order_date, expected_date, subtotal, tax_total, total, note, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`, [reference, branchId, dto.warehouseId, dto.supplierId, dto.purchaseRequestId ?? null, orderDate, dto.expectedDate ?? null, t.subtotal, t.tax, t.total, dto.note ?? null, auth.userId]);
      await this.writeItems(q, o.id, priced);
      await this.audit.record({ action: 'purchase_order.created', entityType: 'purchase_order', entityId: o.id, branchId, newValue: { reference, total: t.total, ...dto } }, q);
      return o.id;
    });
    return this.get(auth, id);
  }

  private async loadOwned(auth: AuthContext, q: Queryable, id: string, permission: string, lock = false): Promise<OrderRow> {
    const o = await maybeOne<OrderRow>(q, `select * from procurement.purchase_orders where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!o || !auth.scopeFor('procurement.read').includes(o.branch_id)) throw notFound();
    if (!auth.scopeFor(permission).includes(o.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission for this action.');
    return o;
  }

  async updateDraft(auth: AuthContext, id: string, dto: { version: number; supplierId?: string; expectedDate?: string; note?: string; items?: OrderLineInput[] }) {
    await this.db.tx(async (q) => {
      const o = await this.loadOwned(auth, q, id, 'procurement.order', true);
      if (o.status !== 'draft') throw AppError.conflict('ORDER_NOT_DRAFT', 'Only a draft order can be edited. Use a revision for an approved order.');
      if (o.version !== dto.version) throw AppError.conflict('VERSION_CONFLICT', 'The order was changed by someone else. Reload it and try again.');
      if (dto.supplierId) await this.assertSupplier(q, dto.supplierId);
      if (dto.expectedDate && dto.expectedDate < o.order_date.toString().slice(0, 10)) throw AppError.badRequest('INVALID_DATES', 'The expected delivery date cannot be before the order date.');
      let t = null as ReturnType<OrdersService['totals']> | null;
      if (dto.items) {
        const priced = await this.price(q, await this.lines.resolve(q, dto.items), dto.items, new Date(o.order_date).toISOString().slice(0, 10));
        await q.query(`delete from procurement.purchase_order_items where order_id = $1`, [id]);
        await this.writeItems(q, id, priced);
        t = this.totals(priced);
      }
      await q.query(`update procurement.purchase_orders set supplier_id = coalesce($2, supplier_id), expected_date = coalesce($3, expected_date), note = coalesce($4, note),
          subtotal = coalesce($5, subtotal), tax_total = coalesce($6, tax_total), total = coalesce($7, total), version = version + 1 where id = $1`,
        [id, dto.supplierId ?? null, dto.expectedDate ?? null, dto.note ?? null, t?.subtotal ?? null, t?.tax ?? null, t?.total ?? null]);
      await this.audit.record({ action: 'purchase_order.updated', entityType: 'purchase_order', entityId: id, branchId: o.branch_id, newValue: dto }, q);
    });
    return this.get(auth, id);
  }

  /** Money already owed to the supplier plus orders placed but not yet invoiced. */
  private async exposure(q: Queryable, supplierId: string, excludeOrderId: string): Promise<string> {
    const owed = await one<{ v: string }>(q, `select coalesce(sum(total - paid_total - credited_total), 0)::numeric(18,4) as v from procurement.supplier_invoices where supplier_id = $1 and status in ('open', 'partially_paid', 'pending_approval')`, [supplierId]);
    const committed = await one<{ v: string }>(q, `select coalesce(sum(greatest(po.total - coalesce((select sum(i.total) from procurement.supplier_invoices i where i.purchase_order_id = po.id and i.status not in ('rejected', 'cancelled')), 0), 0)), 0)::numeric(18,4) as v
        from procurement.purchase_orders po where po.supplier_id = $1 and po.status in ('approved', 'partially_received') and po.id <> $2`, [supplierId, excludeOrderId]);
    return add(owed.v, committed.v);
  }

  async submit(auth: AuthContext, id: string) {
    const needsApproval = await this.settings.get('procurement.po_approval_required');
    await this.db.tx(async (q) => {
      const o = await this.loadOwned(auth, q, id, 'procurement.order', true);
      if (o.status !== 'draft') throw AppError.conflict('ORDER_NOT_DRAFT', 'This order has already been submitted.');
      if (!needsApproval && !auth.can('procurement.order_approve', o.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Orders are approved automatically, so you need the order-approval permission.');
      if ((await this.settings.get('procurement.enforce_credit_limit', null, q)) === true) {
        const s = await one<{ credit_limit: string }>(q, `select credit_limit from procurement.suppliers where id = $1`, [o.supplier_id]);
        if (cmp(s.credit_limit, '0') > 0) {
          const outstanding = await this.exposure(q, o.supplier_id, id);
          if (cmp(add(outstanding, o.total), s.credit_limit) > 0) throw AppError.conflict('CREDIT_LIMIT_EXCEEDED', 'This order would take the supplier past its credit limit.', { creditLimit: format(parse(s.credit_limit)), outstanding, orderTotal: format(parse(o.total)) });
        }
      }
      if (cmp(o.total, '0') <= 0) throw AppError.badRequest('EMPTY_ORDER', 'An order must have a total greater than zero.');
      if (needsApproval) {
        await q.query(`update procurement.purchase_orders set status = 'pending_approval', version = version + 1 where id = $1`, [id]);
        await this.approvals.request(q, auth, { actionCode: 'procurement.order', sourceType: 'purchase_order', sourceId: id, branchId: o.branch_id, requiredPermission: 'procurement.order_approve', summary: { reference: o.reference_no, total: o.total } });
      } else await this.markApproved(q, id, auth.userId);
      await this.audit.record({ action: 'purchase_order.submitted', entityType: 'purchase_order', entityId: id, branchId: o.branch_id }, q);
    });
    return this.get(auth, id);
  }

  private async markApproved(q: PoolClient, id: string, userId: string) {
    await q.query(`update procurement.purchase_orders po set status = 'approved', approved_by = $2, approved_at = now(), version = version + 1,
        payment_terms_days = (select payment_terms_days from procurement.suppliers s where s.id = po.supplier_id) where po.id = $1 and po.status in ('pending_approval', 'draft')`, [id, userId]);
    await this.audit.record({ action: 'purchase_order.approved', entityType: 'purchase_order', entityId: id }, q);
  }

  // ---------- changing an approved order ----------
  async revise(auth: AuthContext, id: string, dto: { reason: string; expectedDate?: string; items: OrderLineInput[] }) {
    await this.db.tx(async (q) => {
      const o = await this.loadOwned(auth, q, id, 'procurement.order', true);
      if (!['approved', 'partially_received'].includes(o.status)) throw AppError.conflict('ORDER_NOT_REVISABLE', 'Only an approved order that is not yet complete can be revised.');
      if (await maybeOne(q, `select 1 from procurement.purchase_order_revisions where order_id = $1 and status = 'pending'`, [id])) throw AppError.conflict('REVISION_PENDING', 'A change to this order is already waiting for approval.');
      const resolved = await this.lines.resolve(q, dto.items);
      const received = await many<{ product_id: string; unit_id: string; received_base: string }>(q, `select product_id, unit_id, received_base from procurement.purchase_order_items where order_id = $1 and received_base > 0`, [id]);
      for (const r of received) {
        const kept = resolved.find((l) => l.productId === r.product_id && l.unitId === r.unit_id);
        if (!kept) throw AppError.badRequest('LINE_ALREADY_RECEIVED', 'A line that has already been received cannot be removed.', { productId: r.product_id });
        if (cmp(kept.baseQuantity, r.received_base) < 0) throw AppError.badRequest('BELOW_RECEIVED', 'A line cannot be reduced below what has already been received.', { productId: r.product_id, received: format(parse(r.received_base)) });
      }
      await this.price(q, resolved, dto.items, new Date(o.order_date).toISOString().slice(0, 10)); // proves the new prices and taxes work before asking anyone to approve
      // Numbering continues past rejected or withdrawn attempts so revision numbers are never reused
      const next = Number((await one<{ n: string }>(q, `select coalesce(max(revision_no), $2)::int + 1 as n from procurement.purchase_order_revisions where order_id = $1`, [id, o.revision])).n);
      const rev = await one<{ id: string }>(q, `insert into procurement.purchase_order_revisions (order_id, revision_no, reason, items, requested_by) values ($1, $2, $3, $4, $5) returning id`, [id, next, dto.reason, JSON.stringify({ items: dto.items, expectedDate: dto.expectedDate ?? null }), auth.userId]);
      await this.approvals.request(q, auth, { actionCode: 'procurement.order_revision', sourceType: 'purchase_order_revision', sourceId: rev.id, branchId: o.branch_id, requiredPermission: 'procurement.order_approve', summary: { reference: o.reference_no, revision: next, reason: dto.reason } });
      await this.audit.record({ action: 'purchase_order.revision_requested', entityType: 'purchase_order', entityId: id, branchId: o.branch_id, newValue: { revision: next, reason: dto.reason } }, q);
    });
    return this.get(auth, id);
  }

  private async applyRevision(q: PoolClient, r: ApprovalRequestRow, auth: AuthContext) {
    const rev = await one<{ order_id: string; revision_no: number; status: string; items: { items: OrderLineInput[]; expectedDate: string | null } }>(q, `select * from procurement.purchase_order_revisions where id = $1 for update`, [r.source_id]);
    if (rev.status !== 'pending') throw AppError.conflict('REVISION_NOT_PENDING', 'This change is no longer pending.');
    const o = await one<OrderRow>(q, `select * from procurement.purchase_orders where id = $1 for update`, [rev.order_id]);
    const resolved = await this.lines.resolve(q, rev.items.items);
    const priced = await this.price(q, resolved, rev.items.items, new Date(o.order_date).toISOString().slice(0, 10));
    const existing = await many<{ id: string; product_id: string; unit_id: string; received_base: string }>(q, `select id, product_id, unit_id, received_base from procurement.purchase_order_items where order_id = $1`, [o.id]);
    for (const e of existing) {
      const kept = priced.find((l) => l.productId === e.product_id && l.unitId === e.unit_id);
      if (!kept) {
        if (cmp(e.received_base, '0') > 0) throw AppError.conflict('LINE_ALREADY_RECEIVED', 'Goods for a removed line have arrived since the change was requested.');
        await q.query(`delete from procurement.purchase_order_items where id = $1`, [e.id]);
      } else {
        if (cmp(kept.baseQuantity, e.received_base) < 0) throw AppError.conflict('BELOW_RECEIVED', 'More has been received than the revised quantity.');
        await q.query(`update procurement.purchase_order_items set quantity = $2, base_quantity = $3, unit_price = $4, tax_rate = $5, line_net = $6, tax_amount = $7, line_total = $8 where id = $1`,
          [e.id, kept.quantity, kept.baseQuantity, kept.unitPrice, kept.taxRate, kept.lineNet, kept.taxAmount, kept.lineTotal]);
      }
    }
    await this.writeItems(q, o.id, priced.filter((l) => !existing.some((e) => e.product_id === l.productId && e.unit_id === l.unitId)));
    const t = this.totals(priced);
    await q.query(`update procurement.purchase_orders set subtotal = $2, tax_total = $3, total = $4, revision = $5, expected_date = coalesce($6, expected_date), version = version + 1 where id = $1`, [o.id, t.subtotal, t.tax, t.total, rev.revision_no, rev.items.expectedDate]);
    await this.refreshStatus(q, o.id);
    await q.query(`update procurement.purchase_order_revisions set status = 'applied' where id = $1`, [r.source_id]);
    await this.audit.record({ action: 'purchase_order.revised', entityType: 'purchase_order', entityId: o.id, branchId: o.branch_id, newValue: { revision: rev.revision_no, total: t.total } }, q);
  }

  /** received when every line is fully delivered, partially_received when something arrived, otherwise approved. */
  async refreshStatus(q: Queryable, orderId: string) {
    await q.query(`update procurement.purchase_orders po set status = case
        when not exists (select 1 from procurement.purchase_order_items i where i.order_id = po.id and i.received_base < i.base_quantity) then 'received'
        when exists (select 1 from procurement.purchase_order_items i where i.order_id = po.id and i.received_base > 0) then 'partially_received'
        else 'approved' end, version = version + 1
      where po.id = $1 and po.status in ('approved', 'partially_received', 'received')`, [orderId]);
  }

  // ---------- ending an order ----------
  async cancel(auth: AuthContext, id: string, reason: string) {
    const head = await this.loadOwned(auth, this.db, id, 'procurement.order');
    if (head.status === 'pending_approval') {
      const req = await maybeOne<{ id: string; requested_by: string }>(this.db, `select id, requested_by from platform.approval_requests where source_type = 'purchase_order' and source_id = $1 and status = 'pending'`, [id]);
      if (req && req.requested_by === auth.userId) await this.approvals.cancel(auth, req.id);
      else throw AppError.conflict('ORDER_PENDING_APPROVAL', 'Only the person who submitted the order can withdraw it from approval.');
    }
    await this.db.tx(async (q) => {
      const o = await this.loadOwned(auth, q, id, 'procurement.order', true);
      if (!['draft', 'approved'].includes(o.status)) throw AppError.conflict('ORDER_NOT_CANCELLABLE', 'Only an order with nothing received can be cancelled. Close a partly delivered order instead.');
      if (await maybeOne(q, `select 1 from procurement.goods_receipts where purchase_order_id = $1`, [id])) throw AppError.conflict('ORDER_NOT_CANCELLABLE', 'Goods have already been received against this order.');
      await q.query(`update procurement.purchase_orders set status = 'cancelled', cancel_reason = $2, version = version + 1 where id = $1`, [id, reason]);
      await this.audit.record({ action: 'purchase_order.cancelled', entityType: 'purchase_order', entityId: id, branchId: o.branch_id, newValue: { reason } }, q);
    });
    return this.get(auth, id);
  }

  /** Stops waiting for the rest of a partly delivered order. */
  async close(auth: AuthContext, id: string, reason: string) {
    await this.db.tx(async (q) => {
      const o = await this.loadOwned(auth, q, id, 'procurement.order', true);
      if (o.status !== 'partially_received') throw AppError.conflict('ORDER_NOT_CLOSABLE', 'Only a partly delivered order can be closed.');
      await q.query(`update procurement.purchase_orders set status = 'closed', cancel_reason = $2, version = version + 1 where id = $1`, [id, reason]);
      await this.audit.record({ action: 'purchase_order.closed', entityType: 'purchase_order', entityId: id, branchId: o.branch_id, newValue: { reason } }, q);
    });
    return this.get(auth, id);
  }

  // ---------- reading ----------
  async get(auth: AuthContext, id: string) {
    const o = await maybeOne<OrderRow>(this.db,
      `select o.*, s.name as supplier_name, s.code as supplier_code, cu.username as created_by_name,
              (select a.id from platform.approval_requests a where a.source_type = 'purchase_order' and a.source_id = o.id order by a.requested_at desc limit 1) as approval_id
         from procurement.purchase_orders o join procurement.suppliers s on s.id = o.supplier_id join iam.users cu on cu.id = o.created_by where o.id = $1`, [id]);
    if (!o || !auth.scopeFor('procurement.read').includes(o.branch_id)) throw notFound();
    const items = await many(this.db,
      `select i.id, i.product_id, p.sku, p.name as product_name, i.unit_id, u.code as unit_code, i.quantity, i.base_quantity, i.unit_price, i.tax_rate, i.line_net, i.tax_amount, i.line_total,
              i.received_base, i.accepted_base, i.rejected_base, (i.base_quantity - i.received_base)::numeric(18,4) as outstanding_base
         from procurement.purchase_order_items i join catalog.products p on p.id = i.product_id join catalog.units u on u.id = i.unit_id where i.order_id = $1 order by p.name`, [id]);
    const pending = await maybeOne(this.db, `select r.id, r.revision_no, r.reason, r.requested_at, (select a.id from platform.approval_requests a where a.source_type = 'purchase_order_revision' and a.source_id = r.id order by a.requested_at desc limit 1) as approval_id from procurement.purchase_order_revisions r where r.order_id = $1 and r.status = 'pending'`, [id]);
    return { ...o, items, pending_revision: pending };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; supplierId?: string; branchId?: string; from?: string; to?: string; outstanding?: boolean; overdue?: boolean }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('procurement.read').sql('o.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.status) add2('o.status = ?', q.status);
    if (q.supplierId) add2('o.supplier_id = ?', q.supplierId);
    if (q.branchId) add2('o.branch_id = ?', q.branchId);
    if (q.from) add2('o.order_date >= ?', q.from);
    if (q.to) add2('o.order_date <= ?', q.to);
    if (q.outstanding || q.overdue) where.push(`o.status in ('approved', 'partially_received')`);
    if (q.overdue) add2('o.expected_date < ?', await this.settings.businessDate());
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.purchase_orders o where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select o.id, o.reference_no, o.branch_id, o.supplier_id, s.name as supplier_name, o.status, o.order_date, o.expected_date, o.total, o.revision
        from procurement.purchase_orders o join procurement.suppliers s on s.id = o.supplier_id where ${w} order by o.order_date desc, o.reference_no desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** What was ordered, delivered, accepted and invoiced, side by side. */
  async matching(auth: AuthContext, id: string) {
    const o = await this.get(auth, id) as { items: Array<{ line_total: string; base_quantity: string; received_base: string; accepted_base: string }>; total: string };
    const dp = await this.settings.get('business.currency_decimals');
    const val = await one<{ received: string; accepted: string; invoiced: string }>(this.db,
      `select coalesce(round(sum(i.line_total * i.received_base / i.base_quantity), $2), 0)::numeric(18,4) as received,
              coalesce(round(sum(i.line_total * i.accepted_base / i.base_quantity), $2), 0)::numeric(18,4) as accepted,
              (select coalesce(sum(x.total), 0)::numeric(18,4) from procurement.supplier_invoices x where x.purchase_order_id = $1 and x.status not in ('rejected', 'cancelled')) as invoiced
         from procurement.purchase_order_items i where i.order_id = $1`, [id, dp]);
    return { ordered: format(parse(o.total)), receivedValue: val.received, acceptedValue: val.accepted, invoiced: val.invoiced, toInvoice: format(parse(val.accepted) - parse(val.invoiced)), items: o.items };
  }
}
