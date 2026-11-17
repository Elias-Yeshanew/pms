import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuthContext } from '../../common/auth-types';
import { AppError } from '../../common/app-error';
import { Page, PageQuery, offsetOf } from '../../common/pagination';
import { DatabaseService, Queryable, many, maybeOne } from '../../database/database.service';

export interface RaiseInput {
  type: string;
  severity?: 'info' | 'warning' | 'critical';
  branchId: string | null;
  /** Holders of this permission (within the branch) will see it */
  permission: string;
  title: string;
  body?: string;
  data?: object;
  entityType?: string;
  entityId?: string;
  /** One open notification per key. Raising it again while open only refreshes the text. */
  dedupeKey: string;
}

export const NOTIFICATION_TYPES = [
  'low_stock', 'out_of_stock', 'expiry', 'expired_stock', 'pending_approvals', 'pending_deliveries', 'overdue_orders', 'unusual_adjustment',
  'cash_variance', 'supplier_payment_due', 'customer_balance', 'sync_conflict',
] as const;

@Injectable()
export class NotificationsService {
  constructor(private readonly db: DatabaseService) {}

  /** Opens a notification, or refreshes it if the same condition is still open. Returns true when it is new (or came back). */
  async raise(q: Queryable, n: RaiseInput): Promise<boolean> {
    const existing = await maybeOne<{ id: string; resolved_at: string | null }>(q, `select id, resolved_at from platform.notifications where dedupe_key = $1 for update`, [n.dedupeKey]);
    const args = [n.type, n.severity ?? 'info', n.branchId, n.permission, n.title, n.body ?? '', JSON.stringify(n.data ?? {}), n.entityType ?? null, n.entityId ?? null];
    if (!existing) {
      await q.query(`insert into platform.notifications (type, severity, branch_id, permission, title, body, data, entity_type, entity_id, dedupe_key, email_pending) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`, [...args, n.dedupeKey]);
      return true;
    }
    if (existing.resolved_at === null) {
      await q.query(`update platform.notifications set severity = $1, title = $2, body = $3, data = $4, updated_at = now() where id = $5`, [n.severity ?? 'info', n.title, n.body ?? '', JSON.stringify(n.data ?? {}), existing.id]);
      return false;
    }
    await q.query(`delete from platform.notification_reads where notification_id = $1`, [existing.id]);
    await q.query(`update platform.notifications set severity = $1, title = $2, body = $3, data = $4, resolved_at = null, created_at = now(), updated_at = now(), email_pending = true, emailed_at = null where id = $5`, [n.severity ?? 'info', n.title, n.body ?? '', JSON.stringify(n.data ?? {}), existing.id]);
    return true;
  }

  /** Closes the notification when the condition has cleared. */
  async resolve(q: Queryable, dedupeKey: string): Promise<void> {
    await q.query(`update platform.notifications set resolved_at = now(), email_pending = false where dedupe_key = $1 and resolved_at is null`, [dedupeKey]);
  }

  /** Closes every open notification of a type whose key is not in the keep list (conditions that cleared). */
  async resolveMissing(q: Queryable, type: string, keepKeys: string[]): Promise<void> {
    await q.query(`update platform.notifications set resolved_at = now(), email_pending = false where type = $1 and resolved_at is null and not (dedupe_key = any($2::text[]))`, [type, keepKeys]);
  }

  /** SQL condition limiting notifications to those this user may see. */
  private visibility(auth: AuthContext, codes: string[], params: unknown[]): string {
    const parts: string[] = [];
    for (const code of codes) {
      const scope = auth.scopeFor(code);
      if (scope.isEmpty) continue;
      params.push(code);
      const p = `$${params.length}`;
      parts.push(scope.isUnrestricted ? `(n.permission = ${p})` : `(n.permission = ${p} and ${scope.sql('n.branch_id', params)})`);
    }
    return parts.length ? `(${parts.join(' or ')})` : 'false';
  }

  private async codes(): Promise<string[]> {
    return (await many<{ permission: string }>(this.db, `select distinct permission from platform.notifications`)).map((r) => r.permission);
  }

  async list(auth: AuthContext, q: PageQuery & { unread?: boolean; type?: string; branchId?: string; includeResolved?: boolean }): Promise<Page<unknown>> {
    const params: unknown[] = [auth.userId];
    const where = [this.visibility(auth, await this.codes(), params), `not exists (select 1 from platform.notification_preferences pr where pr.user_id = $1 and pr.type = n.type and not pr.in_app)`];
    if (!q.includeResolved) where.push('n.resolved_at is null');
    if (q.unread) where.push('r.read_at is null');
    if (q.type) { params.push(q.type); where.push(`n.type = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); where.push(`n.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const from = `from platform.notifications n left join platform.notification_reads r on r.notification_id = n.id and r.user_id = $1`;
    const total = Number((await this.db.query(`select count(*) ${from} where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select n.id, n.type, n.severity, n.branch_id, n.title, n.body, n.data, n.entity_type, n.entity_id, n.created_at, n.updated_at, n.resolved_at, (r.read_at is not null) as is_read ${from}
      where ${w} order by (r.read_at is null) desc, case n.severity when 'critical' then 0 when 'warning' then 1 else 2 end, n.created_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async unreadCount(auth: AuthContext): Promise<{ unread: number; critical: number }> {
    const params: unknown[] = [auth.userId];
    const vis = this.visibility(auth, await this.codes(), params);
    const r = await maybeOne<{ unread: string; critical: string }>(this.db, `select count(*) as unread, count(*) filter (where n.severity = 'critical') as critical
        from platform.notifications n left join platform.notification_reads r on r.notification_id = n.id and r.user_id = $1
       where ${vis} and n.resolved_at is null and r.read_at is null and not exists (select 1 from platform.notification_preferences pr where pr.user_id = $1 and pr.type = n.type and not pr.in_app)`, params);
    return { unread: Number(r?.unread ?? 0), critical: Number(r?.critical ?? 0) };
  }

  async markRead(auth: AuthContext, ids: string[] | 'all'): Promise<{ marked: number }> {
    const params: unknown[] = [auth.userId];
    const vis = this.visibility(auth, await this.codes(), params);
    let cond = '';
    if (ids !== 'all') { params.push(ids); cond = `and n.id = any($${params.length}::uuid[])`; }
    const res = await this.db.query(`insert into platform.notification_reads (user_id, notification_id) select $1, n.id from platform.notifications n where ${vis} and n.resolved_at is null ${cond} on conflict do nothing`, params);
    return { marked: res.rowCount ?? 0 };
  }

  async getPreferences(auth: AuthContext) {
    const saved = await many<{ type: string; in_app: boolean; email: boolean }>(this.db, `select type, in_app, email from platform.notification_preferences where user_id = $1`, [auth.userId]);
    return NOTIFICATION_TYPES.map((t) => ({ type: t, inApp: saved.find((s) => s.type === t)?.in_app ?? true, email: saved.find((s) => s.type === t)?.email ?? true }));
  }

  async setPreference(auth: AuthContext, type: string, dto: { inApp?: boolean; email?: boolean }) {
    if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) throw AppError.badRequest('UNKNOWN_NOTIFICATION_TYPE', 'Unknown notification type.');
    await this.db.query(`insert into platform.notification_preferences (user_id, type, in_app, email) values ($1, $2, coalesce($3, true), coalesce($4, true))
      on conflict (user_id, type) do update set in_app = coalesce($3, platform.notification_preferences.in_app), email = coalesce($4, platform.notification_preferences.email)`, [auth.userId, type, dto.inApp ?? null, dto.email ?? null]);
    return this.getPreferences(auth);
  }
}
