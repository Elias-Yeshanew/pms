import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { InventoryService } from './inventory.service';
import { LedgerService, PostEntry } from './ledger.service';

const notFound = () => AppError.notFound('COUNT_NOT_FOUND', 'Stock count not found.');

interface CountRow { id: string; reference_no: string; branch_id: string; warehouse_id: string; location_id: string | null; status: string; created_by: string; submitted_by: string | null }
interface CountItemRow { id: string; product_id: string; batch_id: string; location_id: string | null; system_quantity: string; counted_quantity: string | null }

/**
 * Physical stock counts. The count freezes a snapshot of what the system expects; people enter what they
 * actually found. The correction applied to stock is the difference between the counted and the snapshot
 * quantity, so sales that happened while counting are not undone. Variances need a second person's approval.
 */
@Injectable()
export class CountsService implements OnModuleInit {
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
    this.approvals.registerHandler('inventory.count', {
      onApproved: (q, r, auth) => this.post(q, r.source_id, auth),
      // A rejected count goes back to the counters with the reviewer's comment, keeping what was already entered
      onRejected: async (q, r) => { await q.query(`update inventory.stock_counts set status = 'counting', review_comment = $2, version = version + 1 where id = $1 and status = 'submitted'`, [r.source_id, r.comment]); },
      onCancelled: async (q, r) => { await q.query(`update inventory.stock_counts set status = 'counting', version = version + 1 where id = $1 and status = 'submitted'`, [r.source_id]); },
    });
  }

  private async load(q: PoolClient | DatabaseService, id: string, lock = false): Promise<CountRow> {
    const c = await maybeOne<CountRow>(q, `select * from inventory.stock_counts where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!c) throw notFound();
    return c;
  }

  private assertScope(auth: AuthContext, permission: string, c: CountRow) {
    if (!auth.scopeFor(permission).includes(c.branch_id)) throw auth.scopeFor('inventory.read').includes(c.branch_id) ? AppError.forbidden('PERMISSION_DENIED', 'You do not have permission for this action.') : notFound();
  }

  async create(auth: AuthContext, dto: { warehouseId: string; locationId?: string; note?: string }) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'inventory.count', dto.warehouseId);
    const id = await this.db.tx(async (q) => {
      if (dto.locationId && !(await maybeOne(q, `select 1 from org.storage_locations where id = $1 and warehouse_id = $2`, [dto.locationId, dto.warehouseId]))) throw AppError.badRequest('LOCATION_NOT_IN_WAREHOUSE', 'The storage location does not belong to the warehouse.');
      const open = await maybeOne(q, `select reference_no from inventory.stock_counts where warehouse_id = $1 and status in ('counting', 'submitted')`, [dto.warehouseId]);
      if (open) throw AppError.conflict('COUNT_ALREADY_OPEN', 'This warehouse already has a count in progress.', open);
      const reference = await this.sequences.next(q, 'stock_count', branchId);
      const c = await one<{ id: string }>(q, `insert into inventory.stock_counts (reference_no, branch_id, warehouse_id, location_id, note, created_by) values ($1, $2, $3, $4, $5, $6) returning id`, [reference, branchId, dto.warehouseId, dto.locationId ?? null, dto.note ?? null, auth.userId]);
      // Snapshot of what the system expects to find right now
      await q.query(
        `insert into inventory.stock_count_items (count_id, product_id, batch_id, location_id, system_quantity)
         select $1, product_id, batch_id, location_id, quantity from inventory.stock_balances
          where warehouse_id = $2 and status = 'available' and quantity <> 0 and ($3::uuid is null or location_id = $3)`, [c.id, dto.warehouseId, dto.locationId ?? null]);
      await this.audit.record({ action: 'count.started', entityType: 'stock_count', entityId: c.id, branchId, newValue: { reference, ...dto } }, q);
      return c.id;
    });
    return this.get(auth, id);
  }

  async enterCounts(auth: AuthContext, id: string, entries: Array<{ itemId: string; countedQuantity: string; unitId?: string }>) {
    const head = await this.load(this.db, id);
    this.assertScope(auth, 'inventory.count', head);
    await this.db.tx(async (q) => {
      const c = await this.load(q, id, true);
      if (c.status !== 'counting') throw AppError.conflict('COUNT_NOT_OPEN', 'Counts can only be entered while the count is in progress.');
      for (const e of entries) {
        const item = await maybeOne<CountItemRow>(q, `select * from inventory.stock_count_items where id = $1 and count_id = $2`, [e.itemId, id]);
        if (!item) throw AppError.badRequest('ITEM_NOT_IN_COUNT', 'A line does not belong to this count.');
        const base = await this.inventory.toBase(q, item.product_id, e.unitId, e.countedQuantity);
        if (cmp(base, '0') < 0) throw AppError.badRequest('INVALID_QUANTITY', 'A counted quantity cannot be negative.');
        await q.query(`update inventory.stock_count_items set counted_quantity = $2 where id = $1`, [e.itemId, base]);
      }
    });
    return this.get(auth, id);
  }

  async submit(auth: AuthContext, id: string) {
    const head = await this.load(this.db, id);
    this.assertScope(auth, 'inventory.count', head);
    const needsApproval = await this.settings.get('inventory.count_approval_required');
    if (!needsApproval && !auth.can('inventory.count_approve', head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Count results are applied immediately, so you need the count-approval permission.');
    await this.db.tx(async (q) => {
      const c = await this.load(q, id, true);
      if (c.status !== 'counting') throw AppError.conflict('COUNT_NOT_OPEN', 'This count has already been submitted.');
      const items = await many<CountItemRow>(q, `select * from inventory.stock_count_items where count_id = $1 for update`, [id]);
      const uncounted = items.filter((i) => i.counted_quantity === null);
      if (uncounted.length) throw AppError.badRequest('COUNT_INCOMPLETE', `${uncounted.length} line(s) have not been counted yet.`, { itemIds: uncounted.map((u) => u.id) });
      let anyVariance = false;
      for (const i of items) {
        const variance = sub(format(parse(i.counted_quantity!)), format(parse(i.system_quantity)));
        if (cmp(variance, '0') !== 0) anyVariance = true;
        await q.query(`update inventory.stock_count_items set variance = $2 where id = $1`, [i.id, variance]);
      }
      await q.query(`update inventory.stock_counts set submitted_by = $2, submitted_at = now(), review_comment = null, status = 'submitted', version = version + 1 where id = $1`, [id, auth.userId]);
      await this.audit.record({ action: 'count.submitted', entityType: 'stock_count', entityId: id, branchId: c.branch_id, newValue: { lines: items.length, anyVariance } }, q);
      if (!anyVariance) await this.post(q, id, auth);        // nothing to correct
      else if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'inventory.count', sourceType: 'stock_count', sourceId: id, branchId: c.branch_id, requiredPermission: 'inventory.count_approve', summary: { reference: c.reference_no, lines: items.length } });
      else await this.post(q, id, auth);
    });
    return this.get(auth, id);
  }

  /** Applies the variances through the ledger. Fails cleanly if stock has since dropped below what the count assumed. */
  private async post(q: PoolClient, id: string, auth: AuthContext) {
    const c = await this.load(q, id, true);
    if (c.status !== 'submitted') throw AppError.conflict('COUNT_NOT_SUBMITTED', 'This count is not waiting to be applied.');
    const items = await many<CountItemRow & { variance: string }>(q, `select * from inventory.stock_count_items where count_id = $1 and variance <> 0 order by id`, [id]);
    const entries: PostEntry[] = items.map((i) => ({
      productId: i.product_id, batchId: i.batch_id, warehouseId: c.warehouse_id, locationId: i.location_id, status: 'available', quantityDelta: i.variance,
      movementType: 'count_adjustment', referenceNo: c.reference_no, sourceType: 'stock_count', sourceId: c.id, reason: 'Physical count variance', createdBy: c.submitted_by ?? auth.userId,
    }));
    await this.ledger.post(q, entries);
    await q.query(`update inventory.stock_counts set status = 'posted', posted_at = now(), decided_by = $2, version = version + 1 where id = $1`, [id, auth.userId]);
    await this.audit.record({ action: 'count.posted', entityType: 'stock_count', entityId: id, branchId: c.branch_id, newValue: { corrected: entries.length } }, q);
  }

  async cancel(auth: AuthContext, id: string) {
    const head = await this.load(this.db, id);
    this.assertScope(auth, 'inventory.count', head);
    await this.db.tx(async (q) => {
      const c = await this.load(q, id, true);
      if (c.status !== 'counting') throw AppError.conflict('COUNT_NOT_OPEN', 'Only a count in progress can be cancelled.');
      await q.query(`update inventory.stock_counts set status = 'cancelled', version = version + 1 where id = $1`, [id]);
      await this.audit.record({ action: 'count.cancelled', entityType: 'stock_count', entityId: id, branchId: c.branch_id }, q);
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const c = await maybeOne<CountRow>(this.db,
      `select c.*, cu.username as created_by_name, (select r.id from platform.approval_requests r where r.source_type = 'stock_count' and r.source_id = c.id order by r.requested_at desc limit 1) as approval_id
         from inventory.stock_counts c join iam.users cu on cu.id = c.created_by where c.id = $1`, [id]);
    if (!c || !auth.scopeFor('inventory.read').includes(c.branch_id)) throw notFound();
    const items = await many(this.db,
      `select i.id, i.product_id, p.sku, p.name as product_name, i.batch_id, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, i.location_id,
              i.system_quantity, i.counted_quantity, i.variance, round(i.variance * sb.unit_cost, 4) as variance_value
         from inventory.stock_count_items i join catalog.products p on p.id = i.product_id join inventory.stock_batches sb on sb.id = i.batch_id
        where i.count_id = $1 order by p.name, sb.expiry_date, i.id`, [id]);
    const net = items.reduce((acc, i: any) => (i.variance_value === null ? acc : format(parse(acc) + parse(String(i.variance_value)))), '0.0000');
    return { ...c, items, net_variance_value: net };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('c.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`c.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_counts c where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select c.id, c.reference_no, c.branch_id, c.warehouse_id, c.status, c.created_at, c.submitted_at, c.posted_at from inventory.stock_counts c where ${w} order by c.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
