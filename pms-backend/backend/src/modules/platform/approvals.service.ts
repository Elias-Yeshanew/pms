import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

export interface ApprovalRequestRow {
  id: string; action_code: string; source_type: string; source_id: string; branch_id: string | null;
  required_permission: string; summary: Record<string, unknown>; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_by: string; requested_at: Date; decided_by: string | null; decided_at: Date | null; comment: string | null;
}

/** What the owning module does when a request is decided. It runs inside the same transaction as the decision. */
export interface ApprovalHandler {
  onApproved(q: PoolClient, request: ApprovalRequestRow, auth: AuthContext): Promise<void>;
  onRejected?(q: PoolClient, request: ApprovalRequestRow, auth: AuthContext): Promise<void>;
  onCancelled?(q: PoolClient, request: ApprovalRequestRow, auth: AuthContext): Promise<void>;
}

const notFound = () => AppError.notFound('APPROVAL_NOT_FOUND', 'Approval request not found.');

/**
 * Four-eyes approvals. Modules create a request; someone else who holds the required permission for that
 * branch approves or rejects it. If the module's handler fails (for example, stock is no longer there),
 * the whole decision is rolled back and the request stays pending.
 */
@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  registerHandler(actionCode: string, handler: ApprovalHandler) { this.handlers.set(actionCode, handler); }

  async request(q: PoolClient, auth: AuthContext, input: { actionCode: string; sourceType: string; sourceId: string; branchId: string | null; requiredPermission: string; summary?: object }): Promise<string> {
    const r = await one<{ id: string }>(q,
      `insert into platform.approval_requests (action_code, source_type, source_id, branch_id, required_permission, summary, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.actionCode, input.sourceType, input.sourceId, input.branchId, input.requiredPermission, JSON.stringify(input.summary ?? {}), auth.userId]);
    await this.audit.record({ action: 'approval.requested', entityType: 'approval', entityId: r.id, branchId: input.branchId, newValue: input }, q);
    return r.id;
  }

  private canDecide(auth: AuthContext, r: Pick<ApprovalRequestRow, 'required_permission' | 'branch_id' | 'requested_by'>): boolean {
    return r.requested_by !== auth.userId && auth.scopeFor(r.required_permission).includes(r.branch_id);
  }

  async list(auth: AuthContext, status: 'pending' | 'all' = 'pending') {
    const rows = await many<ApprovalRequestRow & { requested_by_name: string; decided_by_name: string | null }>(
      this.db,
      `select a.*, ru.username as requested_by_name, du.username as decided_by_name
         from platform.approval_requests a join iam.users ru on ru.id = a.requested_by left join iam.users du on du.id = a.decided_by
        where ($1 = 'all' or a.status = 'pending') order by a.requested_at desc limit 500`, [status]);
    // Only people involved can see a request: the requester, or someone entitled to decide it
    return rows
      .map((r) => ({ ...r, can_decide: r.status === 'pending' && this.canDecide(auth, r), is_mine: r.requested_by === auth.userId }))
      .filter((r) => r.is_mine || auth.scopeFor(r.required_permission).includes(r.branch_id));
  }

  async get(auth: AuthContext, id: string) {
    const r = (await this.list(auth, 'all')).find((x) => x.id === id);
    if (!r) throw notFound();
    return r;
  }

  private async decide(auth: AuthContext, id: string, approve: boolean, comment?: string) {
    await this.db.tx(async (q) => {
      const r = await maybeOne<ApprovalRequestRow>(q, `select * from platform.approval_requests where id = $1 for update`, [id]);
      if (!r || !(r.requested_by === auth.userId || auth.scopeFor(r.required_permission).includes(r.branch_id))) throw notFound();
      if (r.status !== 'pending') throw AppError.conflict('APPROVAL_ALREADY_DECIDED', 'This request has already been decided.');
      if (r.requested_by === auth.userId) throw AppError.forbidden('CANNOT_APPROVE_OWN_REQUEST', 'A request must be decided by someone other than the person who made it.');
      if (!this.canDecide(auth, r)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to decide this request.');
      const next = approve ? 'approved' : 'rejected';
      await q.query(`update platform.approval_requests set status = $2, decided_by = $3, decided_at = now(), comment = $4 where id = $1`, [id, next, auth.userId, comment ?? null]);
      const decided = { ...r, status: next, comment: comment ?? null, decided_by: auth.userId } as ApprovalRequestRow;
      const handler = this.handlers.get(r.action_code);
      if (approve) await handler?.onApproved(q, decided, auth);
      else await handler?.onRejected?.(q, decided, auth);
      await this.audit.record({ action: approve ? 'approval.approved' : 'approval.rejected', entityType: 'approval', entityId: id, branchId: r.branch_id, newValue: { actionCode: r.action_code, sourceId: r.source_id, comment } }, q);
    });
    return this.get(auth, id);
  }

  approve(auth: AuthContext, id: string, comment?: string) { return this.decide(auth, id, true, comment); }
  reject(auth: AuthContext, id: string, comment: string) { return this.decide(auth, id, false, comment); }

  /** Only the person who asked can withdraw a pending request. */
  async cancel(auth: AuthContext, id: string) {
    await this.db.tx(async (q) => {
      const r = await maybeOne<ApprovalRequestRow>(q, `select * from platform.approval_requests where id = $1 for update`, [id]);
      if (!r || !(r.requested_by === auth.userId || auth.scopeFor(r.required_permission).includes(r.branch_id))) throw notFound();
      if (r.requested_by !== auth.userId) throw AppError.forbidden('ONLY_REQUESTER_CAN_CANCEL', 'Only the person who made the request can withdraw it.');
      if (r.status !== 'pending') throw AppError.conflict('APPROVAL_ALREADY_DECIDED', 'This request has already been decided.');
      await q.query(`update platform.approval_requests set status = 'cancelled', decided_by = $2, decided_at = now() where id = $1`, [id, auth.userId]);
      await this.handlers.get(r.action_code)?.onCancelled?.(q, { ...r, status: 'cancelled' }, auth);
      await this.audit.record({ action: 'approval.cancelled', entityType: 'approval', entityId: id, branchId: r.branch_id }, q);
    });
    return this.get(auth, id);
  }
}
