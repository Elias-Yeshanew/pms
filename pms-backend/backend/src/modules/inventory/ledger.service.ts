import { JournalService } from '../finance/journal.service';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { many } from '../../database/database.service';
import { add, cmp, format, parse } from '../../domain/decimal';
import { SettingsService } from '../platform/settings.service';

export type StockStatus = 'available' | 'quarantined' | 'damaged' | 'expired';
export type MovementType = 'opening_balance' | 'receipt' | 'sale' | 'sale_return' | 'adjustment' | 'count_adjustment' | 'transfer_out' | 'transfer_in'
  | 'quarantine' | 'release' | 'damage' | 'expiry' | 'disposal' | 'purchase_return' | 'correction';

export interface PostEntry {
  productId: string;
  batchId: string;
  warehouseId: string;
  locationId: string | null;
  status: StockStatus;
  /** Signed quantity in BASE units, at most 4 decimal places. Positive adds stock, negative removes it. */
  quantityDelta: string;
  movementType: MovementType;
  referenceNo: string;
  sourceType: string;
  sourceId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
}

export interface MovementRow {
  id: string; reference_no: string; movement_type: MovementType; branch_id: string; warehouse_id: string; location_id: string | null;
  batch_id: string; product_id: string; status: StockStatus; quantity_delta: string; unit_cost: string; balance_after: string; source_type: string; source_id: string | null;
}

/**
 * The only code that changes a stock quantity. For every entry it locks the balance row, refuses to go below
 * zero (unless the administrator has explicitly allowed negative stock), updates the balance and writes an
 * immutable movement, all inside the caller's transaction. A database trigger rejects any other attempt to
 * change a balance, so there is no second way in.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly settings: SettingsService, private readonly journal: JournalService) {}

  async post(q: PoolClient, entries: PostEntry[]): Promise<MovementRow[]> {
    if (entries.length === 0) return [];
    await q.query(`select set_config('pms.ledger_post', 'on', true)`); // lasts until this transaction ends
    const allowNegative = await this.settings.get('inventory.allow_negative_stock', null, q);

    for (const e of entries) {
      if (cmp(format(parse(e.quantityDelta)), '0') === 0) throw AppError.badRequest('ZERO_QUANTITY', 'A stock movement cannot be zero.');
    }
    const warehouses = await many<{ id: string; branch_id: string }>(q, `select id, branch_id from org.warehouses where id = any($1::uuid[])`, [[...new Set(entries.map((e) => e.warehouseId))]]);
    const branchOf = new Map(warehouses.map((w) => [w.id, w.branch_id]));
    for (const e of entries) if (!branchOf.has(e.warehouseId)) throw AppError.badRequest('WAREHOUSE_NOT_FOUND', 'The warehouse does not exist.');

    const locationIds = [...new Set(entries.map((e) => e.locationId).filter((l): l is string => !!l))];
    if (locationIds.length) {
      const locs = await many<{ id: string; warehouse_id: string }>(q, `select id, warehouse_id from org.storage_locations where id = any($1::uuid[])`, [locationIds]);
      const whOf = new Map(locs.map((l) => [l.id, l.warehouse_id]));
      for (const e of entries) {
        if (e.locationId && whOf.get(e.locationId) !== e.warehouseId) throw AppError.badRequest('LOCATION_NOT_IN_WAREHOUSE', 'The storage location does not belong to the warehouse.');
      }
    }
    const batches = await many<{ id: string; unit_cost: string; product_id: string }>(q, `select id, unit_cost, product_id from inventory.stock_batches where id = any($1::uuid[])`, [[...new Set(entries.map((e) => e.batchId))]]);
    const batchOf = new Map(batches.map((b) => [b.id, b]));
    for (const e of entries) {
      const b = batchOf.get(e.batchId);
      if (!b) throw AppError.badRequest('BATCH_NOT_FOUND', 'The batch does not exist.');
      if (b.product_id !== e.productId) throw AppError.badRequest('BATCH_PRODUCT_MISMATCH', 'The batch belongs to a different product.');
    }

    // Always lock rows in the same order so two transactions cannot wait on each other forever.
    // Movements are stamped with the real clock (not the transaction start), so history order matches the order balances changed.
    const key = (e: PostEntry) => `${e.warehouseId}|${e.locationId ?? ''}|${e.batchId}|${e.status}`;
    const ordered = [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const out: MovementRow[] = [];

    for (const e of ordered) {
      const branchId = branchOf.get(e.warehouseId)!;
      await q.query(
        `insert into inventory.stock_balances (branch_id, warehouse_id, location_id, batch_id, product_id, status, quantity)
         values ($1, $2, $3, $4, $5, $6, 0) on conflict on constraint uq_stock_balance do nothing`,
        [branchId, e.warehouseId, e.locationId, e.batchId, e.productId, e.status],
      );
      const bal = (await q.query<{ id: string; quantity: string }>(
        `select id, quantity from inventory.stock_balances
          where warehouse_id = $1 and location_id is not distinct from $2 and batch_id = $3 and status = $4 for update`,
        [e.warehouseId, e.locationId, e.batchId, e.status],
      )).rows[0];
      const delta = format(parse(e.quantityDelta));
      const next = add(bal.quantity, delta);
      if (cmp(next, '0') < 0 && !allowNegative) {
        throw AppError.conflict('INSUFFICIENT_STOCK', 'There is not enough stock for this operation.', { batchId: e.batchId, status: e.status, available: bal.quantity, requested: format(-parse(delta)) });
      }
      await q.query(`update inventory.stock_balances set quantity = $2 where id = $1`, [bal.id, next]);
      const m = await q.query<MovementRow>(
        `insert into inventory.stock_movements (reference_no, movement_type, branch_id, warehouse_id, location_id, batch_id, product_id, status,
                quantity_delta, unit_cost, balance_after, source_type, source_id, reason, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, clock_timestamp()) returning *`,
        [e.referenceNo, e.movementType, branchId, e.warehouseId, e.locationId, e.batchId, e.productId, e.status, delta, batchOf.get(e.batchId)!.unit_cost, next, e.sourceType, e.sourceId ?? null, e.reason ?? null, e.createdBy ?? null],
      );
      out.push(m.rows[0]);
    }
    await this.journal.postStockMovements(q, out, entries[0]?.createdBy ?? null);
    return out;
  }
}
