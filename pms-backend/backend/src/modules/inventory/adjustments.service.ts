import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, mul, parse } from '../../domain/decimal';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { InventoryService } from './inventory.service';
import { LedgerService, PostEntry, StockStatus } from './ledger.service';

export interface NewBatchDto { batchRef: string; expiryDate: string; manufactureDate?: string; unitCost: string; supplierId?: string }
export interface AdjustmentItemDto {
  productId: string; unitId?: string; quantity: string; direction: 'increase' | 'decrease';
  batchId?: string; newBatch?: NewBatchDto; locationId?: string; note?: string;
}
export interface CreateAdjustmentDto { warehouseId: string; reasonCode: string; reason: string; items: AdjustmentItemDto[] }
export interface DisposalItemDto { batchId: string; locationId?: string; status: 'quarantined' | 'damaged' | 'expired'; quantity: string; unitId?: string }
export interface CreateDisposalDto { warehouseId: string; reason: string; note?: string; items: DisposalItemDto[] }

const adjNotFound = () => AppError.notFound('ADJUSTMENT_NOT_FOUND', 'Stock adjustment not found.');
const dispNotFound = () => AppError.notFound('DISPOSAL_NOT_FOUND', 'Disposal not found.');

@Injectable()
export class AdjustmentsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('inventory.adjustment', {
      onApproved: (q, r, auth) => this.finish(q, r, auth, true),
      onRejected: (q, r, auth) => this.finish(q, r, auth, false),
      onCancelled: async (q, r) => { await q.query(`update inventory.stock_adjustments set status = 'cancelled', decided_at = now() where id = $1 and status = 'pending'`, [r.source_id]); },
    });
    this.approvals.registerHandler('inventory.disposal', {
      onApproved: (q, r, auth) => this.finishDisposal(q, r, auth, true),
      onRejected: (q, r, auth) => this.finishDisposal(q, r, auth, false),
      onCancelled: async (q, r) => { await q.query(`update inventory.stock_disposals set status = 'cancelled', decided_at = now() where id = $1 and status = 'pending'`, [r.source_id]); },
    });
  }

  // =============== adjustments ===============
  async create(auth: AuthContext, dto: CreateAdjustmentDto) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'inventory.adjust', dto.warehouseId);
    if (dto.reasonCode === 'opening_balance' && dto.items.some((i) => i.direction !== 'increase')) throw AppError.badRequest('OPENING_BALANCE_INCREASE_ONLY', 'An opening balance can only add stock.');
    const needsApproval = await this.settings.get('inventory.adjustment_approval_required');
    if (!needsApproval && !auth.can('inventory.adjust_approve', branchId)) {
      throw AppError.forbidden('PERMISSION_DENIED', 'Adjustments are posted immediately, so you need the adjustment-approval permission.');
    }

    const id = await this.db.tx(async (q) => {
      const prepared: Array<{ productId: string; batchId: string | null; newBatch: NewBatchDto | null; locationId: string | null; delta: string; note: string | null }> = [];
      for (const item of dto.items) {
        if (!!item.batchId === !!item.newBatch) throw AppError.badRequest('BATCH_REQUIRED', 'Each line needs either an existing batch or new batch details.');
        if (item.newBatch && item.direction !== 'increase') throw AppError.badRequest('NEW_BATCH_INCREASE_ONLY', 'New batches can only be used to add stock.');
        const base = await this.inventory.toBase(q, item.productId, item.unitId, item.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        if (item.batchId) {
          const b = await maybeOne<{ product_id: string }>(q, `select product_id from inventory.stock_batches where id = $1`, [item.batchId]);
          if (!b) throw AppError.badRequest('BATCH_NOT_FOUND', 'The batch does not exist.');
          if (b.product_id !== item.productId) throw AppError.badRequest('BATCH_PRODUCT_MISMATCH', 'The batch belongs to a different product.');
        }
        const delta = item.direction === 'increase' ? base : format(-parse(base));
        if (item.direction === 'decrease') await this.assertAvailable(q, dto.warehouseId, item.locationId ?? null, item.batchId!, 'available', base);
        prepared.push({ productId: item.productId, batchId: item.batchId ?? null, newBatch: item.newBatch ?? null, locationId: item.locationId ?? null, delta, note: item.note ?? null });
      }
      const reference = await this.sequences.next(q, 'stock_adjustment', branchId);
      const adj = await one<{ id: string }>(q,
        `insert into inventory.stock_adjustments (reference_no, branch_id, warehouse_id, reason_code, reason, requested_by) values ($1, $2, $3, $4, $5, $6) returning id`,
        [reference, branchId, dto.warehouseId, dto.reasonCode, dto.reason.trim(), auth.userId]);
      for (const p of prepared) {
        await q.query(`insert into inventory.stock_adjustment_items (adjustment_id, product_id, batch_id, new_batch, location_id, quantity_delta, note) values ($1, $2, $3, $4, $5, $6, $7)`,
          [adj.id, p.productId, p.batchId, p.newBatch ? JSON.stringify(p.newBatch) : null, p.locationId, p.delta, p.note]);
      }
      await this.audit.record({ action: 'stock.adjustment_requested', entityType: 'stock_adjustment', entityId: adj.id, branchId, newValue: { reference, ...dto } }, q);
      if (needsApproval) {
        await this.approvals.request(q, auth, { actionCode: 'inventory.adjustment', sourceType: 'stock_adjustment', sourceId: adj.id, branchId, requiredPermission: 'inventory.adjust_approve', summary: { reference, reasonCode: dto.reasonCode, lines: dto.items.length } });
      } else {
        await this.post(q, adj.id, auth, auth.userId);
      }
      return adj.id;
    });
    return this.get(auth, id);
  }

  private assertAvailable(q: PoolClient, warehouseId: string, locationId: string | null, batchId: string, status: StockStatus, needed: string) {
    return this.inventory.assertAvailable(q, warehouseId, locationId, batchId, status, needed);
  }

  /** Writes the stock movements for an adjustment. Runs inside the approval decision, so a failure leaves it pending. */
  private async post(q: PoolClient, adjustmentId: string, auth: AuthContext, requestedBy: string) {
    const adj = await maybeOne<{ id: string; reference_no: string; branch_id: string; warehouse_id: string; reason_code: string; reason: string; status: string }>(
      q, `select * from inventory.stock_adjustments where id = $1 for update`, [adjustmentId]);
    if (!adj || adj.status !== 'pending') throw AppError.conflict('ADJUSTMENT_NOT_PENDING', 'This adjustment is no longer pending.');
    const items = await many<{ product_id: string; batch_id: string | null; new_batch: NewBatchDto | null; location_id: string | null; quantity_delta: string }>(
      q, `select product_id, batch_id, new_batch, location_id, quantity_delta from inventory.stock_adjustment_items where adjustment_id = $1 order by id`, [adjustmentId]);
    const entries: PostEntry[] = [];
    for (const i of items) {
      let batchId = i.batch_id;
      if (!batchId) {
        const nb = i.new_batch!;
        batchId = (await this.inventory.findOrCreateBatch(q, { productId: i.product_id, batchRef: nb.batchRef, expiryDate: nb.expiryDate, manufactureDate: nb.manufactureDate, unitCost: nb.unitCost, supplierId: nb.supplierId, createdBy: requestedBy })).id;
      }
      entries.push({
        productId: i.product_id, batchId, warehouseId: adj.warehouse_id, locationId: i.location_id, status: 'available', quantityDelta: i.quantity_delta,
        movementType: adj.reason_code === 'opening_balance' ? 'opening_balance' : 'adjustment', referenceNo: adj.reference_no, sourceType: 'stock_adjustment', sourceId: adj.id, reason: `${adj.reason_code}: ${adj.reason}`, createdBy: requestedBy,
      });
    }
    const moved = await this.ledger.post(q, entries);
    if (adj.reason_code !== 'opening_balance') {
      const value = moved.reduce((t, m) => add(t, mul(cmp(m.quantity_delta, '0') < 0 ? format(-parse(m.quantity_delta)) : m.quantity_delta, m.unit_cost)), '0.0000');
      const limit = await this.settings.get('notifications.unusual_adjustment_value', adj.branch_id, q);
      if (cmp(limit, '0') > 0 && cmp(value, limit) >= 0) {
        await this.notifications.raise(q, { type: 'unusual_adjustment', severity: 'warning', branchId: adj.branch_id, permission: 'inventory.adjust_approve', dedupeKey: `unusual_adjustment:${adj.id}`, title: `Large stock adjustment ${adj.reference_no}`, body: `Worth ${value} at cost (${adj.reason_code}: ${adj.reason}).`, entityType: 'stock_adjustment', entityId: adj.id, data: { value } });
      }
    }
    await q.query(`update inventory.stock_adjustments set status = 'posted', posted_at = now(), decided_by = $2, decided_at = now(), version = version + 1 where id = $1`, [adj.id, auth.userId]);
    await this.audit.record({ action: 'stock.adjustment_posted', entityType: 'stock_adjustment', entityId: adj.id, branchId: adj.branch_id, newValue: { reference: adj.reference_no, lines: items.length } }, q);
  }

  private async finish(q: PoolClient, r: ApprovalRequestRow, auth: AuthContext, approved: boolean) {
    if (approved) {
      const requester = (await one<{ requested_by: string }>(q, `select requested_by from inventory.stock_adjustments where id = $1`, [r.source_id])).requested_by;
      await this.post(q, r.source_id, auth, requester);
    } else {
      await q.query(`update inventory.stock_adjustments set status = 'rejected', decided_by = $2, decided_at = now(), version = version + 1 where id = $1 and status = 'pending'`, [r.source_id, auth.userId]);
      await this.audit.record({ action: 'stock.adjustment_rejected', entityType: 'stock_adjustment', entityId: r.source_id, branchId: r.branch_id }, q);
    }
  }

  async cancel(auth: AuthContext, id: string) {
    const adj = await this.get(auth, id);
    const req = await maybeOne<{ id: string }>(this.db, `select id from platform.approval_requests where source_type = 'stock_adjustment' and source_id = $1 and status = 'pending'`, [adj.id]);
    if (!req) throw AppError.conflict('ADJUSTMENT_NOT_PENDING', 'Only a pending adjustment can be cancelled.');
    await this.approvals.cancel(auth, req.id);
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const adj = await maybeOne<{ id: string; branch_id: string }>(this.db,
      `select a.*, ru.username as requested_by_name, du.username as decided_by_name, (select r.id from platform.approval_requests r where r.source_type = 'stock_adjustment' and r.source_id = a.id order by r.requested_at desc limit 1) as approval_id
         from inventory.stock_adjustments a join iam.users ru on ru.id = a.requested_by left join iam.users du on du.id = a.decided_by where a.id = $1`, [id]);
    if (!adj || !auth.scopeFor('inventory.read').includes(adj.branch_id)) throw adjNotFound();
    const items = await many(this.db,
      `select i.id, i.product_id, p.sku, p.name as product_name, i.batch_id, i.new_batch, i.location_id, i.quantity_delta, i.note
         from inventory.stock_adjustment_items i join catalog.products p on p.id = i.product_id where i.adjustment_id = $1 order by i.id`, [id]);
    return { ...adj, items };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('a.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`a.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`a.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_adjustments a where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select a.id, a.reference_no, a.branch_id, a.warehouse_id, a.reason_code, a.reason, a.status, a.requested_at, a.posted_at, ru.username as requested_by_name
      from inventory.stock_adjustments a join iam.users ru on ru.id = a.requested_by where ${w} order by a.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // =============== disposals ===============
  async createDisposal(auth: AuthContext, dto: CreateDisposalDto) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'inventory.dispose', dto.warehouseId);
    const needsApproval = await this.settings.get('inventory.disposal_approval_required');
    if (!needsApproval && !auth.can('inventory.dispose_approve', branchId)) throw AppError.forbidden('PERMISSION_DENIED', 'Disposals are posted immediately, so you need the disposal-approval permission.');

    const id = await this.db.tx(async (q) => {
      const prepared: Array<{ productId: string; batchId: string; locationId: string | null; status: string; qty: string }> = [];
      for (const item of dto.items) {
        const b = await maybeOne<{ product_id: string }>(q, `select product_id from inventory.stock_batches where id = $1`, [item.batchId]);
        if (!b) throw AppError.badRequest('BATCH_NOT_FOUND', 'The batch does not exist.');
        const base = await this.inventory.toBase(q, b.product_id, item.unitId, item.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        await this.assertAvailable(q, dto.warehouseId, item.locationId ?? null, item.batchId, item.status, base);
        prepared.push({ productId: b.product_id, batchId: item.batchId, locationId: item.locationId ?? null, status: item.status, qty: base });
      }
      const reference = await this.sequences.next(q, 'disposal', branchId);
      const d = await one<{ id: string }>(q, `insert into inventory.stock_disposals (reference_no, branch_id, warehouse_id, reason, note, requested_by) values ($1, $2, $3, $4, $5, $6) returning id`, [reference, branchId, dto.warehouseId, dto.reason, dto.note ?? null, auth.userId]);
      for (const p of prepared) await q.query(`insert into inventory.stock_disposal_items (disposal_id, product_id, batch_id, location_id, status, quantity) values ($1, $2, $3, $4, $5, $6)`, [d.id, p.productId, p.batchId, p.locationId, p.status, p.qty]);
      await this.audit.record({ action: 'stock.disposal_requested', entityType: 'stock_disposal', entityId: d.id, branchId, newValue: { reference, ...dto } }, q);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'inventory.disposal', sourceType: 'stock_disposal', sourceId: d.id, branchId, requiredPermission: 'inventory.dispose_approve', summary: { reference, reason: dto.reason, lines: dto.items.length } });
      else await this.postDisposal(q, d.id, auth, auth.userId);
      return d.id;
    });
    return this.getDisposal(auth, id);
  }

  private async postDisposal(q: PoolClient, id: string, auth: AuthContext, requestedBy: string) {
    const d = await maybeOne<{ id: string; reference_no: string; branch_id: string; warehouse_id: string; reason: string; status: string }>(q, `select * from inventory.stock_disposals where id = $1 for update`, [id]);
    if (!d || d.status !== 'pending') throw AppError.conflict('DISPOSAL_NOT_PENDING', 'This disposal is no longer pending.');
    const items = await many<{ product_id: string; batch_id: string; location_id: string | null; status: StockStatus; quantity: string }>(q, `select product_id, batch_id, location_id, status, quantity from inventory.stock_disposal_items where disposal_id = $1 order by id`, [id]);
    await this.ledger.post(q, items.map((i): PostEntry => ({
      productId: i.product_id, batchId: i.batch_id, warehouseId: d.warehouse_id, locationId: i.location_id, status: i.status, quantityDelta: format(-parse(i.quantity)),
      movementType: 'disposal', referenceNo: d.reference_no, sourceType: 'stock_disposal', sourceId: d.id, reason: d.reason, createdBy: requestedBy,
    })));
    await q.query(`update inventory.stock_disposals set status = 'posted', posted_at = now(), decided_by = $2, decided_at = now(), version = version + 1 where id = $1`, [id, auth.userId]);
    await this.audit.record({ action: 'stock.disposal_posted', entityType: 'stock_disposal', entityId: id, branchId: d.branch_id, newValue: { reference: d.reference_no, lines: items.length } }, q);
  }

  private async finishDisposal(q: PoolClient, r: ApprovalRequestRow, auth: AuthContext, approved: boolean) {
    if (approved) {
      const requester = (await one<{ requested_by: string }>(q, `select requested_by from inventory.stock_disposals where id = $1`, [r.source_id])).requested_by;
      await this.postDisposal(q, r.source_id, auth, requester);
    } else {
      await q.query(`update inventory.stock_disposals set status = 'rejected', decided_by = $2, decided_at = now(), version = version + 1 where id = $1 and status = 'pending'`, [r.source_id, auth.userId]);
      await this.audit.record({ action: 'stock.disposal_rejected', entityType: 'stock_disposal', entityId: r.source_id, branchId: r.branch_id }, q);
    }
  }

  async cancelDisposal(auth: AuthContext, id: string) {
    const d = await this.getDisposal(auth, id);
    const req = await maybeOne<{ id: string }>(this.db, `select id from platform.approval_requests where source_type = 'stock_disposal' and source_id = $1 and status = 'pending'`, [d.id]);
    if (!req) throw AppError.conflict('DISPOSAL_NOT_PENDING', 'Only a pending disposal can be cancelled.');
    await this.approvals.cancel(auth, req.id);
    return this.getDisposal(auth, id);
  }

  async getDisposal(auth: AuthContext, id: string) {
    const d = await maybeOne<{ id: string; branch_id: string }>(this.db,
      `select d.*, ru.username as requested_by_name, (select r.id from platform.approval_requests r where r.source_type = 'stock_disposal' and r.source_id = d.id order by r.requested_at desc limit 1) as approval_id
         from inventory.stock_disposals d join iam.users ru on ru.id = d.requested_by where d.id = $1`, [id]);
    if (!d || !auth.scopeFor('inventory.read').includes(d.branch_id)) throw dispNotFound();
    const items = await many(this.db, `select i.id, i.product_id, p.sku, p.name as product_name, i.batch_id, i.location_id, i.status, i.quantity from inventory.stock_disposal_items i join catalog.products p on p.id = i.product_id where i.disposal_id = $1 order by i.id`, [id]);
    return { ...d, items };
  }

  async listDisposals(auth: AuthContext, q: PageQuery & { status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('d.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`d.status = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_disposals d where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select d.id, d.reference_no, d.branch_id, d.warehouse_id, d.reason, d.status, d.requested_at, d.posted_at from inventory.stock_disposals d where ${w} order by d.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
