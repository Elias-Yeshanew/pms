import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { Page, PageQuery, offsetOf } from '../../common/pagination';
import { DatabaseService, Queryable, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, parse, sub } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JournalService } from './journal.service';

interface SessionRow { id: string; reference_no: string; register_id: string; branch_id: string; business_date: string; opened_by: string; opened_at: string; opening_amount: string; status: string }

/**
 * A cashier's shift on one register. The system works out how much cash should be in the drawer from what actually happened
 * (cash sales, refunds, customer payments, income and expenses paid from the register); the cashier counts the drawer and any
 * difference is recorded, posted to "cash over and short", and shown to the manager.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly db: DatabaseService, private readonly journal: JournalService, private readonly audit: AuditService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly notifications: NotificationsService) {}

  /** Cash movement on a register between two moments. Refunds are attributed to the register that made the original sale. */
  async cashMovement(q: Queryable, registerId: string, from: string, to: string) {
    const r = await one<{ sales: string; refunds: string; payments: string; payments_reversed: string; income: string; expenses: string }>(q, `
      select
        coalesce((select sum(p.amount) from sales.sale_payments p join sales.sales s on s.id = p.sale_id join sales.payment_methods m on m.id = p.method_id
                   where s.register_id = $1 and m.is_cash and s.sold_at >= $2 and s.sold_at < $3), 0) as sales,
        coalesce((select sum(f.amount) from sales.sale_refunds f join sales.sales s on s.id = f.sale_id join sales.payment_methods m on m.id = f.method_id
                   where s.register_id = $1 and m.is_cash and f.created_at >= $2 and f.created_at < $3), 0) as refunds,
        coalesce((select sum(c.amount) from sales.customer_payments c join sales.payment_methods m on m.id = c.method_id where c.register_id = $1 and m.is_cash and c.received_at >= $2 and c.received_at < $3), 0) as payments,
        coalesce((select sum(c.amount) from sales.customer_payments c join sales.payment_methods m on m.id = c.method_id where c.register_id = $1 and m.is_cash and c.reversed_at >= $2 and c.reversed_at < $3), 0) as payments_reversed,
        coalesce((select sum(i.amount) from finance.incomes i where i.register_id = $1 and i.method_code = 'cash' and i.status = 'posted' and i.created_at >= $2 and i.created_at < $3), 0) as income,
        coalesce((select sum(e.amount) from finance.expenses e where e.register_id = $1 and e.method_code = 'cash' and e.status in ('posted', 'reversed') and e.created_at >= $2 and e.created_at < $3), 0) as expenses`,
      [registerId, from, to]);
    return r;
  }

  private async expectedFor(q: Queryable, s: SessionRow, to: string) {
    const m = await this.cashMovement(q, s.register_id, s.opened_at, to);
    let expected = add(format(parse(s.opening_amount)), format(parse(m.sales)));
    expected = add(expected, format(parse(m.payments)));
    expected = add(expected, format(parse(m.income)));
    expected = sub(expected, format(parse(m.refunds)));
    expected = sub(expected, format(parse(m.payments_reversed)));
    expected = sub(expected, format(parse(m.expenses)));
    return { expected, movement: m };
  }

  async open(auth: AuthContext, dto: { registerId: string; openingAmount: string }) {
    const reg = await maybeOne<{ branch_id: string; status: string; name: string }>(this.db, `select branch_id, status, name from org.cash_registers where id = $1`, [dto.registerId]);
    if (!reg || !auth.scopeFor('finance.register_operate').includes(reg.branch_id)) throw AppError.notFound('REGISTER_NOT_FOUND', 'Cash register not found.');
    if (reg.status !== 'active') throw AppError.conflict('REGISTER_INACTIVE', 'This register is not in use.');
    const opening = format(parse(dto.openingAmount));
    if (cmp(opening, '0') < 0) throw AppError.badRequest('INVALID_AMOUNT', 'The opening amount cannot be negative.');
    const id = await this.db.tx(async (q) => {
      if (await maybeOne(q, `select 1 from finance.register_sessions where register_id = $1 and status = 'open' for update`, [dto.registerId])) throw AppError.conflict('SESSION_ALREADY_OPEN', 'This register already has an open session.');
      const reference = await this.sequences.next(q, 'daily_closing', reg.branch_id);
      const date = await this.journal.businessDate(q);
      const s = await one<{ id: string }>(q, `insert into finance.register_sessions (reference_no, register_id, branch_id, business_date, opened_by, opening_amount) values ($1, $2, $3, $4, $5, $6) returning id`, [reference, dto.registerId, reg.branch_id, date, auth.userId, opening]);
      await this.audit.record({ action: 'register_session.opened', entityType: 'register_session', entityId: s.id, branchId: reg.branch_id, newValue: { reference, register: reg.name, opening } }, q);
      return s.id;
    });
    return this.get(auth, id);
  }

  async close(auth: AuthContext, id: string, dto: { countedAmount: string; note?: string }) {
    await this.db.tx(async (q) => {
      const s = await maybeOne<SessionRow>(q, `select * from finance.register_sessions where id = $1 for update`, [id]);
      if (!s || !auth.scopeFor('finance.register_operate').includes(s.branch_id)) throw AppError.notFound('SESSION_NOT_FOUND', 'Register session not found.');
      if (s.status !== 'open') throw AppError.conflict('SESSION_CLOSED', 'This session is already closed.');
      if (s.opened_by !== auth.userId && !auth.can('finance.register_review', s.branch_id)) throw AppError.forbidden('NOT_YOUR_SESSION', 'Only the cashier who opened the session, or a manager, can close it.');
      const counted = format(parse(dto.countedAmount));
      if (cmp(counted, '0') < 0) throw AppError.badRequest('INVALID_AMOUNT', 'The counted amount cannot be negative.');
      const closedAt = (await one<{ t: string }>(q, `select clock_timestamp() as t`)).t;
      const { expected } = await this.expectedFor(q, s, closedAt);
      const variance = sub(counted, expected);
      const tolerance = await this.settings.get('finance.cash_variance_tolerance', s.branch_id, q);
      const abs = cmp(variance, '0') < 0 ? sub('0.0000', variance) : variance;
      if (cmp(abs, tolerance) > 0 && !dto.note?.trim()) throw AppError.badRequest('VARIANCE_NOTE_REQUIRED', 'The count differs from what the system expects. Add a note explaining why.', { expected, counted, variance });
      let entryId: string | null = null;
      if (cmp(variance, '0') !== 0) {
        const short = cmp(variance, '0') < 0;
        entryId = await this.journal.post(q, {
          eventCode: 'register.variance', description: `Register session ${s.reference_no}: counted ${counted}, expected ${expected}`, branchId: s.branch_id, sourceType: 'register_session', sourceId: s.id, createdBy: auth.userId,
          lines: [{ account: short ? 'cash_over_short' : 'cash', debit: abs }, { account: short ? 'cash' : 'cash_over_short', credit: abs }],
        });
      }
      await q.query(`update finance.register_sessions set status = 'closed', closed_by = $2, closed_at = $3, counted_amount = $4, expected_amount = $5, variance = $6, close_note = $7, entry_id = $8, version = version + 1 where id = $1`,
        [id, auth.userId, closedAt, counted, expected, variance, dto.note ?? null, entryId]);
      if (cmp(abs, tolerance) > 0) {
        await this.notifications.raise(q, { type: 'cash_variance', severity: 'critical', branchId: s.branch_id, permission: 'finance.register_review', dedupeKey: `cash_variance:${s.id}`, title: `Cash difference of ${variance} on ${s.reference_no}`, body: `Expected ${expected}, counted ${counted}.${dto.note ? ` Note: ${dto.note}` : ''}`, entityType: 'register_session', entityId: s.id, data: { expected, counted, variance } });
      }
      await this.audit.record({ action: 'register_session.closed', entityType: 'register_session', entityId: id, branchId: s.branch_id, newValue: { reference: s.reference_no, expected, counted, variance } }, q);
    });
    return this.get(auth, id);
  }

  async get(auth: AuthContext, id: string) {
    const s = await maybeOne<SessionRow & { status: string }>(this.db, `select s.*, r.name as register_name, u.username as opened_by_name, c.username as closed_by_name from finance.register_sessions s join org.cash_registers r on r.id = s.register_id
        join iam.users u on u.id = s.opened_by left join iam.users c on c.id = s.closed_by where s.id = $1`, [id]);
    if (!s || !(auth.scopeFor('finance.read').includes(s.branch_id) || (s.opened_by === auth.userId && auth.scopeFor('finance.register_operate').includes(s.branch_id)))) throw AppError.notFound('SESSION_NOT_FOUND', 'Register session not found.');
    if (s.status === 'open') {
      const { expected, movement } = await this.expectedFor(this.db, s, (await one<{ t: string }>(this.db, `select clock_timestamp() as t`)).t);
      return { ...s, expected_amount: expected, movement };
    }
    return s;
  }

  /** The open session on a register, for the till screen. */
  async current(auth: AuthContext, registerId: string) {
    const s = await maybeOne<{ id: string }>(this.db, `select id from finance.register_sessions where register_id = $1 and status = 'open'`, [registerId]);
    return s ? this.get(auth, s.id) : null;
  }

  async list(auth: AuthContext, q: PageQuery & { branchId?: string; registerId?: string; status?: string; from?: string; to?: string; withVariance?: boolean }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const scope = auth.scopeFor('finance.read').sql('s.branch_id', params);
    params.push(auth.userId);
    const own = `(s.opened_by = $${params.length})`;
    const where = [`(${scope} or ${own})`];
    const add2 = (c: string, v: unknown) => { params.push(v); where.push(c.replace('?', `$${params.length}`)); };
    if (q.branchId) add2('s.branch_id = ?', q.branchId);
    if (q.registerId) add2('s.register_id = ?', q.registerId);
    if (q.status) add2('s.status = ?', q.status);
    if (q.from) add2('s.business_date >= ?', q.from);
    if (q.to) add2('s.business_date <= ?', q.to);
    if (q.withVariance) where.push('coalesce(s.variance, 0) <> 0');
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from finance.register_sessions s where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select s.id, s.reference_no, s.register_id, r.name as register_name, s.branch_id, s.business_date, s.status, s.opening_amount, s.expected_amount, s.counted_amount, s.variance, s.opened_at, s.closed_at, u.username as opened_by_name
        from finance.register_sessions s join org.cash_registers r on r.id = s.register_id join iam.users u on u.id = s.opened_by where ${w} order by s.opened_at desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Used by the point of sale: when the pharmacy requires it, a sale needs an open session on the register. */
  async assertOpenIfRequired(q: PoolClient, branchId: string, registerId: string) {
    if (!(await this.settings.get('finance.require_open_register_session', branchId, q))) return;
    if (!(await maybeOne(q, `select 1 from finance.register_sessions where register_id = $1 and status = 'open'`, [registerId]))) {
      throw AppError.conflict('NO_OPEN_SESSION', 'Open the register session before selling.');
    }
  }
}
