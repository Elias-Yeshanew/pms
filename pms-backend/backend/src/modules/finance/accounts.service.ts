import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { Page, PageQuery, likePattern, offsetOf } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { cmp, format, parse } from '../../domain/decimal';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../platform/approvals.service';
import { SequenceService } from '../platform/sequence.service';
import { JournalService } from './journal.service';

export interface ManualLine { account: string; debit?: string; credit?: string; memo?: string }

@Injectable()
export class AccountsService implements OnModuleInit {
  constructor(private readonly db: DatabaseService, private readonly journal: JournalService, private readonly audit: AuditService, private readonly approvals: ApprovalsService, private readonly sequences: SequenceService) {}

  onModuleInit() {
    this.approvals.registerHandler('finance.journal', {
      onApproved: async (q, r) => {
        const m = await maybeOne<{ id: string; reference_no: string; branch_id: string | null; entry_date: string; description: string; lines: ManualLine[]; requested_by: string }>(q, `select * from finance.manual_journals where id = $1 and status = 'pending_approval' for update`, [r.source_id]);
        if (!m) return;
        const entryId = await this.journal.post(q, { eventCode: 'manual', description: `${m.reference_no}: ${m.description}`, branchId: m.branch_id, sourceType: 'manual_journal', sourceId: m.id, entryDate: m.entry_date, createdBy: m.requested_by, lines: m.lines.map((l) => ({ account: l.account, debit: l.debit, credit: l.credit, memo: l.memo })) });
        await q.query(`update finance.manual_journals set status = 'posted', entry_id = $2, decided_by = $3 where id = $1`, [m.id, entryId, r.decided_by]);
      },
      onRejected: async (q, r) => { await q.query(`update finance.manual_journals set status = 'rejected', decided_by = $2 where id = $1 and status = 'pending_approval'`, [r.source_id, r.decided_by]); },
      onCancelled: async (q, r) => { await q.query(`update finance.manual_journals set status = 'cancelled' where id = $1 and status = 'pending_approval'`, [r.source_id]); },
    });
  }

  // ---- chart of accounts ----
  async listAccounts(includeInactive = false) {
    return many(this.db, `select a.id, a.code, a.name, a.type, a.is_system, a.is_active, a.note, a.version,
        (select array_agg(m.key order by m.key) from finance.account_mappings m where m.account_id = a.id) as used_for
      from finance.accounts a ${includeInactive ? '' : 'where a.is_active'} order by a.code`);
  }

  async createAccount(auth: AuthContext, dto: { code: string; name: string; type: string; note?: string }) {
    return this.db.tx(async (q) => {
      if (await maybeOne(q, `select 1 from finance.accounts where code = $1`, [dto.code])) throw AppError.conflict('ACCOUNT_CODE_EXISTS', 'An account with this code already exists.');
      const a = await one(q, `insert into finance.accounts (code, name, type, note, updated_by) values ($1, $2, $3, $4, $5) returning *`, [dto.code, dto.name, dto.type, dto.note ?? null, auth.userId]);
      await this.audit.record({ action: 'account.created', entityType: 'account', entityId: (a as any).id, newValue: dto }, q);
      return a;
    });
  }

  async updateAccount(auth: AuthContext, id: string, dto: { version: number; name?: string; note?: string; isActive?: boolean; type?: string }) {
    return this.db.tx(async (q) => {
      const cur = await maybeOne<{ is_system: boolean; type: string }>(q, `select is_system, type from finance.accounts where id = $1 for update`, [id]);
      if (!cur) throw AppError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.');
      if (dto.isActive === false) {
        if (cur.is_system) throw AppError.conflict('SYSTEM_ACCOUNT', 'Accounts used by automatic postings cannot be deactivated.');
        if (await maybeOne(q, `select 1 from finance.account_mappings where account_id = $1`, [id])) throw AppError.conflict('ACCOUNT_IN_USE', 'This account is a posting account. Point the posting to another account first.');
      }
      if (dto.type && dto.type !== cur.type && await maybeOne(q, `select 1 from finance.journal_lines where account_id = $1 limit 1`, [id])) throw AppError.conflict('ACCOUNT_HAS_POSTINGS', 'The type of an account with postings cannot change.');
      const a = await updateVersioned(q, 'finance.accounts', id, dto.version, { name: dto.name, note: dto.note, is_active: dto.isActive, type: dto.type }, auth.userId, () => AppError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.'));
      await this.audit.record({ action: 'account.updated', entityType: 'account', entityId: id, newValue: dto }, q);
      return a;
    });
  }

  async listMappings() {
    return many(this.db, `select m.key, m.description, a.id as account_id, a.code as account_code, a.name as account_name, a.type as account_type from finance.account_mappings m join finance.accounts a on a.id = m.account_id order by m.key`);
  }

  async setMapping(auth: AuthContext, key: string, accountId: string) {
    return this.db.tx(async (q) => {
      const a = await maybeOne<{ is_active: boolean }>(q, `select is_active from finance.accounts where id = $1`, [accountId]);
      if (!a || !a.is_active) throw AppError.badRequest('ACCOUNT_NOT_FOUND', 'Choose an active account.');
      await q.query(`insert into finance.account_mappings (key, account_id, updated_by) values ($1, $2, $3) on conflict (key) do update set account_id = excluded.account_id, updated_by = excluded.updated_by, updated_at = now()`, [key, accountId, auth.userId]);
      await this.audit.record({ action: 'account_mapping.changed', entityType: 'account_mapping', newValue: { key, accountId } }, q);
      return (await this.listMappings()).find((m: any) => m.key === key);
    });
  }

  // ---- fiscal periods ----
  listPeriods() { return many(this.db, `select * from finance.fiscal_periods order by start_date`); }

  async createPeriod(auth: AuthContext, dto: { name: string; startDate: string; endDate: string }) {
    if (dto.endDate < dto.startDate) throw AppError.badRequest('INVALID_PERIOD', 'The end date is before the start date.');
    return this.db.tx(async (q) => {
      const p = await one(q, `insert into finance.fiscal_periods (name, start_date, end_date) values ($1, $2, $3) returning *`, [dto.name, dto.startDate, dto.endDate]);
      await this.audit.record({ action: 'period.created', entityType: 'fiscal_period', entityId: (p as any).id, newValue: dto }, q);
      return p;
    });
  }

  /** Creates twelve calendar-month periods for a year. Ethiopian-calendar or other period shapes can be created one at a time. */
  async generateYear(auth: AuthContext, year: number) {
    return this.db.tx(async (q) => {
      const out: unknown[] = [];
      for (let m = 1; m <= 12; m++) {
        const name = `${year}-${String(m).padStart(2, '0')}`;
        const exists = await maybeOne(q, `select 1 from finance.fiscal_periods where name = $1`, [name]);
        if (exists) continue;
        out.push(await one(q, `insert into finance.fiscal_periods (name, start_date, end_date) values ($1, make_date($2, $3, 1), (make_date($2, $3, 1) + interval '1 month - 1 day')::date) returning *`, [name, year, m]));
      }
      await this.audit.record({ action: 'period.year_generated', entityType: 'fiscal_period', newValue: { year, created: out.length } }, q);
      return out;
    });
  }

  async setPeriodStatus(auth: AuthContext, id: string, status: 'open' | 'closed', note?: string) {
    return this.db.tx(async (q) => {
      const p = await maybeOne<{ status: string; name: string }>(q, `select status, name from finance.fiscal_periods where id = $1 for update`, [id]);
      if (!p) throw AppError.notFound('PERIOD_NOT_FOUND', 'Period not found.');
      if (p.status === status) throw AppError.conflict('PERIOD_STATUS_UNCHANGED', `The period is already ${status}.`);
      if (status === 'open' && !note?.trim()) throw AppError.badRequest('REASON_REQUIRED', 'Say why the period is being reopened.');
      if (status === 'closed') {
        const pending = await maybeOne(q, `select 1 from finance.manual_journals j join finance.fiscal_periods f on f.id = $1 where j.status = 'pending_approval' and j.entry_date between f.start_date and f.end_date`, [id]);
        if (pending) throw AppError.conflict('PENDING_JOURNALS', 'Manual journals in this period are still waiting for approval.');
      }
      const r = await one(q, status === 'closed'
        ? `update finance.fiscal_periods set status = 'closed', closed_by = $2, closed_at = now(), version = version + 1 where id = $1 returning *`
        : `update finance.fiscal_periods set status = 'open', closed_by = null, closed_at = null, reopen_note = $2, version = version + 1 where id = $1 returning *`, status === 'closed' ? [id, auth.userId] : [id, note]);
      await this.audit.record({ action: status === 'closed' ? 'period.closed' : 'period.reopened', entityType: 'fiscal_period', entityId: id, newValue: { name: p.name, note } }, q);
      return r;
    });
  }

  // ---- journal ----
  async listEntries(auth: AuthContext, q: PageQuery & { from?: string; to?: string; branchId?: string; accountId?: string; eventCode?: string; sourceType?: string; sourceId?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('finance.read').sql('e.branch_id', params)];
    const add2 = (c: string, v: unknown) => { params.push(v); where.push(c.replace('?', `$${params.length}`)); };
    if (q.from) add2('e.entry_date >= ?', q.from);
    if (q.to) add2('e.entry_date <= ?', q.to);
    if (q.branchId) add2('e.branch_id = ?', q.branchId);
    if (q.eventCode) add2('e.event_code = ?', q.eventCode);
    if (q.sourceType) add2('e.source_type = ?', q.sourceType);
    if (q.sourceId) add2('e.source_id = ?', q.sourceId);
    if (q.accountId) add2('exists (select 1 from finance.journal_lines l where l.entry_id = e.id and l.account_id = ?)', q.accountId);
    if (q.search) { params.push(likePattern(q.search)); where.push(`(e.entry_no ilike $${params.length} or e.description ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from finance.journal_entries e where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select e.id, e.entry_no, e.entry_date, e.branch_id, e.event_code, e.source_type, e.source_id, e.description, e.reverses_id, e.created_at,
        (select coalesce(sum(debit), 0) from finance.journal_lines l where l.entry_id = e.id) as amount,
        exists (select 1 from finance.journal_entries r where r.reverses_id = e.id) as is_reversed
      from finance.journal_entries e where ${w} order by e.entry_date desc, e.created_at desc, e.id desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async getEntry(auth: AuthContext, id: string) {
    const e = await maybeOne<{ branch_id: string | null }>(this.db, `select e.*, (select r.id from finance.journal_entries r where r.reverses_id = e.id) as reversed_by_entry from finance.journal_entries e where e.id = $1`, [id]);
    if (!e || !auth.scopeFor('finance.read').includes(e.branch_id)) throw AppError.notFound('ENTRY_NOT_FOUND', 'Journal entry not found.');
    const lines = await many(this.db, `select l.line_no, l.account_id, a.code as account_code, a.name as account_name, l.branch_id, l.debit, l.credit, l.memo from finance.journal_lines l join finance.accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no`, [id]);
    return { ...e, lines };
  }

  async requestManualJournal(auth: AuthContext, dto: { branchId?: string; entryDate?: string; description: string; lines: ManualLine[] }) {
    if (dto.branchId && !auth.scopeFor('finance.journal_create').includes(dto.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot post for this branch.');
    if (!dto.branchId && !auth.scopeFor('finance.journal_create').isUnrestricted) throw AppError.forbidden('OUT_OF_SCOPE', 'Company-wide entries need company-wide access.');
    let d = '0.0000'; let c = '0.0000';
    for (const l of dto.lines) {
      const dr = format(parse(l.debit ?? '0')); const cr = format(parse(l.credit ?? '0'));
      if ((cmp(dr, '0') > 0) === (cmp(cr, '0') > 0)) throw AppError.badRequest('INVALID_LINE', 'Each line must have either a debit or a credit.');
      d = format(parse(d) + parse(dr)); c = format(parse(c) + parse(cr));
    }
    if (cmp(d, c) !== 0) throw AppError.badRequest('NOT_BALANCED', 'Debits and credits must be equal.', { debit: d, credit: c });
    const id = await this.db.tx(async (q) => {
      const today = await this.journal.businessDate(q);
      const date = dto.entryDate ?? today;
      await this.journal.assertPeriodOpen(q, date);
      for (const l of dto.lines) {
        const acc = await maybeOne<{ is_active: boolean }>(q, `select is_active from finance.accounts where id = $1`, [l.account]);
        if (!acc || !acc.is_active) throw AppError.badRequest('ACCOUNT_NOT_FOUND', 'A line uses an account that does not exist or is inactive.');
      }
      const ref = await this.sequences.next(q, 'journal_entry', dto.branchId ?? null);
      const m = await one<{ id: string }>(q, `insert into finance.manual_journals (reference_no, branch_id, entry_date, description, lines, requested_by) values ($1, $2, $3, $4, $5, $6) returning id`, [`MJ-${ref}`, dto.branchId ?? null, date, dto.description, JSON.stringify(dto.lines), auth.userId]);
      await this.approvals.request(q, auth, { actionCode: 'finance.journal', sourceType: 'manual_journal', sourceId: m.id, branchId: dto.branchId ?? null, requiredPermission: 'finance.journal_approve', summary: { reference: `MJ-${ref}`, description: dto.description, amount: d } });
      await this.audit.record({ action: 'journal.requested', entityType: 'manual_journal', entityId: m.id, branchId: dto.branchId ?? null, newValue: { reference: `MJ-${ref}`, amount: d } }, q);
      return m.id;
    });
    return maybeOne(this.db, `select j.*, (select a.id from platform.approval_requests a where a.source_type = 'manual_journal' and a.source_id = j.id order by a.requested_at desc limit 1) as approval_id from finance.manual_journals j where j.id = $1`, [id]);
  }
}
