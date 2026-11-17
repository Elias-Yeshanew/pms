import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { InventoryService } from './inventory.service';
import { LedgerService, PostEntry, StockStatus } from './ledger.service';

export interface TransferItemInput { productId: string; unitId?: string; quantity: string; batchId?: string; fromLocationId?: string; toLocationId?: string }
export interface CreateTransferDto { fromWarehouseId: string; toWarehouseId: string; note?: string; items: TransferItemInput[] }
export interface DispatchDto { items?: Array<{ itemId: string; quantitySent: string }> }
export interface ReceiveDto { items?: Array<{ itemId: string; quantityReceived: string; receivedStatus?: 'available' | 'quarantined' | 'damaged'; toLocationId?: string; discrepancyReason?: string }> }

const notFound = () => AppError.notFound('TRANSFER_NOT_FOUND', 'Stock transfer not found.');

interface TransferRow {
  id: string; reference_no: string; from_branch_id: string; to_branch_id: string; from_warehouse_id: string; to_warehouse_id: string;
  status: string; requested_by: string; received_by: string | null;
}
interface ItemRow { id: string; product_id: string; batch_id: string; from_location_id: string | null; to_location_id: string | null; quantity_requested: string; quantity_sent: string | null; quantity_received: string | null }

/**
 * Moves stock between warehouses or branches. Stock leaves the source when it is dispatched and enters the
 * destination only when it is received, with the same batch and expiry date. In between it is "in transit",
 * counted in valuation but not in either shelf. A transfer is never a purchase or a sale.
 */
@Injectable()
export class TransfersService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('inventory.transfer', {
      onApproved: async (q, r, auth) => {
        await q.query(`update inventory.stock_transfers set status = 'approved', approved_by = $2, approved_at = now(), version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, auth.userId]);
        await this.audit.record({ action: 'transfer.approved', entityType: 'stock_transfer', entityId: r.source_id, branchId: r.branch_id }, q);
      },
      onRejected: async (q, r) => { await q.query(`update inventory.stock_transfers set status = 'rejected', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
      onCancelled: async (q, r) => { await q.query(`update inventory.stock_transfers set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  private async load(q: PoolClient | DatabaseService, id: string, lock = false): Promise<TransferRow> {
    const t = await maybeOne<TransferRow>(q, `select * from inventory.stock_transfers where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!t) throw notFound();
    return t;
  }

  /** Visible to the people at either end of the transfer. */
  private canSee(auth: AuthContext, t: Pick<TransferRow, 'from_branch_id' | 'to_branch_id'>) {
    const s = auth.scopeFor('inventory.read');
    return s.includes(t.from_branch_id) || s.includes(t.to_branch_id);
  }

  async create(auth: AuthContext, dto: CreateTransferDto) {
    const fromBranch = await this.inventory.scopedWarehouseBranch(auth, 'inventory.transfer', dto.fromWarehouseId);
    if (dto.fromWarehouseId === dto.toWarehouseId) throw AppError.badRequest('SAME_WAREHOUSE', 'The source and destination must be different warehouses.');
    const dest = await maybeOne<{ branch_id: string; status: string }>(this.db, `select branch_id, status from org.warehouses where id = $1`, [dto.toWarehouseId]);
    if (!dest) throw AppError.badRequest('WAREHOUSE_NOT_FOUND', 'The destination warehouse does not exist.');
    if (dest.status !== 'active') throw AppError.badRequest('WAREHOUSE_INACTIVE', 'The destination warehouse is not active.');
    const needsApproval = await this.settings.get('inventory.transfer_approval_required');
    if (!needsApproval && !auth.can('inventory.transfer_approve', fromBranch)) throw AppError.forbidden('PERMISSION_DENIED', 'Transfers are approved automatically, so you need the transfer-approval permission.');

    const id = await this.db.tx(async (q) => {
      const lines: Array<{ productId: string; batchId: string; fromLocationId: string | null; toLocationId: string | null; qty: string }> = [];
      for (const item of dto.items) {
        const base = await this.inventory.toBase(q, item.productId, item.unitId, item.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        if (item.batchId) {
          const b = await maybeOne<{ product_id: string }>(q, `select product_id from inventory.stock_batches where id = $1`, [item.batchId]);
          if (!b || b.product_id !== item.productId) throw AppError.badRequest('BATCH_PRODUCT_MISMATCH', 'The batch does not exist or belongs to a different product.');
          await this.inventory.assertAvailable(q, dto.fromWarehouseId, item.fromLocationId ?? null, item.batchId, 'available', base);
          lines.push({ productId: item.productId, batchId: item.batchId, fromLocationId: item.fromLocationId ?? null, toLocationId: item.toLocationId ?? null, qty: base });
        } else {
          // No batch chosen: take earliest-expiry stock first from the source warehouse
          const alloc = await this.inventory.fefoAllocate(q, { productId: item.productId, branchId: fromBranch, warehouseId: dto.fromWarehouseId, baseQuantity: base }, false);
          for (const a of alloc) lines.push({ productId: item.productId, batchId: a.batchId, fromLocationId: a.locationId, toLocationId: item.toLocationId ?? null, qty: a.quantity });
        }
      }
      const reference = await this.sequences.next(q, 'stock_transfer', fromBranch);
      const t = await one<{ id: string }>(q,
        `insert into inventory.stock_transfers (reference_no, from_branch_id, to_branch_id, from_warehouse_id, to_warehouse_id, status, note, requested_by, approved_by, approved_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [reference, fromBranch, dest.branch_id, dto.fromWarehouseId, dto.toWarehouseId, needsApproval ? 'pending_approval' : 'approved', dto.note ?? null, auth.userId, needsApproval ? null : auth.userId, needsApproval ? null : new Date()]);
      for (const l of lines) {
        await q.query(`insert into inventory.stock_transfer_items (transfer_id, product_id, batch_id, from_location_id, to_location_id, quantity_requested) values ($1, $2, $3, $4, $5, $6)`, [t.id, l.productId, l.batchId, l.fromLocationId, l.toLocationId, l.qty]);
      }
      await this.audit.record({ action: 'transfer.requested', entityType: 'stock_transfer', entityId: t.id, branchId: fromBranch, newValue: { reference, ...dto } }, q);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'inventory.transfer', sourceType: 'stock_transfer', sourceId: t.id, branchId: fromBranch, requiredPermission: 'inventory.transfer_approve', summary: { reference, lines: lines.length } });
      return t.id;
    });
    return this.get(auth, id);
  }

  /** Stock leaves the source warehouse. Quantities default to what was requested and can only be reduced. */
  async dispatch(auth: AuthContext, id: string, dto: DispatchDto) {
    const head = await this.load(this.db, id);
    if (!this.canSee(auth, head)) throw notFound();
    if (!auth.scopeFor('inventory.transfer').includes(head.from_branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Only the sending branch can dispatch this transfer.');
    await this.db.tx(async (q) => {
      const t = await this.load(q, id, true);
      if (t.status !== 'approved') throw AppError.conflict('TRANSFER_NOT_READY', t.status === 'pending_approval' ? 'The transfer has not been approved yet.' : `The transfer is already ${t.status.replace(/_/g, ' ')}.`);
      const items = await many<ItemRow>(q, `select * from inventory.stock_transfer_items where transfer_id = $1 order by id for update`, [id]);
      const override = new Map((dto.items ?? []).map((i) => [i.itemId, i.quantitySent]));
      for (const o of override.keys()) if (!items.some((i) => i.id === o)) throw AppError.badRequest('ITEM_NOT_IN_TRANSFER', 'A line does not belong to this transfer.');
      const entries: PostEntry[] = [];
      let total = '0.0000';
      for (const i of items) {
        const sent = override.has(i.id) ? this.parseQty(override.get(i.id)!) : format(parse(i.quantity_requested));
        if (cmp(sent, i.quantity_requested) > 0) throw AppError.badRequest('SENT_EXCEEDS_REQUESTED', 'You cannot send more than was requested.');
        if (cmp(sent, '0') < 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities cannot be negative.');
        await q.query(`update inventory.stock_transfer_items set quantity_sent = $2 where id = $1`, [i.id, sent]);
        total = format(parse(total) + parse(sent));
        if (cmp(sent, '0') > 0) {
          entries.push({ productId: i.product_id, batchId: i.batch_id, warehouseId: t.from_warehouse_id, locationId: i.from_location_id, status: 'available', quantityDelta: format(-parse(sent)), movementType: 'transfer_out', referenceNo: t.reference_no, sourceType: 'stock_transfer', sourceId: t.id, reason: 'Dispatched', createdBy: auth.userId });
        }
      }
      if (cmp(total, '0') === 0) throw AppError.badRequest('NOTHING_TO_SEND', 'At least one line must have a quantity to send.');
      await this.ledger.post(q, entries);
      await q.query(`update inventory.stock_transfers set status = 'dispatched', dispatched_by = $2, dispatched_at = now(), version = version + 1 where id = $1`, [id, auth.userId]);
      await this.audit.record({ action: 'transfer.dispatched', entityType: 'stock_transfer', entityId: id, branchId: t.from_branch_id, newValue: { lines: entries.length } }, q);
    });
    return this.get(auth, id);
  }

  private parseQty(v: string): string {
    try { return format(parse(v)); } catch { throw AppError.badRequest('INVALID_QUANTITY', 'A quantity is not a valid number.'); }
  }

  /** Stock enters the destination warehouse. Anything short is recorded as a discrepancy and needs a reason. */
  async receive(auth: AuthContext, id: string, dto: ReceiveDto) {
    const head = await this.load(this.db, id);
    if (!this.canSee(auth, head)) throw notFound();
    if (!auth.scopeFor('inventory.transfer').includes(head.to_branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Only the receiving branch can receive this transfer.');
    await this.db.tx(async (q) => {
      const t = await this.load(q, id, true);
      if (t.status !== 'dispatched') throw AppError.conflict('TRANSFER_NOT_IN_TRANSIT', t.status === 'approved' ? 'The transfer has not been dispatched yet.' : `The transfer is already ${t.status.replace(/_/g, ' ')}.`);
      const items = await many<ItemRow>(q, `select * from inventory.stock_transfer_items where transfer_id = $1 order by id for update`, [id]);
      const given = new Map((dto.items ?? []).map((i) => [i.itemId, i]));
      for (const g of given.keys()) if (!items.some((i) => i.id === g)) throw AppError.badRequest('ITEM_NOT_IN_TRANSFER', 'A line does not belong to this transfer.');
      const entries: PostEntry[] = [];
      let short = false;
      for (const i of items) {
        const g = given.get(i.id);
        const sent = format(parse(i.quantity_sent ?? '0'));
        const received = g ? this.parseQty(g.quantityReceived) : sent;
        if (cmp(received, '0') < 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities cannot be negative.');
        if (cmp(received, sent) > 0) throw AppError.badRequest('RECEIVED_EXCEEDS_SENT', 'You cannot receive more than was sent.');
        const missing = cmp(received, sent) < 0;
        if (missing && (!g?.discrepancyReason || g.discrepancyReason.trim().length < 3)) throw AppError.badRequest('DISCREPANCY_REASON_REQUIRED', 'Explain why less was received than was sent.', { itemId: i.id });
        short = short || missing;
        const status: StockStatus = g?.receivedStatus ?? 'available';
        await q.query(`update inventory.stock_transfer_items set quantity_received = $2, received_status = $3, discrepancy_reason = $4, to_location_id = coalesce($5::uuid, to_location_id) where id = $1`,
          [i.id, received, status, missing ? g!.discrepancyReason!.trim() : null, g?.toLocationId ?? null]);
        if (cmp(received, '0') > 0) {
          const toLoc = g?.toLocationId ?? i.to_location_id;
          entries.push({ productId: i.product_id, batchId: i.batch_id, warehouseId: t.to_warehouse_id, locationId: toLoc, status, quantityDelta: received, movementType: 'transfer_in', referenceNo: t.reference_no, sourceType: 'stock_transfer', sourceId: t.id, reason: missing ? `Received short: ${g!.discrepancyReason}` : 'Received', createdBy: auth.userId });
        }
      }
      await this.ledger.post(q, entries);
      await q.query(`update inventory.stock_transfers set status = $2, received_by = $3, received_at = now(), version = version + 1 where id = $1`, [id, short ? 'received_with_discrepancy' : 'received', auth.userId]);
      await this.audit.record({ action: short ? 'transfer.received_with_discrepancy' : 'transfer.received', entityType: 'stock_transfer', entityId: id, branchId: t.to_branch_id, newValue: { lines: items.length } }, q);
    });
    return this.get(auth, id);
  }

  /** Closes a transfer that arrived short, after someone other than the receiver has reviewed it. */
  async resolve(auth: AuthContext, id: string, note: string) {
    const head = await this.load(this.db, id);
    if (!this.canSee(auth, head)) throw notFound();
    const approve = auth.scopeFor('inventory.transfer_approve');
    if (!(approve.includes(head.from_branch_id) || approve.includes(head.to_branch_id))) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to resolve transfer discrepancies.');
    await this.db.tx(async (q) => {
      const t = await this.load(q, id, true);
      if (t.status !== 'received_with_discrepancy') throw AppError.conflict('NO_DISCREPANCY_TO_RESOLVE', 'Only a transfer received with a discrepancy can be resolved.');
      if (t.received_by === auth.userId) throw AppError.forbidden('CANNOT_RESOLVE_OWN_RECEIPT', 'The discrepancy must be reviewed by someone other than the person who received the goods.');
      await q.query(`update inventory.stock_transfers set status = 'closed', resolved_by = $2, resolved_at = now(), resolution_note = $3, version = version + 1 where id = $1`, [id, auth.userId, note]);
      await this.audit.record({ action: 'transfer.discrepancy_resolved', entityType: 'stock_transfer', entityId: id, branchId: t.from_branch_id, newValue: { note } }, q);
    });
    return this.get(auth, id);
  }

  /** Withdraws a transfer that has not left yet. */
  async cancel(auth: AuthContext, id: string) {
    const head = await this.load(this.db, id);
    if (!this.canSee(auth, head)) throw notFound();
    if (head.status === 'pending_approval') {
      const req = await maybeOne<{ id: string }>(this.db, `select id from platform.approval_requests where source_type = 'stock_transfer' and source_id = $1 and status = 'pending'`, [id]);
      if (!req) throw AppError.conflict('TRANSFER_NOT_CANCELLABLE', 'The transfer can no longer be cancelled.');
      await this.approvals.cancel(auth, req.id);
      return this.get(auth, id);
    }
    if (head.status !== 'approved') throw AppError.conflict('TRANSFER_NOT_CANCELLABLE', 'Only a transfer that has not been dispatched can be cancelled.');
    if (!(head.requested_by === auth.userId || auth.scopeFor('inventory.transfer_approve').includes(head.from_branch_id))) throw AppError.forbidden('PERMISSION_DENIED', 'You cannot cancel this transfer.');
    await this.db.tx(async (q) => {
      const t = await this.load(q, id, true);
      if (t.status !== 'approved') throw AppError.conflict('TRANSFER_NOT_CANCELLABLE', 'Only a transfer that has not been dispatched can be cancelled.');
      await q.query(`update inventory.stock_transfers set status = 'cancelled', version = version + 1 where id = $1`, [id]);
      await this.audit.record({ action: 'transfer.cancelled', entityType: 'stock_transfer', entityId: id, branchId: t.from_branch_id }, q);
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const t = await maybeOne<TransferRow>(this.db,
      `select t.*, ru.username as requested_by_name, (select r.id from platform.approval_requests r where r.source_type = 'stock_transfer' and r.source_id = t.id order by r.requested_at desc limit 1) as approval_id
         from inventory.stock_transfers t join iam.users ru on ru.id = t.requested_by where t.id = $1`, [id]);
    if (!t || !this.canSee(auth, t)) throw notFound();
    const items = await many(this.db,
      `select i.id, i.product_id, p.sku, p.name as product_name, i.batch_id, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, sb.unit_cost,
              i.from_location_id, i.to_location_id, i.quantity_requested, i.quantity_sent, i.quantity_received, i.received_status, i.discrepancy_reason,
              (coalesce(i.quantity_sent, 0) - coalesce(i.quantity_received, 0))::numeric(18,4) as quantity_missing
         from inventory.stock_transfer_items i join catalog.products p on p.id = i.product_id join inventory.stock_batches sb on sb.id = i.batch_id
        where i.transfer_id = $1 order by p.name, sb.expiry_date, i.id`, [id]);
    return { ...t, items };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const s = auth.scopeFor('inventory.read');
    const where = [`(${s.sql('t.from_branch_id', params)} or ${s.sql('t.to_branch_id', params)})`];
    if (q.status) { params.push(q.status); where.push(`t.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`(t.from_branch_id = $${params.length} or t.to_branch_id = $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_transfers t where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select t.id, t.reference_no, t.from_branch_id, t.to_branch_id, t.from_warehouse_id, t.to_warehouse_id, t.status, t.requested_at, t.dispatched_at, t.received_at from inventory.stock_transfers t where ${w} order by t.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
