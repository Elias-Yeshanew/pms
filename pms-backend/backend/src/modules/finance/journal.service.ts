import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { DatabaseService, Queryable, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, format, mul, parse, sub } from '../../domain/decimal';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';

export interface JournalLineInput {
  /** A posting key from finance.account_mappings ("cash", "inventory", "payment.card"), or an explicit account id */
  account: string;
  debit?: string;
  credit?: string;
  branchId?: string | null;
  memo?: string;
}
export interface JournalInput {
  eventCode: string;
  description: string;
  branchId: string | null;
  sourceType?: string;
  sourceId?: string;
  entryDate?: string;
  reversesId?: string;
  lines: JournalLineInput[];
  createdBy?: string | null;
}
export interface StockValueRow { movement_type: string; branch_id: string; source_type: string; source_id: string | null; quantity_delta: string; unit_cost: string; reference_no: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which account sits opposite Inventory for each kind of stock movement. */
export function stockCounterKey(movementType: string, sourceType: string): string {
  switch (movementType) {
    case 'opening_balance': return 'opening_equity';
    case 'receipt': return 'grni';
    case 'sale':
    case 'sale_return': return 'cogs';
    case 'correction': return sourceType === 'sale_cancellation' ? 'cogs' : 'stock_adjustment';
    case 'transfer_out':
    case 'transfer_in': return 'in_transit';
    case 'purchase_return': return 'supplier_credits';
    case 'disposal':
    case 'damage':
    case 'expiry':
    case 'quarantine':
    case 'release': return 'stock_writeoff';
    default: return 'stock_adjustment'; // adjustment, count_adjustment
  }
}

/**
 * The only writer of the double-entry journal. Entries are balanced (checked here and again by the database when the
 * transaction commits), can never be edited or deleted, and are corrected only by a reversing entry. Posting into a
 * closed fiscal period is refused; a reversal made later lands in the period that is open today.
 */
@Injectable()
export class JournalService {
  constructor(private readonly db: DatabaseService, private readonly sequences: SequenceService, private readonly settings: SettingsService) {}

  /** Today's date in the business time zone */
  async businessDate(q: Queryable): Promise<string> {
    const tz = await this.settings.get('business.timezone', null, q as PoolClient);
    const r = await one<{ d: string }>(q, `select (now() at time zone $1)::date as d`, [tz]);
    return r.d;
  }

  async accountId(q: Queryable, key: string): Promise<string> {
    if (UUID.test(key)) return key;
    const r = await maybeOne<{ account_id: string }>(q, `select account_id from finance.account_mappings where key = $1`, [key]);
    if (!r) throw AppError.conflict('ACCOUNT_NOT_MAPPED', `No account is set up for "${key}". Ask an administrator to complete the chart of accounts.`, { key });
    return r.account_id;
  }

  /** Account for a payment method: its own mapping, else cash for cash methods and bank for the rest. */
  async paymentAccountKey(q: Queryable, methodCode: string): Promise<string> {
    const own = await maybeOne(q, `select 1 from finance.account_mappings where key = $1`, [`payment.${methodCode}`]);
    if (own) return `payment.${methodCode}`;
    const m = await maybeOne<{ is_cash: boolean; is_credit: boolean }>(q, `select is_cash, is_credit from sales.payment_methods where code = $1`, [methodCode]);
    if (m?.is_credit) return 'receivable';
    return m?.is_cash ? 'cash' : 'bank';
  }

  async assertPeriodOpen(q: Queryable, date: string) {
    const p = await maybeOne<{ name: string; status: string }>(q, `select name, status from finance.fiscal_periods where $1::date between start_date and end_date`, [date]);
    if (p && p.status === 'closed') throw AppError.conflict('PERIOD_CLOSED', `The accounting period ${p.name} is closed.`, { period: p.name, date });
    if (!p) {
      const any = await maybeOne(q, `select 1 from finance.fiscal_periods limit 1`);
      if (any) throw AppError.conflict('NO_OPEN_PERIOD', `No accounting period covers ${date}. Create one first.`, { date });
    }
  }

  /** Returns the new entry id, or null when every line is zero (nothing to record). */
  async post(q: PoolClient, input: JournalInput): Promise<string | null> {
    const lines = input.lines.filter((l) => cmp(l.debit ?? '0', '0') !== 0 || cmp(l.credit ?? '0', '0') !== 0);
    if (lines.length === 0) return null;
    let d = '0.0000';
    let c = '0.0000';
    for (const l of lines) {
      const dr = format(parse(l.debit ?? '0'));
      const cr = format(parse(l.credit ?? '0'));
      if (cmp(dr, '0') < 0 || cmp(cr, '0') < 0 || (cmp(dr, '0') > 0 && cmp(cr, '0') > 0)) throw new AppError(500, 'BAD_JOURNAL_LINE', 'A journal line must be either a debit or a credit.');
      d = add(d, dr);
      c = add(c, cr);
    }
    if (cmp(d, c) !== 0) throw new AppError(500, 'JOURNAL_NOT_BALANCED', 'The journal entry does not balance.', { debit: d, credit: c, event: input.eventCode });
    const date = input.entryDate ?? (await this.businessDate(q));
    await this.assertPeriodOpen(q, date);
    const entryNo = await this.sequences.next(q, 'journal_entry', input.branchId);
    const e = await one<{ id: string }>(q,
      `insert into finance.journal_entries (entry_no, entry_date, branch_id, event_code, source_type, source_id, description, reverses_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [entryNo, date, input.branchId, input.eventCode, input.sourceType ?? null, input.sourceId ?? null, input.description, input.reversesId ?? null, input.createdBy ?? null]);
    let n = 0;
    for (const l of lines) {
      const accountId = await this.accountId(q, l.account);
      await q.query(`insert into finance.journal_lines (entry_id, line_no, account_id, branch_id, debit, credit, memo) values ($1, $2, $3, $4, $5, $6, $7)`,
        [e.id, ++n, accountId, l.branchId === undefined ? input.branchId : l.branchId, format(parse(l.debit ?? '0')), format(parse(l.credit ?? '0')), l.memo ?? null]);
    }
    return e.id;
  }

  /** Reverses every not-yet-reversed entry of a source (optionally one event). Returns how many entries were reversed. */
  async reverseSource(q: PoolClient, input: { sourceType: string; sourceId: string; eventCode?: string; reason: string; createdBy: string | null }): Promise<number> {
    const entries = await many<{ id: string; entry_no: string; branch_id: string | null; event_code: string; description: string }>(q,
      `select e.id, e.entry_no, e.branch_id, e.event_code, e.description from finance.journal_entries e
        where e.source_type = $1 and e.source_id = $2 and ($3::text is null or e.event_code = $3) and e.reverses_id is null
          and not exists (select 1 from finance.journal_entries r where r.reverses_id = e.id) order by e.created_at, e.id for update`,
      [input.sourceType, input.sourceId, input.eventCode ?? null]);
    for (const e of entries) {
      const lines = await many<{ account_id: string; branch_id: string | null; debit: string; credit: string; memo: string | null }>(q, `select account_id, branch_id, debit, credit, memo from finance.journal_lines where entry_id = $1 order by line_no`, [e.id]);
      await this.post(q, {
        eventCode: `${e.event_code}.reversal`, description: `Reversal of ${e.entry_no}: ${input.reason}`, branchId: e.branch_id, sourceType: input.sourceType, sourceId: input.sourceId, reversesId: e.id, createdBy: input.createdBy,
        lines: lines.map((l) => ({ account: l.account_id, debit: l.credit, credit: l.debit, branchId: l.branch_id, memo: l.memo ?? undefined })),
      });
    }
    return entries.length;
  }

  /**
   * Called by the stock ledger inside the same transaction as the stock movement, so inventory and the books cannot drift apart.
   * Movements that only change status (damage, quarantine, release) net to zero and record nothing.
   */
  async postStockMovements(q: PoolClient, rows: StockValueRow[], createdBy: string | null) {
    const groups = new Map<string, { row: StockValueRow; value: string }>();
    for (const r of rows) {
      const key = [r.branch_id, r.movement_type, r.source_type, r.source_id ?? '', r.reference_no].join('|');
      const value = mul(r.quantity_delta, r.unit_cost);
      const g = groups.get(key);
      if (g) g.value = add(g.value, value); else groups.set(key, { row: r, value });
    }
    for (const { row, value } of groups.values()) {
      if (cmp(value, '0') === 0) continue;
      const counter = stockCounterKey(row.movement_type, row.source_type);
      const amount = cmp(value, '0') > 0 ? value : sub('0.0000', value);
      const inbound = cmp(value, '0') > 0;
      await this.post(q, {
        eventCode: `stock.${row.movement_type}`, description: `Stock ${row.movement_type.replace(/_/g, ' ')} ${row.reference_no}`, branchId: row.branch_id, sourceType: row.source_type, sourceId: row.source_id ?? undefined, createdBy,
        lines: [
          { account: 'inventory', debit: inbound ? amount : '0', credit: inbound ? '0' : amount },
          { account: counter, debit: inbound ? '0' : amount, credit: inbound ? amount : '0' },
        ],
      });
    }
  }
}
