import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, parse } from '../../domain/decimal';
import { lineTotal } from '../../domain/pricing';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService, PostEntry, StockStatus } from '../inventory/ledger.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';

const notFound = () => AppError.notFound('RETURN_NOT_FOUND', 'Purchase return not found.');
export interface ReturnItemInput { batchId: string; status: 'quarantined' | 'damaged'; quantity: string; unitId?: string; locationId?: string }

/** Sends goods back to the supplier. Stock leaves through the ledger and the supplier owes the business a credit. */
@Injectable()
export class ReturnsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly inventory: InventoryService, private readonly ledger: LedgerService, private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('procurement.return', {
      onApproved: (q, r, auth) => this.post(q, r.source_id, auth),
      onRejected: async (q, r) => { await q.query(`update procurement.purchase_returns set status = 'rejected', decided_by = $2, decided_at = now(), version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update procurement.purchase_returns set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  async create(auth: AuthContext, dto: { supplierId: string; warehouseId: string; receiptId?: string; reason: string; note?: string; items: ReturnItemInput[] }) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'procurement.return', dto.warehouseId);
    const needsApproval = await this.settings.get('procurement.return_approval_required');
    if (!needsApproval && !auth.can('procurement.return_approve', branchId)) throw AppError.forbidden('PERMISSION_DENIED', 'Returns are posted immediately, so you need the return-approval permission.');
    const id = await this.db.tx(async (q) => {
      if (!(await maybeOne(q, `select 1 from procurement.suppliers where id = $1`, [dto.supplierId]))) throw AppError.badRequest('SUPPLIER_NOT_FOUND', 'The supplier does not exist.');
      if (dto.receiptId && !(await maybeOne(q, `select 1 from procurement.goods_receipts where id = $1 and supplier_id = $2`, [dto.receiptId, dto.supplierId]))) throw AppError.badRequest('RECEIPT_NOT_FOUND', 'The delivery does not exist for this supplier.');
      const dp = await this.settings.get('business.currency_decimals', null, q);
      const prepared: Array<{ productId: string; batchId: string; locationId: string | null; status: string; qty: string; cost: string; credit: string }> = [];
      for (const it of dto.items) {
        const b = await maybeOne<{ product_id: string; supplier_id: string | null; unit_cost: string }>(q, `select product_id, supplier_id, unit_cost from inventory.stock_batches where id = $1`, [it.batchId]);
        if (!b) throw AppError.badRequest('BATCH_NOT_FOUND', 'The batch does not exist.');
        if (b.supplier_id && b.supplier_id !== dto.supplierId) throw AppError.badRequest('BATCH_SUPPLIER_MISMATCH', 'This batch was supplied by a different supplier.');
        const qty = await this.inventory.toBase(q, b.product_id, it.unitId, it.quantity);
        if (cmp(qty, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        await this.inventory.assertAvailable(q, dto.warehouseId, it.locationId ?? null, it.batchId, it.status, qty);
        prepared.push({ productId: b.product_id, batchId: it.batchId, locationId: it.locationId ?? null, status: it.status, qty, cost: b.unit_cost, credit: lineTotal(b.unit_cost, qty, 'half_up', dp) });
      }
      const total = prepared.reduce((t, p) => add(t, p.credit), '0.0000');
      const reference = await this.sequences.next(q, 'purchase_return', branchId);
      const r = await one<{ id: string }>(q, `insert into procurement.purchase_returns (reference_no, supplier_id, branch_id, warehouse_id, receipt_id, reason, note, credit_amount, requested_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [reference, dto.supplierId, branchId, dto.warehouseId, dto.receiptId ?? null, dto.reason.trim(), dto.note ?? null, total, auth.userId]);
      for (const p of prepared) await q.query(`insert into procurement.purchase_return_items (return_id, product_id, batch_id, location_id, status, quantity, unit_cost, credit_amount) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [r.id, p.productId, p.batchId, p.locationId, p.status, p.qty, p.cost, p.credit]);
      await this.audit.record({ action: 'purchase_return.requested', entityType: 'purchase_return', entityId: r.id, branchId, newValue: { reference, credit: total, ...dto } }, q);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'procurement.return', sourceType: 'purchase_return', sourceId: r.id, branchId, requiredPermission: 'procurement.return_approve', summary: { reference, credit: total } });
      else await this.post(q, r.id, auth);
      return r.id;
    });
    return this.get(auth, id);
  }

  private async post(q: PoolClient, id: string, auth: AuthContext) {
    const r = await one<{ id: string; reference_no: string; supplier_id: string; branch_id: string; warehouse_id: string; credit_amount: string; status: string; requested_by: string }>(q, `select * from procurement.purchase_returns where id = $1 for update`, [id]);
    if (r.status !== 'pending_approval') throw AppError.conflict('RETURN_NOT_PENDING', 'This return is no longer pending.');
    const items = await many<{ product_id: string; batch_id: string; location_id: string | null; status: StockStatus; quantity: string }>(q, `select product_id, batch_id, location_id, status, quantity from procurement.purchase_return_items where return_id = $1 order by id`, [id]);
    await this.ledger.post(q, items.map((i): PostEntry => ({ productId: i.product_id, batchId: i.batch_id, warehouseId: r.warehouse_id, locationId: i.location_id, status: i.status, quantityDelta: format(-parse(i.quantity)), movementType: 'purchase_return', referenceNo: r.reference_no, sourceType: 'purchase_return', sourceId: r.id, reason: 'Returned to supplier', createdBy: r.requested_by })));
    if (cmp(r.credit_amount, '0') > 0) await q.query(`insert into procurement.supplier_credits (supplier_id, return_id, amount) values ($1, $2, $3)`, [r.supplier_id, r.id, r.credit_amount]);
    await q.query(`update procurement.purchase_returns set status = 'posted', posted_at = now(), decided_by = $2, decided_at = now(), version = version + 1 where id = $1`, [id, auth.userId]);
    await this.audit.record({ action: 'purchase_return.posted', entityType: 'purchase_return', entityId: id, branchId: r.branch_id, newValue: { reference: r.reference_no, credit: r.credit_amount } }, q);
  }

  async cancel(auth: AuthContext, id: string) {
    const r = await this.get(auth, id) as unknown as { status: string; approval_id: string | null };
    if (r.status !== 'pending_approval' || !r.approval_id) throw AppError.conflict('RETURN_NOT_CANCELLABLE', 'Only a pending return can be cancelled.');
    await this.approvals.cancel(auth, r.approval_id);
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const r = await maybeOne<{ branch_id: string }>(this.db, `select r.*, s.name as supplier_name, ru.username as requested_by_name, (select a.id from platform.approval_requests a where a.source_type = 'purchase_return' and a.source_id = r.id order by a.requested_at desc limit 1) as approval_id
        from procurement.purchase_returns r join procurement.suppliers s on s.id = r.supplier_id join iam.users ru on ru.id = r.requested_by where r.id = $1`, [id]);
    if (!r || !auth.scopeFor('procurement.read').includes(r.branch_id)) throw notFound();
    const items = await many(this.db, `select i.id, i.product_id, p.sku, p.name as product_name, i.batch_id, sb.batch_ref, i.location_id, i.status, i.quantity, i.unit_cost, i.credit_amount from procurement.purchase_return_items i
        join catalog.products p on p.id = i.product_id join inventory.stock_batches sb on sb.id = i.batch_id where i.return_id = $1 order by p.name`, [id]);
    return { ...r, items };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; supplierId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('procurement.read').sql('r.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    if (q.supplierId) { params.push(q.supplierId); where.push(`r.supplier_id = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.purchase_returns r where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select r.id, r.reference_no, r.supplier_id, r.branch_id, r.status, r.credit_amount, r.requested_at, r.posted_at from procurement.purchase_returns r where ${w} order by r.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
