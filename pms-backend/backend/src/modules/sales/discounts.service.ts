import { Injectable, OnModuleInit } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';

const notFound = () => AppError.notFound('DISCOUNT_REQUEST_NOT_FOUND', 'Discount request not found.');

/**
 * A discount above the normal limit is approved by someone else before the sale, not during it. The approval is good for one
 * sale, up to the approved percentage, for a short time (configurable).
 */
@Injectable()
export class DiscountsService implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly approvals: ApprovalsService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  onModuleInit() {
    this.approvals.registerHandler('sales.discount', {
      onApproved: async (q, r) => { await q.query(`update sales.discount_requests set status = 'approved', decided_by = $2, approved_at = clock_timestamp() where id = $1 and status = 'pending'`, [r.source_id, r.decided_by]); },
      onRejected: async (q, r) => { await q.query(`update sales.discount_requests set status = 'rejected', decided_by = $2 where id = $1 and status = 'pending'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update sales.discount_requests set status = 'cancelled' where id = $1 and status = 'pending'`, [r.source_id]); },
    });
  }

  async request(auth: AuthContext, dto: { branchId: string; registerId?: string; percent: string; reason: string }) {
    if (!auth.scopeFor('sales.discount_request').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot request discounts for this branch.');
    if (cmp(dto.percent, '0') <= 0 || cmp(dto.percent, '100') > 0) throw AppError.badRequest('INVALID_PERCENT', 'The discount must be between 0 and 100 percent.');
    const limit = await this.settings.get('sales.max_discount_percent', dto.branchId);
    if (cmp(dto.percent, limit) <= 0) throw AppError.badRequest('NO_APPROVAL_NEEDED', `Discounts up to ${limit}% need no approval.`);
    const id = await this.db.tx(async (q) => {
      if (dto.registerId && !(await maybeOne(q, `select 1 from org.cash_registers where id = $1 and branch_id = $2`, [dto.registerId, dto.branchId]))) throw AppError.badRequest('REGISTER_NOT_FOUND', 'The register does not belong to this branch.');
      const reference = await this.sequences.next(q, 'discount_request', dto.branchId);
      const r = await one<{ id: string }>(q, `insert into sales.discount_requests (reference_no, branch_id, register_id, percent, reason, requested_by) values ($1, $2, $3, $4, $5, $6) returning id`, [reference, dto.branchId, dto.registerId ?? null, format(parse(dto.percent)), dto.reason.trim(), auth.userId]);
      await this.approvals.request(q, auth, { actionCode: 'sales.discount', sourceType: 'discount_request', sourceId: r.id, branchId: dto.branchId, requiredPermission: 'sales.discount_approve', summary: { reference, percent: dto.percent, reason: dto.reason } });
      await this.audit.record({ action: 'discount.requested', entityType: 'discount_request', entityId: r.id, branchId: dto.branchId, newValue: { reference, ...dto } }, q);
      return r.id;
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const r = await maybeOne<{ branch_id: string; requested_by: string }>(this.db, `select d.*, (select a.id from platform.approval_requests a where a.source_type = 'discount_request' and a.source_id = d.id order by a.requested_at desc limit 1) as approval_id from sales.discount_requests d where d.id = $1`, [id]);
    if (!r || !(r.requested_by === auth.userId || auth.scopeFor('sales.read').includes(r.branch_id))) throw notFound();
    return r;
  }

  async cancel(auth: AuthContext, id: string) {
    const r = await this.get(auth, id) as unknown as { status: string; approval_id: string | null; requested_by: string };
    if (r.requested_by !== auth.userId) throw AppError.forbidden('ONLY_REQUESTER_CAN_CANCEL', 'Only the person who asked can cancel the request.');
    if (r.status !== 'pending' || !r.approval_id) throw AppError.conflict('DISCOUNT_NOT_CANCELLABLE', 'Only a pending request can be cancelled.');
    await this.approvals.cancel(auth, r.approval_id);
    return this.get(auth, id);
  }

  /** Spends an approved discount on a sale. Fails if it is not approved, was used, belongs to another branch, expired, or is too small. */
  async consume(q: PoolClient, id: string, branchId: string, usedPercent: string): Promise<void> {
    const d = await maybeOne<{ branch_id: string; status: string; percent: string; approved_at: Date | null }>(q, `select branch_id, status, percent, approved_at from sales.discount_requests where id = $1 for update`, [id]);
    if (!d || d.branch_id !== branchId) throw AppError.badRequest('DISCOUNT_REQUEST_NOT_FOUND', 'The discount approval does not exist for this branch.');
    if (d.status !== 'approved') throw AppError.conflict('DISCOUNT_NOT_APPROVED', d.status === 'used' ? 'This discount approval has already been used.' : `The discount request is ${d.status}.`);
    const minutes = await this.settings.get('sales.discount_approval_minutes', null, q);
    if (d.approved_at && Date.now() - d.approved_at.getTime() > minutes * 60000) throw AppError.conflict('DISCOUNT_APPROVAL_EXPIRED', 'This discount approval has expired. Ask for it again.');
    if (cmp(usedPercent, d.percent) > 0) throw AppError.conflict('DISCOUNT_EXCEEDS_APPROVAL', `The approval covers up to ${format(parse(d.percent))}%.`, { approved: format(parse(d.percent)), used: usedPercent });
  }

  async markUsed(q: PoolClient, id: string, saleId: string) {
    await q.query(`update sales.discount_requests set status = 'used', sale_id = $2 where id = $1`, [id, saleId]);
  }
}
