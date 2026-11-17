import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateSaleDto, SalesService } from '../sales/sales.service';
import { SettingsService } from '../platform/settings.service';

interface DeviceRow { id: string; branch_id: string; register_id: string | null; name: string; platform: string | null; status: string; last_seen_at: string | null; last_sync_at: string | null; created_at: string }

/** Each synced kind of data: how to read rows by id, and the page query used for the first full download. */
const ENTITIES: Record<string, { select: string; from: string; branch?: string }> = {
  product: { select: 'id, sku, name, generic_name, brand_name, strength, base_unit_id, requires_prescription, is_controlled, tax_category_id, is_active', from: 'catalog.products' },
  unit: { select: 'id, code, name, is_active', from: 'catalog.units' },
  product_unit: { select: 'id, product_id, unit_id, factor_to_base, is_sellable', from: 'catalog.product_units' },
  barcode: { select: 'id, product_id, unit_id, barcode, is_primary', from: 'catalog.product_barcodes' },
  price: { select: 'id, product_id, unit_id, price_type, amount, effective_from, effective_to', from: 'catalog.product_prices' },
  tax_category: { select: 'id, name, is_active', from: 'finance.tax_categories' },
  tax_rule: { select: 'id, tax_category_id, tax_code, name, rate, is_inclusive, rounding_rule, effective_from, effective_to', from: 'finance.tax_rules' },
  payment_method: { select: 'id, code, name, is_cash, is_credit, requires_reference, is_active, sort_order', from: 'sales.payment_methods' },
  customer: { select: 'id, code, name, phone, credit_limit, balance, status', from: 'sales.customers' },
  register: { select: 'id, branch_id, code, name, status, offline_mode', from: 'org.cash_registers', branch: 'branch_id' },
};
export const SYNC_ENTITIES = Object.keys(ENTITIES);
/** Failures that mean "the shop floor and the books disagree" rather than "the request was malformed". */
const MAX_BATCH = 50;

export interface OfflineSaleInput extends Omit<CreateSaleDto, 'deviceId'> { offlineRef: string; soldAt: string }

@Injectable()
export class SyncService {
  constructor(
    private readonly db: DatabaseService, private readonly sales: SalesService, private readonly audit: AuditService,
    private readonly notes: NotificationsService, private readonly settings: SettingsService,
  ) {}

  // =============== devices ===============
  async registerDevice(auth: AuthContext, d: { name: string; platform?: string; registerId?: string; branchId?: string }) {
    let branchId = d.branchId ?? null;
    if (d.registerId) {
      const r = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from org.cash_registers where id = $1`, [d.registerId]);
      if (!r) throw AppError.notFound('REGISTER_NOT_FOUND', 'Cash register not found.');
      if (branchId && branchId !== r.branch_id) throw AppError.badRequest('BRANCH_MISMATCH', 'The register belongs to a different branch.');
      branchId = r.branch_id;
    }
    if (!branchId) throw AppError.badRequest('BRANCH_REQUIRED', 'Give a register or a branch for this device.');
    if (!auth.scopeFor('sales.create').includes(branchId)) throw AppError.forbidden('PERMISSION_DENIED', 'You cannot register a device for this branch.');
    const dev = await one<DeviceRow>(this.db, `insert into sync.devices (branch_id, register_id, name, platform, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning *`, [branchId, d.registerId ?? null, d.name.trim(), d.platform ?? null, auth.userId]);
    await this.audit.record({ action: 'sync.device_registered', entityType: 'sync_device', entityId: dev.id, branchId, newValue: { name: dev.name } });
    return dev;
  }

  async listDevices(auth: AuthContext, q: PageQuery & { branchId?: string; status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = []; const where: string[] = [];
    where.push(auth.scopeFor('sync.manage').sql('d.branch_id', params));
    if (q.branchId) { params.push(q.branchId); where.push(`d.branch_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`d.status = $${params.length}`); }
    const w = where.join(' and ');
    const total = (await one<{ n: string }>(this.db, `select count(*) n from sync.devices d where ${w}`, params)).n;
    const items = await many(this.db, `select d.* from sync.devices d where ${w} order by d.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, page: q.page, pageSize: q.pageSize, total: Number(total) };
  }

  async revokeDevice(auth: AuthContext, id: string) {
    const d = await maybeOne<DeviceRow>(this.db, `select * from sync.devices where id = $1`, [id]);
    if (!d || !auth.scopeFor('sync.manage').includes(d.branch_id)) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    const r = await one(this.db, `update sync.devices set status = 'revoked', revoked_at = now(), revoked_by = $2, updated_at = now(), updated_by = $2 where id = $1 returning *`, [id, auth.userId]);
    await this.audit.record({ action: 'sync.device_revoked', entityType: 'sync_device', entityId: id, branchId: d.branch_id });
    return r;
  }

  /** The device a request is made from; it must be active and inside the caller's branches. */
  private async device(auth: AuthContext, id: string): Promise<DeviceRow> {
    const d = await maybeOne<DeviceRow>(this.db, `select * from sync.devices where id = $1`, [id]);
    if (!d || !auth.scopeFor('sales.create').includes(d.branch_id)) throw AppError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    if (d.status !== 'active') throw AppError.forbidden('DEVICE_REVOKED', 'This device has been revoked. Register it again.');
    await this.db.query(`update sync.devices set last_seen_at = now() where id = $1`, [id]);
    return d;
  }

  // =============== downloading reference data ===============
  async cursor(auth: AuthContext, deviceId: string) {
    const d = await this.device(auth, deviceId);
    const seq = (await one<{ s: string }>(this.db, `select coalesce(max(seq), 0)::text s from sync.change_log`)).s;
    return {
      cursor: Number(seq), serverTime: new Date().toISOString(), branchId: d.branch_id, registerId: d.register_id, entities: SYNC_ENTITIES,
      settings: {
        maxOfflineHours: await this.settings.get('offline.max_offline_hours', d.branch_id),
        currencyDecimals: await this.settings.get('business.currency_decimals', null),
      },
    };
  }

  /** First full download of one kind of data, in pages. Read the cursor first, then every entity, then ask for changes since that cursor. */
  async snapshot(auth: AuthContext, deviceId: string, entity: string, afterId: string | undefined, limit: number) {
    const d = await this.device(auth, deviceId);
    const e = ENTITIES[entity];
    if (!e) throw AppError.badRequest('UNKNOWN_ENTITY', `Unknown entity "${entity}".`, { entities: SYNC_ENTITIES });
    const params: unknown[] = [afterId ?? '00000000-0000-0000-0000-000000000000', limit + 1];
    let extra = '';
    if (e.branch) { params.push(d.branch_id); extra = ` and ${e.branch} = $3`; }
    const rows = await many<{ id: string }>(this.db, `select ${e.select} from ${e.from} where id > $1${extra} order by id limit $2`, params);
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    return { entity, items, hasMore: more, nextAfterId: more ? items[items.length - 1].id : null };
  }

  /** What is on the shelves for this branch, per product, in base units. A hint for the register; the server decides at sync time. */
  async stock(auth: AuthContext, deviceId: string) {
    const d = await this.device(auth, deviceId);
    const items = await many(this.db, `select b.product_id as "productId", sum(b.quantity - b.reserved_quantity)::text as available
        from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id
       where b.branch_id = $1 and b.status = 'available' and (sb.expiry_date is null or sb.expiry_date >= current_date)
       group by b.product_id having sum(b.quantity - b.reserved_quantity) > 0 order by b.product_id`, [d.branch_id]);
    return { asOf: new Date().toISOString(), items };
  }

  async changes(auth: AuthContext, deviceId: string, since: number, limit: number) {
    const d = await this.device(auth, deviceId);
    const latest = await many<{ entity: string; entity_id: string; seq: string }>(this.db,
      `select entity, entity_id, max(seq)::text seq from sync.change_log where seq > $1 group by entity, entity_id order by max(seq) limit $2`, [since, limit + 1]);
    const more = latest.length > limit;
    const page = more ? latest.slice(0, limit) : latest;
    const byEntity = new Map<string, string[]>();
    for (const r of page) { if (!byEntity.has(r.entity)) byEntity.set(r.entity, []); byEntity.get(r.entity)!.push(r.entity_id); }
    const data = new Map<string, unknown>();
    for (const [entity, ids] of byEntity) {
      const e = ENTITIES[entity]; if (!e) continue;
      const params: unknown[] = [ids]; let extra = '';
      if (e.branch) { params.push(d.branch_id); extra = ` and ${e.branch} = $2`; }
      for (const row of await many<{ id: string }>(this.db, `select ${e.select} from ${e.from} where id = any($1::uuid[])${extra}`, params)) data.set(`${entity}:${row.id}`, row);
    }
    const changes = page.map((r) => {
      const row = data.get(`${r.entity}:${r.entity_id}`);
      return { seq: Number(r.seq), entity: r.entity, id: r.entity_id, op: row ? 'upsert' : 'delete', data: row ?? null };
    });
    return { changes, cursor: page.length ? Number(page[page.length - 1].seq) : since, hasMore: more };
  }

  // =============== uploading offline sales ===============
  async uploadSales(auth: AuthContext, deviceId: string, sales: OfflineSaleInput[]) {
    if (sales.length > MAX_BATCH) throw AppError.badRequest('BATCH_TOO_LARGE', `Send at most ${MAX_BATCH} sales at a time.`);
    const dev = await this.device(auth, deviceId);
    const maxHours = Number(await this.settings.get('offline.max_offline_hours', dev.branch_id));
    const results = [];
    for (const s of sales) {
      const registerBranch = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from org.cash_registers where id = $1`, [s.registerId]);
      if (!registerBranch || registerBranch.branch_id !== dev.branch_id) {
        results.push(await this.reject(auth, dev, s, 'REGISTER_NOT_ON_DEVICE_BRANCH', 'The register does not belong to this device\'s branch.')); continue;
      }
      const ageHours = (Date.now() - new Date(s.soldAt).getTime()) / 3600000;
      if (ageHours > maxHours) { results.push(await this.reject(auth, dev, s, 'OFFLINE_WINDOW_EXCEEDED', `The sale is ${Math.floor(ageHours)} hours old; the limit is ${maxHours} hours.`, { maxHours })); continue; }
      try {
        const r = await this.sales.create(auth, { ...s, deviceId });
        const sale = r.sale as { id: string; referenceNo?: string; reference_no?: string };
        await this.db.query(`update sync.conflicts set status = 'resolved', sale_id = $3, resolved_at = now(), resolution_note = coalesce(resolution_note, 'Accepted on a later upload'), updated_at = now() where device_id = $1 and offline_ref = $2 and status = 'open'`, [deviceId, s.offlineRef, sale.id]);
        results.push({ offlineRef: s.offlineRef, status: r.replay ? 'duplicate' : 'synced', saleId: sale.id, referenceNo: sale.referenceNo ?? sale.reference_no ?? null });
      } catch (e) {
        if (e instanceof AppError && e.getStatus() < 500) results.push(await this.reject(auth, dev, s, e.code, e.message, e.details));
        else throw e;
      }
    }
    await this.db.query(`update sync.devices set last_sync_at = now(), last_seen_at = now() where id = $1`, [deviceId]);
    return { results, summary: { synced: results.filter((r) => r.status === 'synced').length, duplicate: results.filter((r) => r.status === 'duplicate').length, conflict: results.filter((r) => r.status === 'conflict').length } };
  }

  private async reject(auth: AuthContext, dev: DeviceRow, s: OfflineSaleInput, code: string, message: string, details?: unknown) {
    const c = await one<{ id: string; created: boolean }>(this.db,
      `insert into sync.conflicts (device_id, branch_id, offline_ref, payload, error_code, error_message, error_details, cashier_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (device_id, offline_ref) do update set error_code = excluded.error_code, error_message = excluded.error_message, error_details = excluded.error_details,
         payload = excluded.payload, attempts = sync.conflicts.attempts + 1, updated_at = now(),
         status = case when sync.conflicts.status = 'resolved' then 'resolved' else 'open' end
       returning id, (xmax = 0) as created`,
      [dev.id, dev.branch_id, s.offlineRef, JSON.stringify(s), code, message, details ? JSON.stringify(details) : null, auth.userId]);
    await this.notes.raise(this.db, { type: 'sync_conflict', severity: 'warning', branchId: dev.branch_id, permission: 'sync.resolve', title: 'An offline sale needs attention', body: `${dev.name}: sale ${s.offlineRef} was not accepted (${code}).`, data: { conflictId: c.id, offlineRef: s.offlineRef, code }, entityType: 'sync_conflict', entityId: c.id, dedupeKey: `sync_conflict:${c.id}` });
    return { offlineRef: s.offlineRef, status: 'conflict', conflictId: c.id, code, message, details: details ?? null };
  }

  // =============== conflicts ===============
  async listConflicts(auth: AuthContext, q: PageQuery & { status?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = []; const where = [auth.scopeFor('sync.resolve').sql('c.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`c.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const total = (await one<{ n: string }>(this.db, `select count(*) n from sync.conflicts c where ${w}`, params)).n;
    const items = await many(this.db, `select c.*, d.name as device_name from sync.conflicts c join sync.devices d on d.id = c.device_id where ${w} order by c.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, page: q.page, pageSize: q.pageSize, total: Number(total) };
  }

  /** The cashier's own parked sales, so the register can show what still needs attention. */
  async myConflicts(auth: AuthContext, q: PageQuery & { status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [auth.userId]; const where = ['c.cashier_id = $1'];
    if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
    const w = where.join(' and ');
    const total = (await one<{ n: string }>(this.db, `select count(*) n from sync.conflicts c where ${w}`, params)).n;
    const items = await many(this.db, `select c.id, c.device_id, c.offline_ref, c.error_code, c.error_message, c.status, c.attempts, c.sale_id, c.created_at from sync.conflicts c where ${w} order by c.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, page: q.page, pageSize: q.pageSize, total: Number(total) };
  }

  private async conflict(auth: AuthContext, id: string, permission: string) {
    const c = await maybeOne<{ id: string; branch_id: string; device_id: string; status: string; payload: OfflineSaleInput; cashier_id: string }>(this.db, `select * from sync.conflicts where id = $1`, [id]);
    if (!c || !auth.scopeFor(permission).includes(c.branch_id)) throw AppError.notFound('CONFLICT_NOT_FOUND', 'Conflict not found.');
    if (c.status !== 'open') throw AppError.conflict('CONFLICT_CLOSED', 'This conflict is already closed.');
    return c;
  }

  /** Try the sale again once the cause (usually missing stock) has been fixed. The sale stays the original cashier's, so only they can submit it. */
  async retryConflict(auth: AuthContext, id: string) {
    const c = await this.conflict(auth, id, 'sales.create');
    if (c.cashier_id !== auth.userId) throw new AppError(403, 'RETRY_BY_CASHIER', 'Ask the cashier to retry; the sale must be submitted under their name.', { cashierId: c.cashier_id });
    const out = await this.uploadSalesAs(auth, c.device_id, c.payload);
    return out;
  }

  private async uploadSalesAs(auth: AuthContext, deviceId: string, s: OfflineSaleInput) {
    const r = await this.uploadSales(auth, deviceId, [s]);
    return r.results[0];
  }

  async dismissConflict(auth: AuthContext, id: string, note: string) {
    const c = await this.conflict(auth, id, 'sync.resolve');
    const r = await one(this.db, `update sync.conflicts set status = 'dismissed', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now() where id = $1 returning *`, [id, note, auth.userId]);
    await this.notes.resolve(this.db, `sync_conflict:${id}`);
    await this.audit.record({ action: 'sync.conflict_dismissed', entityType: 'sync_conflict', entityId: id, branchId: c.branch_id, newValue: { note, offlineRef: c.payload.offlineRef } });
    return r;
  }
}
