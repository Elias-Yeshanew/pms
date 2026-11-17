import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, divide, format, mul, parse, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService, PostEntry } from '../inventory/ledger.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { OrdersService } from './orders.service';

const notFound = () => AppError.notFound('RECEIPT_NOT_FOUND', 'Goods receipt not found.');

export interface ReceiveItemInput { orderItemId: string; quantity: string; unitId?: string; batchRef: string; expiryDate: string; manufactureDate?: string; locationId?: string }
interface OrderItemRow { id: string; product_id: string; unit_id: string; base_quantity: string; received_base: string; line_net: string }

/**
 * Receiving puts delivered goods into quarantine, so nothing can be sold before it has been checked. Inspection then
 * releases what is acceptable and moves the rest to "damaged", ready to go back to the supplier or be disposed of.
 */
@Injectable()
export class ReceivingService {
  constructor(
    private readonly db: DatabaseService, private readonly orders: OrdersService, private readonly inventory: InventoryService, private readonly ledger: LedgerService,
    private readonly settings: SettingsService, private readonly sequences: SequenceService, private readonly audit: AuditService,
  ) {}

  async receive(auth: AuthContext, dto: { purchaseOrderId: string; deliveryNoteNo?: string; note?: string; items: ReceiveItemInput[] }) {
    const head = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from procurement.purchase_orders where id = $1`, [dto.purchaseOrderId]);
    if (!head || !auth.scopeFor('procurement.read').includes(head.branch_id)) throw AppError.notFound('ORDER_NOT_FOUND', 'Purchase order not found.');
    if (!auth.scopeFor('procurement.receive').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to receive goods for this branch.');
    const id = await this.db.tx(async (q) => {
      const po = await one<{ id: string; branch_id: string; warehouse_id: string; supplier_id: string; status: string }>(q, `select id, branch_id, warehouse_id, supplier_id, status from procurement.purchase_orders where id = $1 for update`, [dto.purchaseOrderId]);
      if (!['approved', 'partially_received'].includes(po.status)) throw AppError.conflict('ORDER_NOT_RECEIVABLE', `Goods cannot be received against an order that is ${po.status.replace(/_/g, ' ')}.`);
      const today = await this.settings.businessDate(new Date(), q);
      const tol = await this.settings.get('procurement.over_receipt_tolerance_percent', null, q);
      const running = new Map<string, string>();
      const prepared: Array<ReceiveItemInput & { oi: OrderItemRow; unitId: string; base: string; cost: string }> = [];
      for (const it of dto.items) {
        const oi = await maybeOne<OrderItemRow>(q, `select id, product_id, unit_id, base_quantity, received_base, line_net from procurement.purchase_order_items where id = $1 and order_id = $2 for update`, [it.orderItemId, po.id]);
        if (!oi) throw AppError.badRequest('ITEM_NOT_IN_ORDER', 'A line does not belong to this order.');
        const unitId = it.unitId ?? oi.unit_id;
        const base = await this.inventory.toBase(q, oi.product_id, unitId, it.quantity);
        if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
        if (it.expiryDate <= today) throw AppError.badRequest('EXPIRY_IN_PAST', 'The expiry date has already passed. Goods that arrive expired should be refused, not received.', { batchRef: it.batchRef });
        const already = running.get(oi.id) ?? format(parse(oi.received_base));
        const after = add(already, base);
        const allowed = mul(oi.base_quantity, divide(add('100', tol), '100'));
        if (cmp(after, allowed) > 0) throw AppError.conflict('OVER_RECEIPT', 'This delivery is more than was ordered.', { ordered: format(parse(oi.base_quantity)), alreadyReceived: already, attempted: base, allowed });
        running.set(oi.id, after);
        prepared.push({ ...it, oi, unitId, base, cost: divide(oi.line_net, oi.base_quantity) });
      }
      const reference = await this.sequences.next(q, 'goods_receipt', po.branch_id);
      const r = await one<{ id: string }>(q, `insert into procurement.goods_receipts (reference_no, branch_id, warehouse_id, purchase_order_id, supplier_id, delivery_note_no, note, received_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [reference, po.branch_id, po.warehouse_id, po.id, po.supplier_id, dto.deliveryNoteNo ?? null, dto.note ?? null, auth.userId]);
      const entries: PostEntry[] = [];
      for (const p of prepared) {
        const item = await one<{ id: string }>(q, `insert into procurement.goods_receipt_items (receipt_id, order_item_id, product_id, unit_id, batch_ref, expiry_date, manufacture_date, location_id, received_qty, received_base, unit_cost)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`, [r.id, p.oi.id, p.oi.product_id, p.unitId, p.batchRef.trim(), p.expiryDate, p.manufactureDate ?? null, p.locationId ?? null, format(parse(p.quantity)), p.base, p.cost]);
        const batch = await this.inventory.findOrCreateBatch(q, { productId: p.oi.product_id, batchRef: p.batchRef, expiryDate: p.expiryDate, manufactureDate: p.manufactureDate, unitCost: p.cost, supplierId: po.supplier_id, createdBy: auth.userId });
        await q.query(`update procurement.goods_receipt_items set batch_id = $2 where id = $1`, [item.id, batch.id]);
        await q.query(`update inventory.stock_batches set goods_receipt_item_id = $2 where id = $1 and goods_receipt_item_id is null`, [batch.id, item.id]);
        entries.push({ productId: p.oi.product_id, batchId: batch.id, warehouseId: po.warehouse_id, locationId: p.locationId ?? null, status: 'quarantined', quantityDelta: p.base, movementType: 'receipt', referenceNo: reference, sourceType: 'goods_receipt', sourceId: r.id, reason: 'Received from supplier, awaiting inspection', createdBy: auth.userId });
      }
      await this.ledger.post(q, entries);
      for (const [itemId, total] of running) await q.query(`update procurement.purchase_order_items set received_base = $2 where id = $1`, [itemId, total]);
      await this.orders.refreshStatus(q, po.id);
      await this.audit.record({ action: 'goods.received', entityType: 'goods_receipt', entityId: r.id, branchId: po.branch_id, newValue: { reference, orderId: po.id, lines: prepared.length } }, q);
      return r.id;
    });
    return this.get(auth, id);
  }

  async inspect(auth: AuthContext, id: string, dto: { items?: Array<{ itemId: string; acceptedQuantity: string; rejectionReason?: string }> }) {
    const head = await maybeOne<{ branch_id: string; received_by: string }>(this.db, `select branch_id, received_by from procurement.goods_receipts where id = $1`, [id]);
    if (!head || !auth.scopeFor('procurement.read').includes(head.branch_id)) throw notFound();
    if (!auth.scopeFor('procurement.inspect').includes(head.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to inspect goods for this branch.');
    if (head.received_by === auth.userId && (await this.settings.get('procurement.separate_inspector'))) throw AppError.forbidden('INSPECTOR_MUST_DIFFER', 'Goods must be inspected by someone other than the person who received them.');
    await this.db.tx(async (q) => {
      const r = await one<{ id: string; reference_no: string; branch_id: string; warehouse_id: string; supplier_id: string; status: string }>(q, `select * from procurement.goods_receipts where id = $1 for update`, [id]);
      if (r.status !== 'pending_inspection') throw AppError.conflict('ALREADY_INSPECTED', 'This delivery has already been inspected.');
      const items = await many<{ id: string; order_item_id: string; product_id: string; unit_id: string; batch_id: string; location_id: string | null; received_base: string; unit_cost: string }>(q, `select * from procurement.goods_receipt_items where receipt_id = $1 order by id for update`, [id]);
      const given = new Map((dto.items ?? []).map((i) => [i.itemId, i]));
      for (const g of given.keys()) if (!items.some((i) => i.id === g)) throw AppError.badRequest('ITEM_NOT_IN_RECEIPT', 'A line does not belong to this delivery.');
      const entries: PostEntry[] = [];
      for (const i of items) {
        const g = given.get(i.id);
        const accepted = g ? await this.inventory.toBase(q, i.product_id, i.unit_id, g.acceptedQuantity) : format(parse(i.received_base));
        if (cmp(accepted, '0') < 0 || cmp(accepted, i.received_base) > 0) throw AppError.badRequest('INVALID_ACCEPTED_QUANTITY', 'The accepted quantity must be between zero and what was received.', { itemId: i.id });
        const rejected = sub(format(parse(i.received_base)), accepted);
        if (cmp(rejected, '0') > 0 && (!g?.rejectionReason || g.rejectionReason.trim().length < 3)) throw AppError.badRequest('REJECTION_REASON_REQUIRED', 'Say why the goods were rejected.', { itemId: i.id });
        const common = { productId: i.product_id, batchId: i.batch_id, warehouseId: r.warehouse_id, locationId: i.location_id, referenceNo: r.reference_no, sourceType: 'goods_receipt', sourceId: r.id, createdBy: auth.userId };
        if (cmp(accepted, '0') > 0) entries.push({ ...common, status: 'quarantined', quantityDelta: format(-parse(accepted)), movementType: 'release', reason: 'Passed inspection' }, { ...common, status: 'available', quantityDelta: accepted, movementType: 'release', reason: 'Passed inspection' });
        if (cmp(rejected, '0') > 0) entries.push({ ...common, status: 'quarantined', quantityDelta: format(-parse(rejected)), movementType: 'damage', reason: `Rejected: ${g!.rejectionReason}` }, { ...common, status: 'damaged', quantityDelta: rejected, movementType: 'damage', reason: `Rejected: ${g!.rejectionReason}` });
        await q.query(`update procurement.goods_receipt_items set accepted_base = $2, rejected_base = $3, rejection_reason = $4 where id = $1`, [i.id, accepted, rejected, cmp(rejected, '0') > 0 ? g!.rejectionReason!.trim() : null]);
        await q.query(`update procurement.purchase_order_items set accepted_base = accepted_base + $2, rejected_base = rejected_base + $3 where id = $1`, [i.order_item_id, accepted, rejected]);
        if (cmp(accepted, '0') > 0) await q.query(`insert into catalog.product_suppliers (product_id, supplier_id, last_price) values ($1, $2, $3) on conflict (product_id, supplier_id) do update set last_price = excluded.last_price`, [i.product_id, r.supplier_id, i.unit_cost]);
      }
      await this.ledger.post(q, entries);
      await q.query(`update procurement.goods_receipts set status = 'completed', inspected_by = $2, inspected_at = now(), version = version + 1 where id = $1`, [id, auth.userId]);
      await this.audit.record({ action: 'goods.inspected', entityType: 'goods_receipt', entityId: id, branchId: r.branch_id, newValue: { lines: items.length } }, q);
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const r = await maybeOne<{ branch_id: string }>(this.db, `select g.*, po.reference_no as order_reference, s.name as supplier_name, ru.username as received_by_name, iu.username as inspected_by_name
        from procurement.goods_receipts g join procurement.purchase_orders po on po.id = g.purchase_order_id join procurement.suppliers s on s.id = g.supplier_id
        join iam.users ru on ru.id = g.received_by left join iam.users iu on iu.id = g.inspected_by where g.id = $1`, [id]);
    if (!r || !auth.scopeFor('procurement.read').includes(r.branch_id)) throw notFound();
    const items = await many(this.db, `select i.id, i.order_item_id, i.product_id, p.sku, p.name as product_name, i.unit_id, u.code as unit_code, i.batch_id, i.batch_ref, to_char(i.expiry_date, 'YYYY-MM-DD') as expiry_date,
        i.received_qty, i.received_base, i.accepted_base, i.rejected_base, i.rejection_reason, i.unit_cost from procurement.goods_receipt_items i
        join catalog.products p on p.id = i.product_id join catalog.units u on u.id = i.unit_id where i.receipt_id = $1 order by p.name, i.batch_ref`, [id]);
    return { ...r, items };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; purchaseOrderId?: string; supplierId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('procurement.read').sql('g.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.status) add2('g.status = ?', q.status);
    if (q.purchaseOrderId) add2('g.purchase_order_id = ?', q.purchaseOrderId);
    if (q.supplierId) add2('g.supplier_id = ?', q.supplierId);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.goods_receipts g where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select g.id, g.reference_no, g.branch_id, g.purchase_order_id, g.supplier_id, g.status, g.delivery_note_no, g.received_at, g.inspected_at from procurement.goods_receipts g where ${w} order by g.received_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
