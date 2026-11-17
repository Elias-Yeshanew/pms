import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { AppError } from '../../common/app-error';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { PermissionService } from '../iam/permission.service';
import { MessagingService } from '../iam/messaging.service';
import { SettingsService } from '../platform/settings.service';
import { NotificationsService } from './notifications.service';

interface JobDef { name: string; description: string; everyMinutes: number; run: () => Promise<Record<string, unknown>> }

/**
 * Scheduled checks that turn conditions (low stock, expiring batches, overdue orders...) into notifications and close them again
 * when the condition clears. Only one instance runs a job at a time (database advisory lock), so several app servers are safe.
 * Every job can also be started by hand, and each run is recorded.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Jobs');
  private timer: NodeJS.Timeout | null = null;
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly db: DatabaseService, private readonly notes: NotificationsService, private readonly settings: SettingsService,
    private readonly permissions: PermissionService, private readonly messaging: MessagingService, @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap() {
    if (this.env.NODE_ENV === 'test' || !this.env.JOBS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    for (const job of this.jobs) {
      if (Date.now() - (this.lastRun.get(job.name) ?? 0) < job.everyMinutes * 60_000) continue;
      this.lastRun.set(job.name, Date.now());
      await this.run(job.name).catch((e) => this.logger.error(`${job.name}: ${(e as Error).message}`));
    }
  }

  list() {
    return Promise.all(this.jobs.map(async (j) => ({
      name: j.name, description: j.description, everyMinutes: j.everyMinutes,
      lastRun: await maybeOne(this.db, `select started_at, finished_at, status, result, error from platform.job_runs where job = $1 order by started_at desc limit 1`, [j.name]),
    })));
  }

  async run(name: string) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw AppError.notFound('JOB_NOT_FOUND', 'Unknown job.');
    const client = await this.db.pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext($1)) as ok`, [`job:${name}`]);
      if (!got.rows[0].ok) return { name, skipped: true, reason: 'Already running' };
      const run = await one<{ id: string }>(this.db, `insert into platform.job_runs (job) values ($1) returning id`, [name]);
      try {
        const result = await job.run();
        await this.db.query(`update platform.job_runs set status = 'ok', finished_at = clock_timestamp(), result = $2 where id = $1`, [run.id, JSON.stringify(result)]);
        return { name, skipped: false, result };
      } catch (e) {
        await this.db.query(`update platform.job_runs set status = 'failed', finished_at = clock_timestamp(), error = $2 where id = $1`, [run.id, (e as Error).message]);
        throw e;
      } finally {
        await client.query(`select pg_advisory_unlock(hashtext($1))`, [`job:${name}`]);
      }
    } finally {
      client.release();
    }
  }

  async runAll() { const out = []; for (const j of this.jobs) out.push(await this.run(j.name)); return out; }

  // ---------------- the jobs ----------------
  private readonly jobs: JobDef[] = [
    { name: 'stock_alerts', description: 'Low-stock and out-of-stock products per branch', everyMinutes: 30, run: () => this.stockAlerts() },
    { name: 'expiry_alerts', description: 'Batches approaching expiry (configurable bands) and expired stock still on the shelf', everyMinutes: 60, run: () => this.expiryAlerts() },
    { name: 'procurement_alerts', description: 'Late purchase orders, deliveries waiting for inspection, supplier invoices due', everyMinutes: 60, run: () => this.procurementAlerts() },
    { name: 'receivable_alerts', description: 'Customers who have owed money for too long', everyMinutes: 360, run: () => this.receivableAlerts() },
    { name: 'approval_reminders', description: 'Requests waiting too long for an approver', everyMinutes: 60, run: () => this.approvalReminders() },
    { name: 'notification_housekeeping', description: 'Closes old one-off alerts and deletes old closed notifications', everyMinutes: 1440, run: () => this.housekeeping() },
    { name: 'audit_partitions', description: 'Creates the audit log tables for the coming months', everyMinutes: 1440, run: () => this.auditPartitions() },
    { name: 'notification_emails', description: 'Emails new notifications to people who can see them (when enabled)', everyMinutes: 5, run: () => this.sendEmails() },
  ];

  private async stockAlerts() {
    const rows = await many<{ branch_id: string; branch_name: string; low: string; out: string }>(this.db, `
      select br.id as branch_id, br.name as branch_name, count(*) as low, count(*) filter (where coalesce(s.available, 0) <= 0) as out
        from org.branches br cross join catalog.products p
        left join (select branch_id, product_id, sum(quantity - reserved_quantity) as available from inventory.stock_balances where status = 'available' group by 1, 2) s on s.branch_id = br.id and s.product_id = p.id
       where br.status = 'active' and p.is_active and p.reorder_level is not null and coalesce(s.available, 0) <= p.reorder_level group by br.id, br.name`);
    const low: string[] = []; const out: string[] = [];
    for (const r of rows) {
      const lowOnly = Number(r.low) - Number(r.out);
      if (lowOnly > 0) { const key = `low_stock:${r.branch_id}`; low.push(key); await this.notes.raise(this.db, { type: 'low_stock', severity: 'warning', branchId: r.branch_id, permission: 'inventory.read', dedupeKey: key, title: `${lowOnly} product${lowOnly === 1 ? '' : 's'} low on stock at ${r.branch_name}`, body: 'At or below the reorder level. Open the low-stock list to reorder.', data: { count: lowOnly } }); }
      if (Number(r.out) > 0) { const key = `out_of_stock:${r.branch_id}`; out.push(key); await this.notes.raise(this.db, { type: 'out_of_stock', severity: 'critical', branchId: r.branch_id, permission: 'inventory.read', dedupeKey: key, title: `${r.out} product${Number(r.out) === 1 ? '' : 's'} out of stock at ${r.branch_name}`, body: 'No saleable stock left.', data: { count: Number(r.out) } }); }
    }
    await this.notes.resolveMissing(this.db, 'low_stock', low);
    await this.notes.resolveMissing(this.db, 'out_of_stock', out);
    return { branchesWithLowStock: low.length, branchesWithOutOfStock: out.length };
  }

  private async expiryAlerts() {
    const bands = [...(await this.settings.get('inventory.expiry_warning_days', null))].sort((a, b) => a - b);
    const today = await this.settings.businessDate();
    const rows = await many<{ branch_id: string; branch_name: string; days_left: number; batches: string }>(this.db, `
      select br.id as branch_id, br.name as branch_name, (sb.expiry_date - $1::date) as days_left, count(distinct sb.id) as batches
        from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id join org.branches br on br.id = b.branch_id
       where b.status = 'available' and b.quantity > 0 and sb.expiry_date <= $1::date + $2::int group by br.id, br.name, days_left`, [today, bands[bands.length - 1]]);
    const keep: string[] = []; const keepExpired: string[] = [];
    const tally = new Map<string, { branch: string; name: string; band: number | 'expired'; n: number }>();
    for (const r of rows) {
      const band: number | 'expired' = r.days_left < 0 ? 'expired' : bands.find((b) => r.days_left <= b)!;
      const k = `${r.branch_id}:${band}`;
      const t = tally.get(k) ?? { branch: r.branch_id, name: r.branch_name, band, n: 0 };
      t.n += Number(r.batches); tally.set(k, t);
    }
    for (const t of tally.values()) {
      if (t.band === 'expired') {
        const key = `expired_stock:${t.branch}`; keepExpired.push(key);
        await this.notes.raise(this.db, { type: 'expired_stock', severity: 'critical', branchId: t.branch, permission: 'inventory.read', dedupeKey: key, title: `${t.n} expired batch${t.n === 1 ? '' : 'es'} still in stock at ${t.name}`, body: 'Expired stock cannot be sold. Move it to expired and dispose of it.', data: { batches: t.n } });
      } else {
        const key = `expiry:${t.branch}:${t.band}`; keep.push(key);
        await this.notes.raise(this.db, { type: 'expiry', severity: t.band <= (bands[0] ?? 7) ? 'critical' : t.band <= (bands[1] ?? 30) ? 'warning' : 'info', branchId: t.branch, permission: 'inventory.read', dedupeKey: key, title: `${t.n} batch${t.n === 1 ? '' : 'es'} expire within ${t.band} days at ${t.name}`, body: 'Sell, return or transfer these before they expire.', data: { batches: t.n, withinDays: t.band } });
      }
    }
    await this.notes.resolveMissing(this.db, 'expiry', keep);
    await this.notes.resolveMissing(this.db, 'expired_stock', keepExpired);
    return { expiryNotifications: keep.length, expiredNotifications: keepExpired.length };
  }

  private async procurementAlerts() {
    const today = await this.settings.businessDate();
    const late = await many<{ branch_id: string; branch_name: string; n: string }>(this.db, `select o.branch_id, br.name as branch_name, count(*) as n from procurement.purchase_orders o join org.branches br on br.id = o.branch_id
        where o.status in ('approved', 'partially_received') and o.expected_date is not null and o.expected_date < $1::date group by o.branch_id, br.name`, [today]);
    const lateKeys: string[] = [];
    for (const r of late) { const key = `overdue_orders:${r.branch_id}`; lateKeys.push(key); await this.notes.raise(this.db, { type: 'overdue_orders', severity: 'warning', branchId: r.branch_id, permission: 'procurement.order', dedupeKey: key, title: `${r.n} purchase order${r.n === '1' ? ' is' : 's are'} late at ${r.branch_name}`, body: 'The expected delivery date has passed.', data: { count: Number(r.n) } }); }
    await this.notes.resolveMissing(this.db, 'overdue_orders', lateKeys);

    const waiting = await many<{ branch_id: string; branch_name: string; n: string }>(this.db, `select g.branch_id, br.name as branch_name, count(*) as n from procurement.goods_receipts g join org.branches br on br.id = g.branch_id where g.status = 'pending_inspection' and g.received_at < now() - interval '1 day' group by g.branch_id, br.name`);
    const waitKeys: string[] = [];
    for (const r of waiting) { const key = `pending_deliveries:${r.branch_id}`; waitKeys.push(key); await this.notes.raise(this.db, { type: 'pending_deliveries', severity: 'warning', branchId: r.branch_id, permission: 'procurement.inspect', dedupeKey: key, title: `${r.n} delivery${r.n === '1' ? '' : 'ies'} waiting for inspection at ${r.branch_name}`, body: 'Goods received more than a day ago are not yet in saleable stock.', data: { count: Number(r.n) } }); }
    await this.notes.resolveMissing(this.db, 'pending_deliveries', waitKeys);

    const days = await this.settings.get('notifications.supplier_due_warning_days', null);
    const due = await many<{ branch_id: string; branch_name: string; overdue: string; soon: string; owed: string }>(this.db, `select i.branch_id, br.name as branch_name, count(*) filter (where i.due_date < $1::date) as overdue, count(*) filter (where i.due_date >= $1::date) as soon, sum(i.total - i.paid_total - i.credited_total)::numeric(18,4)::text as owed
        from procurement.supplier_invoices i join org.branches br on br.id = i.branch_id where i.status in ('open', 'partially_paid') and i.due_date <= $1::date + $2::int group by i.branch_id, br.name`, [today, days]);
    const dueKeys: string[] = [];
    for (const r of due) { const key = `supplier_payment_due:${r.branch_id}`; dueKeys.push(key); await this.notes.raise(this.db, { type: 'supplier_payment_due', severity: Number(r.overdue) > 0 ? 'critical' : 'warning', branchId: r.branch_id, permission: 'procurement.pay', dedupeKey: key, title: `${r.overdue} overdue and ${r.soon} upcoming supplier invoice${Number(r.overdue) + Number(r.soon) === 1 ? '' : 's'} at ${r.branch_name}`, body: `Outstanding: ${r.owed}`, data: { overdue: Number(r.overdue), soon: Number(r.soon), owed: r.owed } }); }
    await this.notes.resolveMissing(this.db, 'supplier_payment_due', dueKeys);
    return { lateOrders: lateKeys.length, waitingDeliveries: waitKeys.length, invoicesDue: dueKeys.length };
  }

  private async receivableAlerts() {
    const days = await this.settings.get('notifications.customer_overdue_days', null);
    const r = await one<{ n: string; owed: string }>(this.db, `select count(*) as n, coalesce(sum(c.balance), 0)::numeric(18,4)::text as owed from sales.customers c
        where c.balance > 0 and c.status = 'active' and coalesce((select max(l.created_at) from sales.customer_ledger l where l.customer_id = c.id and l.entry_type = 'payment'), (select min(l.created_at) from sales.customer_ledger l where l.customer_id = c.id)) < now() - ($1::int * interval '1 day')`, [days]);
    const key = 'customer_balance:all';
    if (Number(r.n) > 0) await this.notes.raise(this.db, { type: 'customer_balance', severity: 'warning', branchId: null, permission: 'customers.payment', dedupeKey: key, title: `${r.n} customer${r.n === '1' ? ' has' : 's have'} owed money for over ${days} days`, body: `Total owed: ${r.owed}`, data: { count: Number(r.n), owed: r.owed } });
    else await this.notes.resolve(this.db, key);
    return { customers: Number(r.n) };
  }

  private async approvalReminders() {
    const hours = await this.settings.get('notifications.approval_reminder_hours', null);
    const rows = await many<{ required_permission: string; branch_id: string | null; n: string }>(this.db, `select required_permission, branch_id, count(*) as n from platform.approval_requests where status = 'pending' and requested_at < now() - ($1::int * interval '1 hour') group by required_permission, branch_id`, [hours]);
    const keys: string[] = [];
    for (const r of rows) { const key = `pending_approvals:${r.required_permission}:${r.branch_id ?? 'all'}`; keys.push(key); await this.notes.raise(this.db, { type: 'pending_approvals', severity: 'warning', branchId: r.branch_id, permission: r.required_permission, dedupeKey: key, title: `${r.n} request${r.n === '1' ? '' : 's'} waiting for your approval for over ${hours} hours`, body: 'Open Approvals to decide.', data: { count: Number(r.n) } }); }
    await this.notes.resolveMissing(this.db, 'pending_approvals', keys);
    return { reminders: keys.length };
  }

  /** The audit log is split by month. Without this the log still works but piles into one default table that can no longer be split. */
  private async auditPartitions() {
    const created: string[] = [];
    for (let m = 0; m <= 3; m++) {
      const d = await one<{ d: string }>(this.db, `select (date_trunc('month', current_date) + make_interval(months => $1))::date::text as d`, [m]);
      const before = await one<{ n: string | null }>(this.db, `select to_regclass(format('audit.audit_logs_%s', to_char($1::date, 'YYYY_MM')))::text as n`, [d.d]);
      await this.db.query(`select audit.ensure_partition($1::date)`, [d.d]);
      if (!before.n) created.push(d.d.slice(0, 7));
    }
    return { created };
  }

  private async housekeeping() {
    const closed = await this.db.query(`update platform.notifications set resolved_at = now(), email_pending = false where resolved_at is null and type in ('cash_variance', 'unusual_adjustment') and created_at < now() - interval '14 days'`);
    const deleted = await this.db.query(`delete from platform.notifications where resolved_at < now() - interval '90 days'`);
    return { closed: closed.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
  }

  private async sendEmails() {
    if (!(await this.settings.get('notifications.email_enabled', null))) { await this.db.query(`update platform.notifications set email_pending = false where email_pending`); return { sent: 0, disabled: true }; }
    const pending = await many<{ id: string; type: string; branch_id: string | null; permission: string; title: string; body: string }>(this.db, `select id, type, branch_id, permission, title, body from platform.notifications where email_pending and resolved_at is null order by created_at limit 100`);
    if (!pending.length) return { sent: 0 };
    const users = await many<{ id: string; email: string }>(this.db, `select id, email::text from iam.users where status = 'active' and email is not null`);
    const prefs = await many<{ user_id: string; type: string; email: boolean }>(this.db, `select user_id, type, email from platform.notification_preferences where not email`);
    let sent = 0;
    for (const u of users) {
      const perms = await this.permissions.forUser(u.id);
      for (const n of pending) {
        if (prefs.some((p) => p.user_id === u.id && p.type === n.type) || !perms.can(n.permission, n.branch_id)) continue;
        await this.messaging.sendNotification(u.email, n.title, n.body); sent++;
      }
    }
    await this.db.query(`update platform.notifications set email_pending = false, emailed_at = now() where id = any($1::uuid[])`, [pending.map((n) => n.id)]);
    return { sent, notifications: pending.length };
  }
}
