import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, parse } from '../../domain/decimal';
import { percentDiscount } from '../../domain/pricing';
import { AuditService } from '../audit/audit.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { ProductsService } from './products.service';

const MAX_ITEMS = 2000;
const notFound = () => AppError.notFound('PRICE_BATCH_NOT_FOUND', 'Price update not found.');

export interface BulkPreviewDto {
  priceType: 'purchase' | 'selling' | 'wholesale'; mode: 'set' | 'percent' | 'amount'; value: string; reason: string;
  productIds?: string[]; categoryId?: string; manufacturerId?: string; unitId?: string;
}

/**
 * Change many prices at once. The numbers are worked out and stored at preview time; applying uses exactly those
 * numbers, and is refused if any price has changed since the preview, so nobody's later change is overwritten.
 */
@Injectable()
export class BulkPricesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly products: ProductsService, private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('catalog.bulk_price', {
      onApproved: (q, r, auth) => this.apply(q, r.source_id, auth),
      onRejected: async (q, r) => { await q.query(`update catalog.price_update_batches set status = 'rejected', decided_by = $2, decided_at = now() where id = $1 and status = 'pending'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update catalog.price_update_batches set status = 'cancelled' where id = $1 and status = 'pending'`, [r.source_id]); },
    });
  }

  async preview(auth: AuthContext, dto: BulkPreviewDto) {
    if (!dto.productIds?.length && !dto.categoryId && !dto.manufacturerId) throw AppError.badRequest('SELECTION_REQUIRED', 'Choose products, a category or a manufacturer to update.');
    if (dto.mode === 'set' && dto.value.startsWith('-')) throw AppError.badRequest('INVALID_VALUE', 'A price cannot be negative.');
    const dp = await this.settings.get('business.currency_decimals');
    const params: unknown[] = [dto.priceType, dto.unitId ?? null];
    const where: string[] = ['p.is_active'];
    if (dto.productIds?.length) { params.push(dto.productIds); where.push(`p.id = any($${params.length}::uuid[])`); }
    if (dto.manufacturerId) { params.push(dto.manufacturerId); where.push(`p.manufacturer_id = $${params.length}`); }
    const tree = dto.categoryId ? (params.push(dto.categoryId), `with recursive tree as (select id from catalog.categories where id = $${params.length} union all select c.id from catalog.categories c join tree t on c.parent_id = t.id)`) : '';
    if (dto.categoryId) where.push('p.category_id in (select id from tree)');
    const rows = await many<{ product_id: string; sku: string; name: string; unit_id: string; unit_code: string; old_amount: string | null; purchase_amount: string | null }>(this.db,
      `${tree} select p.id as product_id, p.sku, p.name, pu.unit_id, u.code as unit_code, cur.amount as old_amount, pur.amount as purchase_amount
         from catalog.products p
         join catalog.product_units pu on pu.product_id = p.id and pu.unit_id = coalesce($2::uuid, p.base_unit_id)
         join catalog.units u on u.id = pu.unit_id
         left join catalog.product_prices cur on cur.product_id = p.id and cur.unit_id = pu.unit_id and cur.price_type = $1 and cur.effective_to is null
         left join catalog.product_prices pur on pur.product_id = p.id and pur.unit_id = pu.unit_id and pur.price_type = 'purchase' and pur.effective_to is null
        where ${where.join(' and ')} order by p.name, p.sku`, params);

    const items: Array<{ productId: string; unitId: string; sku: string; name: string; unitCode: string; oldAmount: string | null; newAmount: string; warning: string | null }> = [];
    const skipped: Array<{ sku: string; name: string; reason: string }> = [];
    for (const r of rows) {
      let next: string;
      if (dto.mode === 'set') next = format(parse(dto.value));
      else if (r.old_amount === null) { skipped.push({ sku: r.sku, name: r.name, reason: 'No current price to adjust' }); continue; }
      else if (dto.mode === 'percent') next = add(r.old_amount, percentDiscount(r.old_amount, dto.value, 'half_up', dp));
      else next = add(r.old_amount, dto.value);
      if (cmp(next, '0') < 0) { skipped.push({ sku: r.sku, name: r.name, reason: 'The new price would be negative' }); continue; }
      if (r.old_amount !== null && cmp(next, r.old_amount) === 0) { skipped.push({ sku: r.sku, name: r.name, reason: 'The price would not change' }); continue; }
      const warning = dto.priceType === 'selling' && r.purchase_amount !== null && cmp(next, r.purchase_amount) < 0 ? 'Below the purchase price' : null;
      items.push({ productId: r.product_id, unitId: r.unit_id, sku: r.sku, name: r.name, unitCode: r.unit_code, oldAmount: r.old_amount, newAmount: next, warning });
    }
    if (items.length === 0) throw AppError.badRequest('NOTHING_TO_UPDATE', 'No prices would change.', { skipped });
    if (items.length > MAX_ITEMS) throw AppError.badRequest('TOO_MANY_ITEMS', `One update can change at most ${MAX_ITEMS} prices. Narrow the selection.`);

    const id = await this.db.tx(async (q) => {
      const reference = await this.sequences.next(q, 'price_update');
      const b = await one<{ id: string }>(q, `insert into catalog.price_update_batches (reference_no, price_type, mode, value, reason, item_count, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [reference, dto.priceType, dto.mode, dto.value, dto.reason.trim(), items.length, auth.userId]);
      for (const i of items) await q.query(`insert into catalog.price_update_items (batch_id, product_id, unit_id, old_amount, new_amount, warning) values ($1, $2, $3, $4, $5, $6)`, [b.id, i.productId, i.unitId, i.oldAmount, i.newAmount, i.warning]);
      await this.audit.record({ action: 'price.bulk_previewed', entityType: 'price_update', entityId: b.id, newValue: { reference, ...dto, items: items.length } }, q);
      return b.id;
    });
    return { ...(await this.get(auth, id)), skipped };
  }

  async get(auth: AuthContext, id: string) {
    const b = await maybeOne<{ id: string }>(this.db, `select b.*, cu.username as created_by_name, (select r.id from platform.approval_requests r where r.source_type = 'price_update' and r.source_id = b.id order by r.requested_at desc limit 1) as approval_id
        from catalog.price_update_batches b join iam.users cu on cu.id = b.created_by where b.id = $1`, [id]);
    if (!b) throw notFound();
    const items = await many(this.db, `select i.product_id, p.sku, p.name, u.code as unit_code, i.unit_id, i.old_amount, i.new_amount, i.warning from catalog.price_update_items i
        join catalog.products p on p.id = i.product_id join catalog.units u on u.id = i.unit_id where i.batch_id = $1 order by p.name, p.sku`, [id]);
    return { ...b, items };
  }

  async list(q: PageQuery & { status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
    const total = Number((await this.db.query(`select count(*) from catalog.price_update_batches b where ${where.join(' and ')}`, params)).rows[0].count);
    const items = await many(this.db, `select b.id, b.reference_no, b.price_type, b.mode, b.value, b.reason, b.status, b.item_count, b.created_at, b.applied_at from catalog.price_update_batches b
      where ${where.join(' and ')} order by b.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async submit(auth: AuthContext, id: string) {
    const needsApproval = await this.settings.get('catalog.bulk_price_approval_required');
    if (!needsApproval && !auth.can('prices.approve')) throw AppError.forbidden('PERMISSION_DENIED', 'Price updates are applied immediately, so you need the price-approval permission.');
    await this.db.tx(async (q) => {
      const b = await maybeOne<{ status: string; created_by: string; reference_no: string; item_count: number }>(q, `select * from catalog.price_update_batches where id = $1 for update`, [id]);
      if (!b || b.created_by !== auth.userId) throw notFound();
      if (b.status !== 'draft') throw AppError.conflict('PRICE_BATCH_NOT_DRAFT', 'This update has already been submitted.');
      await q.query(`update catalog.price_update_batches set status = 'pending' where id = $1`, [id]);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'catalog.bulk_price', sourceType: 'price_update', sourceId: id, branchId: null, requiredPermission: 'prices.approve', summary: { reference: b.reference_no, items: b.item_count } });
      else await this.apply(q, id, auth);
    });
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string) {
    const b = await maybeOne<{ status: string; created_by: string }>(this.db, `select status, created_by from catalog.price_update_batches where id = $1`, [id]);
    if (!b || b.created_by !== auth.userId) throw notFound();
    if (b.status === 'draft') {
      await this.db.query(`update catalog.price_update_batches set status = 'cancelled' where id = $1 and status = 'draft'`, [id]);
    } else if (b.status === 'pending') {
      const req = await maybeOne<{ id: string }>(this.db, `select id from platform.approval_requests where source_type = 'price_update' and source_id = $1 and status = 'pending'`, [id]);
      if (req) await this.approvals.cancel(auth, req.id);
    } else throw AppError.conflict('PRICE_BATCH_NOT_CANCELLABLE', 'An update that has been decided cannot be cancelled.');
    return this.get(auth, id);
  }

  /** Applies the stored prices in one transaction. Fails as a whole if any price moved since the preview. */
  private async apply(q: PoolClient, id: string, auth: AuthContext) {
    const b = await maybeOne<{ status: string; reference_no: string; price_type: string; reason: string }>(q, `select * from catalog.price_update_batches where id = $1 for update`, [id]);
    if (!b || b.status !== 'pending') throw AppError.conflict('PRICE_BATCH_NOT_PENDING', 'This update is not waiting to be applied.');
    const items = await many<{ product_id: string; unit_id: string; old_amount: string | null; new_amount: string }>(q, `select product_id, unit_id, old_amount, new_amount from catalog.price_update_items where batch_id = $1 order by id`, [id]);
    const stale: Array<{ productId: string; expected: string | null; actual: string | null }> = [];
    for (const i of items) {
      const cur = await maybeOne<{ amount: string }>(q, `select amount from catalog.product_prices where product_id = $1 and unit_id = $2 and price_type = $3 and effective_to is null`, [i.product_id, i.unit_id, b.price_type]);
      const actual = cur?.amount ?? null;
      if ((actual === null) !== (i.old_amount === null) || (actual !== null && i.old_amount !== null && cmp(actual, i.old_amount) !== 0)) stale.push({ productId: i.product_id, expected: i.old_amount, actual });
    }
    if (stale.length) throw AppError.conflict('STALE_PREVIEW', `${stale.length} price(s) changed since this update was previewed. Preview it again.`, { count: stale.length, sample: stale.slice(0, 10) });
    for (const i of items) await this.products.applyPrice(q, auth, i.product_id, i.unit_id, b.price_type, i.new_amount, `${b.reason} (${b.reference_no})`);
    await q.query(`update catalog.price_update_batches set status = 'applied', applied_at = now(), decided_by = $2, decided_at = now() where id = $1`, [id, auth.userId]);
    await this.audit.record({ action: 'price.bulk_applied', entityType: 'price_update', entityId: id, newValue: { reference: b.reference_no, items: items.length } }, q);
  }
}
