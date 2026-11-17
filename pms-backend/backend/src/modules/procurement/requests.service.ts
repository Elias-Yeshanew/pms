import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { cmp, mul, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { LinesService } from './lines.service';

const notFound = () => AppError.notFound('REQUEST_NOT_FOUND', 'Purchase request not found.');

@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly lines: LinesService, private readonly inventory: InventoryService, private readonly approvals: ApprovalsService,
    private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('procurement.request', {
      onApproved: async (q, r) => { await q.query(`update procurement.purchase_requests set status = 'approved', decided_by = $2, decided_at = now(), version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onRejected: async (q, r) => { await q.query(`update procurement.purchase_requests set status = 'rejected', decided_by = $2, decided_at = now(), version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update procurement.purchase_requests set status = 'cancelled', version = version + 1 where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  async create(auth: AuthContext, dto: { warehouseId: string; neededBy?: string; note?: string; items: Array<{ productId: string; unitId?: string; quantity: string; note?: string }> }) {
    const branchId = await this.inventory.scopedWarehouseBranch(auth, 'procurement.request', dto.warehouseId);
    const needsApproval = await this.settings.get('procurement.pr_approval_required');
    if (!needsApproval && !auth.can('procurement.request_approve', branchId)) throw AppError.forbidden('PERMISSION_DENIED', 'Requests are approved automatically, so you need the request-approval permission.');
    const id = await this.db.tx(async (q) => {
      const lines = await this.lines.resolve(q, dto.items);
      const reference = await this.sequences.next(q, 'purchase_request', branchId);
      const r = await one<{ id: string }>(q, `insert into procurement.purchase_requests (reference_no, branch_id, warehouse_id, status, needed_by, note, requested_by, decided_by, decided_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [reference, branchId, dto.warehouseId, needsApproval ? 'pending_approval' : 'approved', dto.neededBy ?? null, dto.note ?? null, auth.userId, needsApproval ? null : auth.userId, needsApproval ? null : new Date()]);
      for (const [i, l] of lines.entries()) await q.query(`insert into procurement.purchase_request_items (request_id, product_id, unit_id, quantity, base_quantity, note) values ($1, $2, $3, $4, $5, $6)`, [r.id, l.productId, l.unitId, l.quantity, l.baseQuantity, dto.items[i].note ?? null]);
      await this.audit.record({ action: 'purchase_request.created', entityType: 'purchase_request', entityId: r.id, branchId, newValue: { reference, ...dto } }, q);
      if (needsApproval) await this.approvals.request(q, auth, { actionCode: 'procurement.request', sourceType: 'purchase_request', sourceId: r.id, branchId, requiredPermission: 'procurement.request_approve', summary: { reference, lines: lines.length } });
      return r.id;
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const r = await maybeOne<{ branch_id: string }>(this.db, `select r.*, ru.username as requested_by_name, (select a.id from platform.approval_requests a where a.source_type = 'purchase_request' and a.source_id = r.id order by a.requested_at desc limit 1) as approval_id
        from procurement.purchase_requests r join iam.users ru on ru.id = r.requested_by where r.id = $1`, [id]);
    if (!r || !auth.scopeFor('procurement.read').includes(r.branch_id)) throw notFound();
    const items = await many(this.db, `select i.id, i.product_id, p.sku, p.name as product_name, i.unit_id, u.code as unit_code, i.quantity, i.base_quantity, i.note from procurement.purchase_request_items i
        join catalog.products p on p.id = i.product_id join catalog.units u on u.id = i.unit_id where i.request_id = $1 order by p.name`, [id]);
    return { ...r, items };
  }

  async list(auth: AuthContext, q: PageQuery & { status?: string; branchId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('procurement.read').sql('r.branch_id', params)];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`r.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.purchase_requests r where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select r.id, r.reference_no, r.branch_id, r.warehouse_id, r.status, r.needed_by, r.requested_at, (select count(*)::int from procurement.purchase_request_items i where i.request_id = r.id) as lines
      from procurement.purchase_requests r where ${w} order by r.requested_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async cancel(auth: AuthContext, id: string) {
    const r = await this.get(auth, id) as unknown as { status: string; requested_by: string; approval_id: string | null };
    if (r.status === 'pending_approval' && r.approval_id) { await this.approvals.cancel(auth, r.approval_id); return this.get(auth, id); }
    if (r.status !== 'approved') throw AppError.conflict('REQUEST_NOT_CANCELLABLE', 'Only a pending or approved request can be cancelled.');
    if (r.requested_by !== auth.userId) throw AppError.forbidden('ONLY_REQUESTER_CAN_CANCEL', 'Only the person who made the request can cancel it.');
    await this.db.tx(async (q) => {
      await q.query(`update procurement.purchase_requests set status = 'cancelled', version = version + 1 where id = $1 and status = 'approved'`, [id]);
      await this.audit.record({ action: 'purchase_request.cancelled', entityType: 'purchase_request', entityId: id }, q);
    });
    return this.get(auth, id);
  }

  /** Products at or below their reorder level, with a suggested quantity and the supplier that delivered them last. */
  async reorderSuggestions(auth: AuthContext, branchId?: string) {
    const low = await this.inventory.lowStock(auth, branchId) as Array<{ branch_id: string; branch_code: string; product_id: string; sku: string; name: string; reorder_level: string; max_stock: string | null; available: string }>;
    const out = [];
    for (const r of low) {
      const target = r.max_stock ?? mul(r.reorder_level, '2');
      const suggested = sub(target, r.available);
      if (cmp(suggested, '0') <= 0) continue;
      const last = await maybeOne<{ supplier_id: string; supplier_name: string; unit_cost: string }>(this.db,
        `select s.id as supplier_id, s.name as supplier_name, gi.unit_cost from procurement.goods_receipt_items gi join procurement.goods_receipts g on g.id = gi.receipt_id join procurement.suppliers s on s.id = g.supplier_id
          where gi.product_id = $1 and s.status = 'active' order by g.received_at desc limit 1`, [r.product_id]);
      out.push({ ...r, suggested_base_quantity: suggested, last_supplier_id: last?.supplier_id ?? null, last_supplier_name: last?.supplier_name ?? null, last_unit_cost: last?.unit_cost ?? null });
    }
    return out;
  }
}
