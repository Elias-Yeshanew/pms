import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { add, cmp, DecimalError, format, parse, sub } from '../../domain/decimal';
import { toBaseQuantity } from '../../domain/units';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { LedgerService, MovementType, PostEntry, StockStatus } from './ledger.service';

export interface BatchInput { productId: string; batchRef: string; expiryDate: string; manufactureDate?: string | null; unitCost: string; supplierId?: string | null; createdBy?: string | null }
export interface Allocation { balanceId: string; warehouseId: string; locationId: string | null; batchId: string; batchRef: string; expiryDate: string; unitCost: string; quantity: string }
export interface FefoInput { productId: string; branchId: string; baseQuantity: string; warehouseId?: string | null; asOf?: string }
export interface IssueInput extends FefoInput { movementType: MovementType; referenceNo: string; sourceType: string; sourceId?: string | null; reason?: string | null; createdBy?: string | null }

const TRANSITIONS: Record<string, { permission: string; type: MovementType }> = {
  'available>quarantined': { permission: 'inventory.adjust', type: 'quarantine' },
  'available>damaged': { permission: 'inventory.adjust', type: 'damage' },
  'quarantined>damaged': { permission: 'inventory.adjust', type: 'damage' },
  'quarantined>available': { permission: 'inventory.release_quarantine', type: 'release' },
};

export const handleDecimal = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) {
    if (e instanceof DecimalError) throw new AppError(e.code === 'NOT_EXACT' ? 422 : 400, e.code, e.message);
    throw e;
  }
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
  ) {}

  // ---------- shared helpers (also used by adjustments, disposals, transfers, counts) ----------
  /** Converts a quantity in any of the product's packs to base units, exactly. */
  async toBase(q: Queryable, productId: string, unitId: string | undefined | null, quantity: string): Promise<string> {
    if (!unitId) return handleDecimal(() => format(parse(quantity)));
    const u = await maybeOne<{ factor_to_base: string }>(q, `select factor_to_base from catalog.product_units where product_id = $1 and unit_id = $2`, [productId, unitId]);
    if (!u) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this unit.');
    return handleDecimal(() => toBaseQuantity(quantity, u.factor_to_base));
  }

  async warehouseBranch(q: Queryable, warehouseId: string): Promise<string> {
    const w = await maybeOne<{ branch_id: string }>(q, `select branch_id from org.warehouses where id = $1`, [warehouseId]);
    if (!w) throw AppError.notFound('WAREHOUSE_NOT_FOUND', 'Warehouse not found.');
    return w.branch_id;
  }

  /** Scope check that reports out-of-scope branches as "not found" so their existence is not revealed. */
  async scopedWarehouseBranch(auth: AuthContext, permission: string, warehouseId: string, q: Queryable = this.db): Promise<string> {
    const branchId = await this.warehouseBranch(q, warehouseId);
    if (!auth.scopeFor(permission).includes(branchId)) throw AppError.notFound('WAREHOUSE_NOT_FOUND', 'Warehouse not found.');
    return branchId;
  }

  /** Throws INSUFFICIENT_STOCK unless the given balance holds at least `needed` base units. */
  async assertAvailable(q: Queryable, warehouseId: string, locationId: string | null, batchId: string, status: StockStatus, needed: string) {
    const row = await maybeOne<{ quantity: string }>(q, `select quantity from inventory.stock_balances where warehouse_id = $1 and location_id is not distinct from $2::uuid and batch_id = $3 and status = $4`, [warehouseId, locationId, batchId, status]);
    const have = row?.quantity ?? '0';
    if (cmp(have, needed) < 0) throw AppError.conflict('INSUFFICIENT_STOCK', 'There is not enough stock for this operation.', { batchId, status, available: format(parse(have)), requested: needed });
  }

  async findOrCreateBatch(q: PoolClient, b: BatchInput): Promise<{ id: string; expiry_date: string; unit_cost: string }> {
    const product = await maybeOne<{ is_active: boolean }>(q, `select is_active from catalog.products where id = $1`, [b.productId]);
    if (!product) throw AppError.badRequest('PRODUCT_NOT_FOUND', 'The product does not exist.');
    if (!product.is_active) throw AppError.badRequest('PRODUCT_INACTIVE', 'The product is inactive.');
    const existing = await many<{ id: string; unit_cost: string; expiry: string }>(
      q, `select id, unit_cost, to_char(expiry_date, 'YYYY-MM-DD') as expiry from inventory.stock_batches where product_id = $1 and batch_ref = $2 and supplier_id is not distinct from $3::uuid`,
      [b.productId, b.batchRef, b.supplierId ?? null]);
    if (existing.some((e) => e.expiry !== b.expiryDate)) {
      throw AppError.conflict('BATCH_EXPIRY_MISMATCH', 'This batch already exists with a different expiry date.', { batchRef: b.batchRef, existingExpiry: existing[0].expiry });
    }
    const same = existing.find((e) => cmp(e.unit_cost, b.unitCost) === 0);
    if (same) return { id: same.id, expiry_date: same.expiry, unit_cost: same.unit_cost };
    const row = await one<{ id: string; unit_cost: string }>(
      q, `insert into inventory.stock_batches (product_id, batch_ref, expiry_date, manufacture_date, unit_cost, supplier_id, created_by)
          values ($1, $2, $3, $4, $5, $6, $7) returning id, unit_cost`,
      [b.productId, b.batchRef.trim(), b.expiryDate, b.manufactureDate ?? null, b.unitCost, b.supplierId ?? null, b.createdBy ?? null]);
    return { id: row.id, expiry_date: b.expiryDate, unit_cost: row.unit_cost };
  }

  // ---------- FEFO ----------
  /**
   * Picks stock for a sale, earliest expiry first. Only saleable stock is considered: status "available" and
   * not past its expiry date. With lock=true the rows are locked in expiry order, so two simultaneous sales
   * cannot both take the last units.
   */
  async fefoAllocate(q: Queryable, input: FefoInput, lock = true): Promise<Allocation[]> {
    const asOf = input.asOf ?? (await this.settings.businessDate(new Date(), q));
    const rows = await many<{ id: string; warehouse_id: string; location_id: string | null; batch_id: string; free: string; batch_ref: string; expiry: string; unit_cost: string }>(
      q,
      `select b.id, b.warehouse_id, b.location_id, b.batch_id, (b.quantity - b.reserved_quantity) as free, sb.batch_ref,
              to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry, sb.unit_cost
         from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id
        where b.product_id = $1 and b.branch_id = $2 and b.status = 'available' and (b.quantity - b.reserved_quantity) > 0
          and sb.expiry_date >= $3 and ($4::uuid is null or b.warehouse_id = $4)
        order by sb.expiry_date, sb.created_at, b.batch_id, b.warehouse_id, b.location_id nulls first
        ${lock ? 'for update of b' : ''}`,
      [input.productId, input.branchId, asOf, input.warehouseId ?? null],
    );
    let remaining = handleDecimal(() => format(parse(input.baseQuantity)));
    if (cmp(remaining, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'The quantity must be greater than zero.');
    const out: Allocation[] = [];
    let available = '0.0000';
    for (const r of rows) available = add(available, r.free);
    for (const r of rows) {
      if (cmp(remaining, '0') === 0) break;
      const take = cmp(r.free, remaining) < 0 ? r.free : remaining;
      out.push({ balanceId: r.id, warehouseId: r.warehouse_id, locationId: r.location_id, batchId: r.batch_id, batchRef: r.batch_ref, expiryDate: r.expiry, unitCost: r.unit_cost, quantity: format(parse(take)) });
      remaining = sub(remaining, take);
    }
    if (cmp(remaining, '0') > 0) {
      throw AppError.conflict('INSUFFICIENT_STOCK', 'There is not enough saleable stock.', { requested: format(parse(input.baseQuantity)), available });
    }
    return out;
  }

  /** Allocates by FEFO and removes the stock through the ledger. Used by sales; returns the batches with their real cost. */
  async issueFefo(q: PoolClient, input: IssueInput): Promise<Allocation[]> {
    const allocations = await this.fefoAllocate(q, input, true);
    await this.ledger.post(q, allocations.map((a): PostEntry => ({
      productId: input.productId, batchId: a.batchId, warehouseId: a.warehouseId, locationId: a.locationId, status: 'available',
      quantityDelta: format(-parse(a.quantity)), movementType: input.movementType, referenceNo: input.referenceNo,
      sourceType: input.sourceType, sourceId: input.sourceId, reason: input.reason, createdBy: input.createdBy,
    })));
    return allocations;
  }

  async fefoPreview(auth: AuthContext, dto: { productId: string; branchId: string; quantity: string; unitId?: string }) {
    if (!auth.scopeFor('inventory.read').includes(dto.branchId)) throw AppError.notFound('BRANCH_NOT_FOUND', 'Branch not found.');
    const base = await this.toBase(this.db, dto.productId, dto.unitId, dto.quantity);
    const allocations = await this.fefoAllocate(this.db, { productId: dto.productId, branchId: dto.branchId, baseQuantity: base }, false);
    return { baseQuantity: base, allocations };
  }

  // ---------- expiry ----------
  /** Moves saleable stock that has passed its expiry date into the "expired" status. Safe to run repeatedly. */
  async expirySweep(auth: AuthContext, branchId?: string) {
    const scope = auth.scopeFor('inventory.adjust');
    if (branchId && !scope.includes(branchId)) throw AppError.notFound('BRANCH_NOT_FOUND', 'Branch not found.');
    const today = await this.settings.businessDate();
    return this.db.tx(async (q) => {
      const params: unknown[] = [today];
      const where = [scope.sql('b.branch_id', params)];
      if (branchId) { params.push(branchId); where.push(`b.branch_id = $${params.length}`); }
      const rows = await many<{ product_id: string; batch_id: string; warehouse_id: string; location_id: string | null; quantity: string }>(
        q, `select b.product_id, b.batch_id, b.warehouse_id, b.location_id, b.quantity from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id
             where b.status = 'available' and b.quantity > 0 and sb.expiry_date < $1 and ${where.join(' and ')} for update of b`, params);
      if (!rows.length) return { moved: 0, reference: null as string | null };
      const reference = await this.sequences.next(q, 'stock_status');
      const entries: PostEntry[] = rows.flatMap((r) => [
        { productId: r.product_id, batchId: r.batch_id, warehouseId: r.warehouse_id, locationId: r.location_id, status: 'available' as StockStatus, quantityDelta: format(-parse(r.quantity)), movementType: 'expiry' as MovementType, referenceNo: reference, sourceType: 'expiry_sweep', reason: 'Past expiry date', createdBy: auth.userId },
        { productId: r.product_id, batchId: r.batch_id, warehouseId: r.warehouse_id, locationId: r.location_id, status: 'expired' as StockStatus, quantityDelta: format(parse(r.quantity)), movementType: 'expiry' as MovementType, referenceNo: reference, sourceType: 'expiry_sweep', reason: 'Past expiry date', createdBy: auth.userId },
      ]);
      await this.ledger.post(q, entries);
      await this.audit.record({ action: 'stock.expiry_sweep', entityType: 'stock_status_change', entityId: reference, newValue: { rows: rows.length } }, q);
      return { moved: rows.length, reference };
    });
  }

  // ---------- quarantine, release, damage ----------
  async changeStatus(auth: AuthContext, dto: { warehouseId: string; locationId?: string; batchId: string; quantity: string; unitId?: string; from: StockStatus; to: StockStatus; reason: string }) {
    const rule = TRANSITIONS[`${dto.from}>${dto.to}`];
    if (!rule) throw AppError.badRequest('INVALID_TRANSITION', `Stock cannot be moved from ${dto.from} to ${dto.to}.`);
    const branchId = await this.warehouseBranch(this.db, dto.warehouseId);
    if (!auth.scopeFor(rule.permission).includes(branchId)) {
      throw auth.scopeFor('inventory.read').includes(branchId) ? AppError.forbidden('PERMISSION_DENIED', 'You do not have permission for this action.') : AppError.notFound('WAREHOUSE_NOT_FOUND', 'Warehouse not found.');
    }
    return this.db.tx(async (q) => {
      const batch = await maybeOne<{ product_id: string; expired: boolean }>(q, `select product_id, expiry_date < $2::date as expired from inventory.stock_batches where id = $1`, [dto.batchId, await this.settings.businessDate(new Date(), q)]);
      if (!batch) throw AppError.badRequest('BATCH_NOT_FOUND', 'The batch does not exist.');
      if (dto.to === 'available' && batch.expired) throw AppError.conflict('BATCH_EXPIRED', 'An expired batch cannot be returned to saleable stock.');
      const base = await this.toBase(q, batch.product_id, dto.unitId, dto.quantity);
      if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'The quantity must be greater than zero.');
      const reference = await this.sequences.next(q, 'stock_status', branchId);
      const common = { productId: batch.product_id, batchId: dto.batchId, warehouseId: dto.warehouseId, locationId: dto.locationId ?? null, movementType: rule.type, referenceNo: reference, sourceType: 'stock_status_change', reason: dto.reason, createdBy: auth.userId };
      const moves = await this.ledger.post(q, [{ ...common, status: dto.from, quantityDelta: format(-parse(base)) }, { ...common, status: dto.to, quantityDelta: base }]);
      await this.audit.record({ action: `stock.${rule.type}`, entityType: 'stock_status_change', entityId: reference, branchId, newValue: { ...dto, baseQuantity: base } }, q);
      return { reference, movements: moves };
    });
  }

  // ---------- reading ----------
  async listBatches(auth: AuthContext, productId: string) {
    const scope = auth.scopeFor('inventory.read');
    const params: unknown[] = [productId];
    return many(this.db,
      `select sb.id, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, sb.unit_cost, sb.supplier_id,
              coalesce(sum(b.quantity) filter (where b.status = 'available'), 0)::numeric(18,4) as available,
              coalesce(sum(b.quantity), 0)::numeric(18,4) as on_hand
         from inventory.stock_batches sb left join inventory.stock_balances b on b.batch_id = sb.id and ${scope.sql('b.branch_id', params)}
        where sb.product_id = $1 group by sb.id order by sb.expiry_date, sb.created_at`, params);
  }

  async listStock(auth: AuthContext, q: PageQuery & { branchId?: string; warehouseId?: string; productId?: string; batchId?: string; status?: string; includeZero?: boolean }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('b.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.branchId) add2('b.branch_id = ?', q.branchId);
    if (q.warehouseId) add2('b.warehouse_id = ?', q.warehouseId);
    if (q.productId) add2('b.product_id = ?', q.productId);
    if (q.batchId) add2('b.batch_id = ?', q.batchId);
    if (q.status) add2('b.status = ?', q.status);
    if (!q.includeZero) where.push('b.quantity <> 0');
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_balances b where ${w}`, params)).rows[0].count);
    const items = await many(this.db,
      `select b.id, b.branch_id, b.warehouse_id, b.location_id, b.batch_id, b.product_id, b.status, b.quantity, b.reserved_quantity,
              p.sku, p.name as product_name, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, sb.unit_cost
         from inventory.stock_balances b join catalog.products p on p.id = b.product_id join inventory.stock_batches sb on sb.id = b.batch_id
        where ${w} order by p.name, sb.expiry_date, b.status limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async summary(auth: AuthContext, branchId?: string) {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('b.branch_id', params)];
    if (branchId) { params.push(branchId); where.push(`b.branch_id = $${params.length}`); }
    return many(this.db,
      `select b.branch_id, p.id as product_id, p.sku, p.name, p.reorder_level,
              coalesce(sum(b.quantity) filter (where b.status = 'available'), 0)::numeric(18,4) as available,
              coalesce(sum(b.quantity) filter (where b.status = 'quarantined'), 0)::numeric(18,4) as quarantined,
              coalesce(sum(b.quantity) filter (where b.status = 'damaged'), 0)::numeric(18,4) as damaged,
              coalesce(sum(b.quantity) filter (where b.status = 'expired'), 0)::numeric(18,4) as expired,
              to_char(min(sb.expiry_date) filter (where b.status = 'available' and b.quantity > 0), 'YYYY-MM-DD') as nearest_expiry
         from inventory.stock_balances b join catalog.products p on p.id = b.product_id join inventory.stock_batches sb on sb.id = b.batch_id
        where ${where.join(' and ')} group by b.branch_id, p.id order by p.name`, params);
  }

  /** Active products at or below their reorder level in a branch, including products that have no stock at all. */
  async lowStock(auth: AuthContext, branchId?: string) {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('br.id', params), `br.status = 'active'`];
    if (branchId) { params.push(branchId); where.push(`br.id = $${params.length}`); }
    return many(this.db,
      `select br.id as branch_id, br.code as branch_code, p.id as product_id, p.sku, p.name, p.reorder_level, p.min_stock, p.max_stock, s.available
         from org.branches br cross join catalog.products p
         cross join lateral (select coalesce(sum(b.quantity), 0)::numeric(18,4) as available from inventory.stock_balances b
                              where b.branch_id = br.id and b.product_id = p.id and b.status = 'available') s
        where ${where.join(' and ')} and p.is_active and p.reorder_level is not null and s.available <= p.reorder_level
        order by br.code, p.name`, params);
  }

  /** Saleable stock expiring within N days (default: the longest warning period), with the matching warning bucket. */
  async expiring(auth: AuthContext, q: { withinDays?: number; branchId?: string }) {
    const warn = [...(await this.settings.get('inventory.expiry_warning_days'))].sort((a, b) => a - b);
    const days = q.withinDays ?? warn[warn.length - 1];
    const today = await this.settings.businessDate();
    const params: unknown[] = [today, days];
    const where = [auth.scopeFor('inventory.read').sql('b.branch_id', params)];
    if (q.branchId) { params.push(q.branchId); where.push(`b.branch_id = $${params.length}`); }
    const rows = await many<{ days_left: number }>(this.db,
      `select b.branch_id, b.warehouse_id, b.product_id, p.sku, p.name as product_name, b.batch_id, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date,
              b.quantity, (sb.expiry_date - $1::date) as days_left
         from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id join catalog.products p on p.id = b.product_id
        where b.status = 'available' and b.quantity > 0 and sb.expiry_date <= $1::date + $2::int and ${where.join(' and ')}
        order by sb.expiry_date, p.name`, params);
    return rows.map((r) => ({ ...r, bucket: r.days_left < 0 ? 'expired' : (warn.find((w) => r.days_left <= w) ?? null) }));
  }

  async valuation(auth: AuthContext, branchId?: string) {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('b.branch_id', params), 'b.quantity <> 0'];
    if (branchId) { params.push(branchId); where.push(`b.branch_id = $${params.length}`); }
    const rows = await many<{ branch_id: string; warehouse_id: string; status: string; quantity: string; value: string }>(this.db,
      `select b.branch_id, b.warehouse_id, b.status, sum(b.quantity) as quantity, round(sum(b.quantity * sb.unit_cost), 4) as value
         from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id
        where ${where.join(' and ')} group by b.branch_id, b.warehouse_id, b.status order by b.branch_id, b.warehouse_id, b.status`, params);
    const total = rows.reduce((acc, r) => add(acc, format(parse(r.value))), '0.0000');
    // Stock that has left one warehouse but not yet arrived at the next still belongs to the business
    const tparams: unknown[] = [];
    const tw = [`(${auth.scopeFor('inventory.read').sql('t.from_branch_id', tparams)} or ${auth.scopeFor('inventory.read').sql('t.to_branch_id', tparams)})`];
    if (branchId) { tparams.push(branchId); tw.push(`(t.from_branch_id = $${tparams.length} or t.to_branch_id = $${tparams.length})`); }
    const transit = await one<{ value: string }>(this.db,
      `select coalesce(round(sum(i.quantity_sent * sb.unit_cost), 4), 0)::numeric(18,4) as value
         from inventory.stock_transfers t join inventory.stock_transfer_items i on i.transfer_id = t.id join inventory.stock_batches sb on sb.id = i.batch_id
        where t.status = 'dispatched' and ${tw.join(' and ')}`, tparams);
    return { rows, total, inTransit: transit.value };
  }

  async movements(auth: AuthContext, q: PageQuery & { productId?: string; batchId?: string; branchId?: string; movementType?: string; referenceNo?: string; from?: string; to?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('inventory.read').sql('m.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.productId) add2('m.product_id = ?', q.productId);
    if (q.batchId) add2('m.batch_id = ?', q.batchId);
    if (q.branchId) add2('m.branch_id = ?', q.branchId);
    if (q.movementType) add2('m.movement_type = ?', q.movementType);
    if (q.referenceNo) add2('m.reference_no = ?', q.referenceNo);
    if (q.from) add2('m.created_at >= ?', q.from);
    if (q.to) add2('m.created_at <= ?', q.to);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from inventory.stock_movements m where ${w}`, params)).rows[0].count);
    const items = await many(this.db,
      `select m.id, m.reference_no, m.movement_type, m.branch_id, m.warehouse_id, m.location_id, m.batch_id, m.product_id, m.status, m.quantity_delta, m.unit_cost,
              m.balance_after, m.source_type, m.source_id, m.reason, m.created_at, u.username as created_by
         from inventory.stock_movements m left join iam.users u on u.id = m.created_by where ${w}
        order by m.created_at ${q.order === 'asc' ? 'asc' : 'desc'}, m.id limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Compares every balance with the sum of its movements. An empty list means the books agree with the ledger. */
  async reconcile(auth: AuthContext) {
    const params: unknown[] = [];
    const scope = auth.scopeFor('inventory.adjust_approve').sql('x.branch_id', params);
    return many(this.db,
      `select * from (
         select coalesce(b.branch_id, m.branch_id) as branch_id, coalesce(b.warehouse_id, m.warehouse_id) as warehouse_id,
                coalesce(b.location_id, m.location_id) as location_id, coalesce(b.batch_id, m.batch_id) as batch_id,
                coalesce(b.status, m.status) as status, coalesce(b.quantity, 0) as balance, coalesce(m.total, 0) as movements_total
           from inventory.stock_balances b
           full join (select branch_id, warehouse_id, location_id, batch_id, status, sum(quantity_delta) as total from inventory.stock_movements
                       group by branch_id, warehouse_id, location_id, batch_id, status) m
             on m.warehouse_id = b.warehouse_id and m.location_id is not distinct from b.location_id and m.batch_id = b.batch_id and m.status = b.status
       ) x where x.balance <> x.movements_total and ${scope}`, params);
  }
}
