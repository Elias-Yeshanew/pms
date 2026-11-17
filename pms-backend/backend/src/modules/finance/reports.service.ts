import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { SettingsService } from '../platform/settings.service';
import { add, cmp, format, parse, sub } from '../../domain/decimal';

export interface RangeFilter { from?: string; to?: string; branchId?: string }
type Row = { account_id: string; code: string; name: string; type: string; debit: string; credit: string };
const DEBIT_NORMAL = new Set(['asset', 'expense']);
/** Positive when the balance is on the account's normal side */
const signed = (type: string, debit: string, credit: string) => (DEBIT_NORMAL.has(type) ? sub(debit, credit) : sub(credit, debit));

/**
 * Financial reports read straight from the journal, so they always agree with each other and with what was posted.
 * Amounts are for the accounting entries' dates, not the dates the underlying records were created.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService, private readonly settings: SettingsService) {}

  private filter(auth: AuthContext, f: RangeFilter, params: unknown[], opts: { dateFrom?: boolean } = { dateFrom: true }) {
    const where = [auth.scopeFor('finance.read').sql('l.branch_id', params)];
    if (f.branchId) {
      if (!auth.scopeFor('finance.read').includes(f.branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot see this branch.');
      params.push(f.branchId); where.push(`l.branch_id = $${params.length}`);
    }
    if (f.to) { params.push(f.to); where.push(`e.entry_date <= $${params.length}`); }
    if (f.from && opts.dateFrom) { params.push(f.from); where.push(`e.entry_date >= $${params.length}`); }
    return where.join(' and ');
  }

  private async balances(auth: AuthContext, f: RangeFilter, opts?: { dateFrom?: boolean }): Promise<Row[]> {
    const params: unknown[] = [];
    const w = this.filter(auth, f, params, opts);
    return many<Row>(this.db, `select a.id as account_id, a.code, a.name, a.type, coalesce(sum(l.debit), 0)::numeric(18,4)::text as debit, coalesce(sum(l.credit), 0)::numeric(18,4)::text as credit
        from finance.accounts a left join (select l.* from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id where ${w}) l on l.account_id = a.id
        group by a.id, a.code, a.name, a.type order by a.code`, params);
  }

  async trialBalance(auth: AuthContext, f: RangeFilter) {
    const before = f.from ? await this.balances(auth, { ...f, to: dayBefore(f.from) }, { dateFrom: false }) : [];
    const during = await this.balances(auth, f);
    const lines = during.map((r) => {
      const o = before.find((b) => b.account_id === r.account_id);
      const opening = o ? signed(r.type, o.debit, o.credit) : '0.0000';
      const movement = signed(r.type, r.debit, r.credit);
      return { account_id: r.account_id, code: r.code, name: r.name, type: r.type, opening, debit: r.debit, credit: r.credit, closing: add(opening, movement) };
    }).filter((l) => cmp(l.opening, '0') !== 0 || cmp(l.debit, '0') !== 0 || cmp(l.credit, '0') !== 0);
    // Debits and credits of the whole book must be equal
    const all = await this.balances(auth, { ...f, from: undefined });
    const totals = all.reduce((t, r) => ({ debit: add(t.debit, r.debit), credit: add(t.credit, r.credit) }), { debit: '0.0000', credit: '0.0000' });
    return { from: f.from ?? null, to: f.to ?? null, branchId: f.branchId ?? null, lines, totals, balanced: cmp(totals.debit, totals.credit) === 0 };
  }

  async incomeStatement(auth: AuthContext, f: RangeFilter) {
    const rows = await this.balances(auth, f);
    const pick = (types: string[], codes?: (c: string) => boolean) => rows.filter((r) => types.includes(r.type) && (!codes || codes(r.code)))
      .map((r) => ({ account_id: r.account_id, code: r.code, name: r.name, amount: signed(r.type, r.debit, r.credit) })).filter((r) => cmp(r.amount, '0') !== 0);
    const revenue = pick(['revenue']);
    const cogs = pick(['expense'], (c) => c === '5000' || c.startsWith('50'));
    const stockLoss = pick(['expense'], (c) => c.startsWith('51'));
    const operating = pick(['expense'], (c) => !c.startsWith('5'));
    const sum = (xs: Array<{ amount: string }>) => xs.reduce((t, x) => add(t, x.amount), '0.0000');
    // Revenue accounts are credit-normal, so "Sales returns" (debit balance) shows as a negative amount and nets off sales
    const totalRevenue = sum(revenue);
    const totalCogs = sum(cogs);
    const grossProfit = sub(totalRevenue, totalCogs);
    const totalStockLoss = sum(stockLoss);
    const totalOperating = sum(operating);
    return {
      from: f.from ?? null, to: f.to ?? null, branchId: f.branchId ?? null,
      revenue, totalRevenue, costOfGoodsSold: cogs, totalCostOfGoodsSold: totalCogs, grossProfit,
      stockLosses: stockLoss, totalStockLosses: totalStockLoss, operatingExpenses: operating, totalOperatingExpenses: totalOperating,
      netOperatingProfit: sub(sub(grossProfit, totalStockLoss), totalOperating),
    };
  }

  /** Revenue, cost, gross profit, expenses and net profit side by side for every branch the user may see. */
  async branchPerformance(auth: AuthContext, f: RangeFilter) {
    const params: unknown[] = [];
    const w = this.filter(auth, { ...f, branchId: undefined }, params);
    const rows = await many<{ branch_id: string; branch_name: string; type: string; code: string; debit: string; credit: string }>(this.db,
      `select l.branch_id, b.name as branch_name, a.type, a.code, sum(l.debit)::numeric(18,4)::text as debit, sum(l.credit)::numeric(18,4)::text as credit
         from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id join finance.accounts a on a.id = l.account_id join org.branches b on b.id = l.branch_id
        where ${w} and a.type in ('revenue', 'expense') group by l.branch_id, b.name, a.type, a.code order by b.name`, params);
    const by = new Map<string, { branch_id: string; branch_name: string; revenue: string; cogs: string; expenses: string }>();
    for (const r of rows) {
      const b = by.get(r.branch_id) ?? { branch_id: r.branch_id, branch_name: r.branch_name, revenue: '0.0000', cogs: '0.0000', expenses: '0.0000' };
      const v = signed(r.type, r.debit, r.credit);
      if (r.type === 'revenue') b.revenue = add(b.revenue, v); else if (r.code.startsWith('50')) b.cogs = add(b.cogs, v); else b.expenses = add(b.expenses, v);
      by.set(r.branch_id, b);
    }
    return [...by.values()].map((b) => ({ ...b, grossProfit: sub(b.revenue, b.cogs), netOperatingProfit: sub(sub(b.revenue, b.cogs), b.expenses) }));
  }

  async balanceSheet(auth: AuthContext, f: { asOf?: string; branchId?: string }) {
    const rows = await this.balances(auth, { to: f.asOf, branchId: f.branchId }, { dateFrom: false });
    const group = (type: string) => rows.filter((r) => r.type === type).map((r) => ({ account_id: r.account_id, code: r.code, name: r.name, amount: signed(r.type, r.debit, r.credit) })).filter((r) => cmp(r.amount, '0') !== 0);
    const sum = (xs: Array<{ amount: string }>) => xs.reduce((t, x) => add(t, x.amount), '0.0000');
    const assets = group('asset'); const liabilities = group('liability'); const equity = group('equity');
    const earnings = sub(sum(group('revenue')), sum(group('expense')));
    const totalAssets = sum(assets); const totalLiabilities = sum(liabilities); const totalEquity = add(sum(equity), earnings);
    return { asOf: f.asOf ?? null, branchId: f.branchId ?? null, assets, totalAssets, liabilities, totalLiabilities, equity, currentEarnings: earnings, totalEquity, balanced: cmp(totalAssets, add(totalLiabilities, totalEquity)) === 0 };
  }

  async generalLedger(auth: AuthContext, accountId: string, f: RangeFilter) {
    const acc = await maybeOne<{ id: string; code: string; name: string; type: string }>(this.db, `select id, code, name, type from finance.accounts where id = $1`, [accountId]);
    if (!acc) throw AppError.notFound('ACCOUNT_NOT_FOUND', 'Account not found.');
    const params: unknown[] = [accountId];
    const w = this.filter(auth, { ...f, from: undefined }, params, { dateFrom: false });
    const rows = await many<{ entry_id: string; entry_no: string; entry_date: string; description: string; event_code: string; branch_id: string | null; memo: string | null; debit: string; credit: string }>(this.db,
      `select e.id as entry_id, e.entry_no, e.entry_date, e.description, e.event_code, l.branch_id, l.memo, l.debit, l.credit from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id
        where l.account_id = $1 and ${w} order by e.entry_date, e.created_at, l.line_no`, params);
    let running = '0.0000';
    let opening = '0.0000';
    const lines: unknown[] = [];
    for (const r of rows) {
      running = add(running, signed(acc.type, r.debit, r.credit));
      if (f.from && r.entry_date < f.from) { opening = running; continue; }
      lines.push({ ...r, balance: running });
    }
    return { account: acc, from: f.from ?? null, to: f.to ?? null, opening, lines, closing: running };
  }

  /** Money in and out of cash, bank and mobile-money accounts, grouped by what caused it. */
  async cashFlow(auth: AuthContext, f: RangeFilter) {
    const cashAccounts = `(select account_id from finance.account_mappings where key in ('cash', 'bank') or key like 'payment.%' and key <> 'payment.credit')`;
    const params: unknown[] = [];
    const w = this.filter(auth, f, params);
    const rows = await many<{ event_code: string; inflow: string; outflow: string }>(this.db,
      `select e.event_code, coalesce(sum(l.debit), 0)::numeric(18,4)::text as inflow, coalesce(sum(l.credit), 0)::numeric(18,4)::text as outflow
         from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id where ${w} and l.account_id in ${cashAccounts} group by e.event_code order by e.event_code`, params);
    const op: string[] = [];
    const params2: unknown[] = [];
    const w2 = this.filter(auth, { ...f, to: f.from ? dayBefore(f.from) : undefined, from: undefined }, params2, { dateFrom: false });
    const open = f.from ? await one<{ b: string }>(this.db, `select (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::numeric(18,4)::text as b from finance.journal_lines l join finance.journal_entries e on e.id = l.entry_id where ${w2} and l.account_id in ${cashAccounts}`, params2) : { b: '0.0000' };
    void op;
    const totalIn = rows.reduce((t, r) => add(t, r.inflow), '0.0000');
    const totalOut = rows.reduce((t, r) => add(t, r.outflow), '0.0000');
    return { from: f.from ?? null, to: f.to ?? null, branchId: f.branchId ?? null, opening: open.b, byCause: rows.map((r) => ({ ...r, net: sub(r.inflow, r.outflow) })), totalInflow: totalIn, totalOutflow: totalOut, closing: add(open.b, sub(totalIn, totalOut)) };
  }

  /** Tax collected on sales and paid on purchases, from the ledger. The rates themselves are set in tax configuration. */
  async taxSummary(auth: AuthContext, f: RangeFilter) {
    const rows = await this.balances(auth, f);
    const out = rows.find((r) => r.code === '2100');
    const inn = rows.find((r) => r.code === '1300');
    const collected = out ? sub(out.credit, out.debit) : '0.0000';
    const paid = inn ? sub(inn.debit, inn.credit) : '0.0000';
    return { from: f.from ?? null, to: f.to ?? null, branchId: f.branchId ?? null, collectedOnSales: collected, paidOnPurchases: paid, netPayable: sub(collected, paid) };
  }

  /** Checks the books against the sub-ledgers. Every list should come back empty / "ok". */
  async reconcile(auth: AuthContext) {
    // Every figure here is company-wide (stock at cost, receivables, payables), so branch-scoped finance readers may not run it.
    if (!auth.scopeFor('finance.read').isUnrestricted) throw AppError.forbidden('OUT_OF_SCOPE', 'The books check covers the whole company and needs company-wide finance access.');
    const bal = async (key: string, sign: 1 | -1) => {
      const r = await one<{ b: string }>(this.db, `select (coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0))::numeric(18,4)::text as b from finance.journal_lines l where l.account_id = (select account_id from finance.account_mappings where key = $1)`, [key]);
      return sign === 1 ? r.b : sub('0.0000', r.b);
    };
    const stock = await one<{ v: string }>(this.db, `select coalesce(sum(sb.quantity * b.unit_cost), 0)::numeric(18,4)::text as v from inventory.stock_balances sb join inventory.stock_batches b on b.id = sb.batch_id`);
    const inTransit = await bal('in_transit', 1);
    const ar = await one<{ v: string }>(this.db, `select coalesce(sum(balance), 0)::numeric(18,4)::text as v from sales.customers`);
    const ap = await one<{ v: string }>(this.db, `select coalesce(sum(total - paid_total - credited_total), 0)::numeric(18,4)::text as v from procurement.supplier_invoices where status in ('open', 'partially_paid', 'paid')`);
    const checks = [
      { name: 'Inventory (books vs stock on hand at cost)', books: await bal('inventory', 1), subledger: stock.v },
      { name: 'Receivables (books vs customer accounts)', books: await bal('receivable', 1), subledger: ar.v },
      { name: 'Payables (books vs open supplier invoices)', books: await bal('payable', -1), subledger: ap.v },
    ].map((c) => ({ ...c, difference: sub(c.books, c.subledger), ok: cmp(c.books, c.subledger) === 0 }));
    const unbalanced = await many(this.db, `select entry_id, sum(debit) as debit, sum(credit) as credit from finance.journal_lines group by entry_id having sum(debit) <> sum(credit)`);
    return { checks, inTransitStock: inTransit, unbalancedEntries: unbalanced, ok: checks.every((c) => c.ok) && unbalanced.length === 0 };
  }

  /** One branch, one day: sessions, takings by method, expenses and the cash position. */
  async dailyClosing(auth: AuthContext, branchId: string, date: string) {
    if (!auth.scopeFor('finance.read').includes(branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot see this branch.');
    const tz = await this.settings.get('business.timezone', branchId);
    const sales = await many(this.db, `select m.code as method_code, m.name as method_name, count(distinct s.id) as sales, coalesce(sum(p.amount), 0)::numeric(18,4)::text as amount
        from sales.sales s join sales.sale_payments p on p.sale_id = s.id join sales.payment_methods m on m.id = p.method_id
       where s.branch_id = $1 and (s.sold_at at time zone $3)::date = $2::date and s.status <> 'cancelled' group by m.code, m.name, m.sort_order order by m.sort_order`, [branchId, date, tz]);
    const expenses = await one<{ n: string; total: string }>(this.db, `select count(*) as n, coalesce(sum(amount), 0)::numeric(18,4)::text as total from finance.expenses where branch_id = $1 and expense_date = $2 and status = 'posted'`, [branchId, date]);
    const sessions = await many(this.db, `select s.id, s.reference_no, r.name as register_name, s.status, s.opening_amount, s.expected_amount, s.counted_amount, s.variance, u.username as opened_by_name
        from finance.register_sessions s join org.cash_registers r on r.id = s.register_id join iam.users u on u.id = s.opened_by where s.branch_id = $1 and s.business_date = $2 order by s.opened_at`, [branchId, date]);
    const openCount = sessions.filter((s: any) => s.status === 'open').length;
    const variance = sessions.reduce((t: string, s: any) => add(t, s.variance ?? '0'), '0.0000');
    return { branchId, date, salesByMethod: sales, expenses, sessions, openSessions: openCount, totalVariance: variance };
  }
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
