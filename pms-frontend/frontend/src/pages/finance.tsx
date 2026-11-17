import { ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { label, money, today } from '../lib/format';
import { DocCfg, DocumentPage } from '../ui/documents';
import { ResourcePage } from '../ui/resource';
import { ActionButton, AutoTable, Badge, DataTable, Empty, ErrorBox, FieldDef, FormFields, FormModal, KeyValues, Modal, PageHeader, Spinner, Tabs, useLookup, useToast } from '../ui/kit';

const branchLookup = { path: '/branches' };
const methodLookup = { path: '/payment-methods', value: 'code', filter: (r: Row) => r.is_active && !r.is_credit };

/** Shows any report object: single values as tiles, lists as tables. */
export function ReportView({ data, skip = [] }: { data: Row; skip?: string[] }) {
  const scalars = Object.entries(data).filter(([k, v]) => !skip.includes(k) && v !== null && typeof v !== 'object');
  const lists = Object.entries(data).filter(([k, v]) => !skip.includes(k) && Array.isArray(v) && v.length && typeof v[0] === 'object');
  const nested = Object.entries(data).filter(([k, v]) => !skip.includes(k) && v && !Array.isArray(v) && typeof v === 'object');
  return (
    <div className="space-y-4">
      {scalars.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          {scalars.map(([k, v]) => (
            <div key={k} className="card p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label(k)}</div>
              <div className="mt-1 text-base font-bold text-slate-900 dark:text-white tabular-nums">
                {/^-?\d+\.\d{4}$/.test(String(v)) ? money(v as string) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}
              </div>
            </div>
          ))}
        </div>
      )}
      {nested.map(([k, v]) => (
        <div key={k}>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label(k)}</h3>
          <div className="card shadow-xs">
            <KeyValues data={v as Row} />
          </div>
        </div>
      ))}
      {lists.map(([k, rows]) => (
        <div key={k}>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label(k)}</h3>
          <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
            <AutoTable rows={rows as Row[]} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- expenses / income ----------
const expenseCols = (who: string) => [{ key: 'reference_no', header: 'Reference' }, { key: 'expense_date', header: 'Date', render: (r: Row) => r.expense_date ?? r.income_date }, { key: 'category_name', header: 'Category' }, { key: who, header: who === 'payee' ? 'Paid to' : 'Received from' }, { key: 'description', header: 'Description' }, { key: 'amount', header: 'Amount', type: 'money' as const }, { key: 'status', header: 'Status', type: 'badge' as const }];
export function ExpensesPage() {
  const { branchId } = useBranch();
  return <DocumentPage cfg={{
    title: 'Expenses', path: '/finance/expenses', statuses: ['pending_approval', 'posted', 'reversed', 'rejected', 'cancelled'], filters: [{ name: 'categoryId', label: 'Category', type: 'lookup', lookup: { path: '/finance/expense-categories' } }, { name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }],
    columns: expenseCols('payee'),
    create: { permission: 'finance.expense_create', header: [{ name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup, required: true, default: branchId ?? '' }, { name: 'categoryId', label: 'Category', type: 'lookup', lookup: { path: '/finance/expense-categories' }, required: true }, { name: 'amount', label: 'Amount', type: 'decimal', required: true }, { name: 'methodCode', label: 'Paid by', type: 'lookup', lookup: methodLookup, required: true, default: 'cash' }, { name: 'expenseDate', label: 'Date', type: 'date', default: today() }, { name: 'payee', label: 'Paid to' }, { name: 'externalRef', label: 'Receipt / reference' }, { name: 'description', label: 'Description', required: true, span: 2 }], build: (h) => h },
    actions: [
      { label: 'Cancel', path: (d) => `/finance/expenses/${d.id}/cancel`, permission: 'finance.expense_create', show: (d) => d.status === 'pending_approval', confirm: 'Cancel this expense?', danger: true, body: () => ({}) },
      { label: 'Reverse', path: (d) => `/finance/expenses/${d.id}/reverse`, permission: 'finance.expense_reverse', show: (d) => d.status === 'posted', danger: true, fields: [{ name: 'reason', label: 'Reason', required: true }] },
    ],
  } as DocCfg} />;
}
export function IncomePage() {
  const { branchId } = useBranch();
  return <DocumentPage cfg={{
    title: 'Other income', subtitle: 'Money received that is not from selling products, such as rent or commissions.', path: '/finance/incomes', filters: [{ name: 'categoryId', label: 'Category', type: 'lookup', lookup: { path: '/finance/income-categories' } }, { name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }],
    columns: expenseCols('payer'),
    create: { permission: 'finance.income_manage', header: [{ name: 'branchId', label: 'Branch', type: 'lookup', lookup: branchLookup, required: true, default: branchId ?? '' }, { name: 'categoryId', label: 'Category', type: 'lookup', lookup: { path: '/finance/income-categories' }, required: true }, { name: 'amount', label: 'Amount', type: 'decimal', required: true }, { name: 'methodCode', label: 'Received by', type: 'lookup', lookup: methodLookup, required: true, default: 'cash' }, { name: 'incomeDate', label: 'Date', type: 'date', default: today() }, { name: 'payer', label: 'Received from' }, { name: 'externalRef', label: 'Reference' }, { name: 'description', label: 'Description', required: true, span: 2 }], build: (h) => h },
    actions: [{ label: 'Reverse', path: (d) => `/finance/incomes/${d.id}/reverse`, permission: 'finance.income_manage', show: (d) => d.status === 'posted' || !d.status, danger: true, fields: [{ name: 'reason', label: 'Reason', required: true }] }],
  } as DocCfg} />;
}

// ---------- journal ----------
function ManualJournal({ close, done }: { close(): void; done(r?: Row): void }) {
  const accts = useLookup('/finance/accounts'); const { branchId } = useBranch();
  const [desc, setDesc] = useState(''); const [date, setDate] = useState(today()); const [lines, setLines] = useState<Row[]>([{ account: '', debit: '', credit: '', memo: '' }, { account: '', debit: '', credit: '', memo: '' }]); const [err, setErr] = useState<unknown>(null);
  const num = (s: string) => (/^\d+(\.\d{1,4})?$/.test(s) ? Number(s) : 0);
  const dr = lines.reduce((t, l) => t + num(l.debit), 0); const cr = lines.reduce((t, l) => t + num(l.credit), 0); const ok = Math.abs(dr - cr) < 0.00005 && dr > 0 && desc.trim().length > 2 && lines.every((l) => !l.account === !(num(l.debit) || num(l.credit)));
  const set = (i: number, p: Row) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <Modal wide title="Manual journal entry" onClose={close} footer={<><button className="btn-ghost" onClick={close}>Cancel</button><ActionButton className="btn-primary" disabled={!ok} run={async () => { try { setErr(null); done(await api.post('/finance/manual-journals', { ...(branchId ? { branchId } : {}), entryDate: date, description: desc, lines: lines.filter((l) => l.account).map((l) => ({ account: l.account, ...(num(l.debit) ? { debit: l.debit } : {}), ...(num(l.credit) ? { credit: l.credit } : {}), ...(l.memo ? { memo: l.memo } : {}) })) })); } catch (e) { setErr(e); throw e; } }}>Post</ActionButton></>}>
      {err ? <div className="mb-3"><ErrorBox error={err} /></div> : null}
      <div className="mb-3 grid gap-3 sm:grid-cols-3"><div className="sm:col-span-2"><label className="label">Description</label><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></div><div><label className="label">Date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div></div>
      <div className="overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
        <table className="min-w-full text-xs divide-y divide-slate-200 dark:divide-slate-800">
          <thead><tr><th className="th">Account</th><th className="th w-32">Debit</th><th className="th w-32">Credit</th><th className="th">Memo</th><th className="th w-10" /></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900">
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="td"><select className="input text-xs" value={l.account} onChange={(e) => set(i, { account: e.target.value })}><option value="">Select account…</option>{accts.data?.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></td>
                <td className="td"><input className="input text-xs font-semibold tabular-nums" inputMode="decimal" placeholder="0.00" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: '' })} /></td>
                <td className="td"><input className="input text-xs font-semibold tabular-nums" inputMode="decimal" placeholder="0.00" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: '' })} /></td>
                <td className="td"><input className="input text-xs" placeholder="Optional memo" value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} /></td>
                <td className="td text-right">{lines.length > 2 && <button className="text-slate-400 hover:text-red-600 transition-colors" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button className="btn-ghost text-xs" onClick={() => setLines([...lines, { account: '', debit: '', credit: '', memo: '' }])}>+ Add line</button>
        <span className={`text-xs font-semibold ${Math.abs(dr - cr) < 0.00005 && dr > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
          Debits {money(String(dr.toFixed(4)))} · Credits {money(String(cr.toFixed(4)))}
        </span>
      </div>
    </Modal>
  );
}
export const JournalPage = () => <DocumentPage cfg={{
  title: 'Journal', subtitle: 'Every financial event as balanced debits and credits. Entries are never edited, only reversed.', path: '/finance/journal',
  filters: [{ name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }, { name: 'accountId', label: 'Account', type: 'lookup', lookup: { path: '/finance/accounts', label: (r: Row) => `${r.code} · ${r.name}` } }, { name: 'sourceType', label: 'Source', type: 'select', options: ['sale', 'sale_return', 'purchase_receipt', 'supplier_invoice', 'supplier_payment', 'expense', 'income', 'adjustment', 'manual'].map((v) => ({ value: v, label: label(v) })) }],
  columns: [{ key: 'entry_no', header: 'Entry' }, { key: 'entry_date', header: 'Date', type: 'date' }, { key: 'event_code', header: 'Event' }, { key: 'description', header: 'Description' }, { key: 'amount', header: 'Amount', type: 'money' }, { key: 'is_reversed', header: 'Reversed', type: 'bool' }],
  customCreate: { permission: 'finance.journal_create', label: 'Manual entry', render: (close, done) => <ManualJournal close={close} done={done} /> },
  pageSize: 50,
} as DocCfg} />;

// ---------- chart of accounts / mappings / categories ----------
export function AccountsPage() {
  const [tab, setTab] = useState('accounts');
  const typeOpts = ['asset', 'liability', 'equity', 'revenue', 'expense'].map((v) => ({ value: v, label: label(v) }));
  return (
    <div>
      <PageHeader title="Chart of accounts" subtitle="Accounts the books are kept in. Rates and rules for which account is used live in Account mapping." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'accounts', label: 'Accounts' }, { id: 'map', label: 'Account mapping' }, { id: 'exp', label: 'Expense categories' }, { id: 'inc', label: 'Income categories' }]} />
      <div className="mt-3">
        {tab === 'accounts' && <ResourcePage cfg={{ title: 'Accounts', path: '/finance/accounts', staticQuery: { includeInactive: 'true' }, columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'type', header: 'Type', type: 'badge' }, { key: 'used_for', header: 'Used for', render: (r) => (r.used_for ?? []).join(', ') }, { key: 'is_active', header: 'Active', type: 'bool' }],
          create: { permission: 'finance.accounts_manage', fields: [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'type', label: 'Type', type: 'select', required: true, options: typeOpts }, { name: 'note', label: 'Note' }] },
          edit: { permission: 'finance.accounts_manage', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'note', label: 'Note' }, { name: 'isActive', label: 'Active', type: 'checkbox', help: 'Can be posted to' }] }, detail: false }} />}
        {tab === 'map' && <Mappings />}
        {tab === 'exp' && <Categories path="/finance/expense-categories" title="Expense categories" />}
        {tab === 'inc' && <Categories path="/finance/income-categories" title="Income categories" />}
      </div>
    </div>
  );
}
function Mappings() {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['mappings'], queryFn: async () => (await api.list('/finance/account-mappings')).items }); const accts = useLookup('/finance/accounts');
  return <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <DataTable rows={q.data ?? []} columns={[{ key: 'key', header: 'Used for', render: (r) => <div><span className="font-semibold text-slate-800 dark:text-slate-200">{label(r.key)}</span><div className="text-xs text-slate-500">{r.description}</div></div> }, { key: 'account', header: 'Account', render: (r) => can('finance.accounts_manage') ? <select className="input py-1 text-xs" value={r.account_id} onChange={async (e) => { try { await api.put(`/finance/account-mappings/${r.key}`, { accountId: e.target.value }); toast.ok('Saved'); void qc.invalidateQueries({ queryKey: ['mappings'] }); } catch (x) { toast.error(x); } }}>{accts.data?.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select> : `${r.account_code} · ${r.account_name}` }]} />}</div>;
}
function Categories({ path, title }: { path: string; title: string }) {
  const f: FieldDef[] = [{ name: 'code', label: 'Code' }, { name: 'name', label: 'Name', required: true }, { name: 'accountId', label: 'Posts to account', type: 'lookup', lookup: { path: '/finance/accounts', label: (r: Row) => `${r.code} · ${r.name}` }, required: true }];
  return <ResourcePage cfg={{ title, path, columns: [{ key: 'name', header: 'Name' }, { key: 'account_code', header: 'Account', render: (r) => `${r.account_code} · ${r.account_name}` }, { key: 'is_active', header: 'Active', type: 'bool' }], create: { permission: 'finance.accounts_manage', fields: f }, edit: { permission: 'finance.accounts_manage', fields: [...f.filter((x) => x.name !== 'code'), { name: 'isActive', label: 'Active', type: 'checkbox', help: 'Can be chosen' }] }, detail: false }} />;
}

// ---------- fiscal periods ----------
export function PeriodsPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast(); const [year, setYear] = useState(false); const [reopen, setReopen] = useState<Row | null>(null);
  const q = useQuery({ queryKey: ['periods'], queryFn: async () => (await api.list('/finance/periods')).items });
  const re = () => void qc.invalidateQueries({ queryKey: ['periods'] });
  return (
    <div>
      <PageHeader title="Fiscal periods" subtitle="Closed periods cannot take new entries. Check the calendar with your accountant (Ethiopian fiscal year)." actions={can('finance.period_manage') && <button className="btn-primary" onClick={() => setYear(true)}>Create a year</button>} />
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <DataTable empty="No periods yet. Create a year to start." rows={q.data ?? []} columns={[{ key: 'name', header: 'Period', render: (r) => r.name ?? r.label }, { key: 'start_date', header: 'From', type: 'date' }, { key: 'end_date', header: 'To', type: 'date' }, { key: 'status', header: 'Status', type: 'badge' },
        { key: '_', header: '', render: (r) => can('finance.period_manage') ? (r.status === 'open' ? <ActionButton className="btn-ghost py-1 text-xs" confirm="Close this period? No more entries can be dated in it." run={async () => { await api.post(`/finance/periods/${r.id}/close`, {}); toast.ok('Closed'); re(); }}>Close</ActionButton> : <button className="btn-ghost py-1 text-xs" onClick={() => setReopen(r)}>Reopen</button>) : null }]} />}</div>
      {year && <FormModal title="Create fiscal periods for a year" fields={[{ name: 'year', label: 'Year', type: 'number', required: true, default: new Date().getFullYear(), min: 2000, max: 2100 }]} onClose={() => setYear(false)} onSubmit={async (v) => { await api.post('/finance/periods/generate-year', v); toast.ok('Periods created'); re(); }} />}
      {reopen && <FormModal title="Reopen period" fields={[{ name: 'note', label: 'Why?', required: true }]} onClose={() => setReopen(null)} onSubmit={async (v) => { await api.post(`/finance/periods/${reopen.id}/reopen`, v); toast.ok('Reopened'); re(); }} />}
    </div>
  );
}

// ---------- statements ----------
const STATEMENTS: Array<{ id: string; label: string; path: string; mode: 'range' | 'asof' | 'day' | 'none' }> = [
  { id: 'is', label: 'Profit and loss', path: '/finance/reports/income-statement', mode: 'range' }, { id: 'bs', label: 'Balance sheet', path: '/finance/reports/balance-sheet', mode: 'asof' }, { id: 'tb', label: 'Trial balance', path: '/finance/reports/trial-balance', mode: 'range' },
  { id: 'cf', label: 'Cash flow', path: '/finance/reports/cash-flow', mode: 'range' }, { id: 'tax', label: 'Tax summary', path: '/finance/reports/tax-summary', mode: 'range' }, { id: 'bp', label: 'Branch performance', path: '/finance/reports/branch-performance', mode: 'range' },
  { id: 'dc', label: 'Daily closing', path: '/finance/reports/daily-closing', mode: 'day' }, { id: 'rc', label: 'Books check', path: '/finance/reconcile', mode: 'none' },
];
export function StatementsPage() {
  const { branchId } = useBranch(); const [tab, setTab] = useState('is'); const [f, setF] = useState<Row>({ from: '', to: '', asOf: today(), date: today(), allBranches: true });
  const st = STATEMENTS.find((s) => s.id === tab)!;
  const q = useQuery({ queryKey: ['statement', tab, f, branchId], queryFn: () => api.get<Row>(st.path, { branchId: f.allBranches ? undefined : branchId ?? undefined, ...(st.mode === 'range' ? { from: f.from || undefined, to: f.to || undefined } : st.mode === 'asof' ? { asOf: f.asOf || undefined } : st.mode === 'day' ? { date: f.date || undefined } : {}) }) });
  const rows = Array.isArray(q.data) ? q.data : null;
  return (
    <div>
      <PageHeader title="Financial statements" subtitle="Figures are only as good as the account mappings and tax settings. Have your accountant review before relying on them." actions={<button className="btn-ghost" onClick={() => window.print()}>Print</button>} />
      <Tabs value={tab} onChange={setTab} tabs={STATEMENTS.map((s) => ({ id: s.id, label: s.label }))} />
      <div className="my-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {st.mode === 'range' && <><div><label className="label">From</label><input type="date" className="input text-xs" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div><div><label className="label">To</label><input type="date" className="input text-xs" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div></>}
        {st.mode === 'asof' && <div><label className="label">As of</label><input type="date" className="input text-xs" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} /></div>}
        {st.mode === 'day' && <div><label className="label">Day</label><input type="date" className="input text-xs" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>}
        {st.mode !== 'none' && tab !== 'bp' && <label className="flex items-center gap-1.5 pb-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer"><input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={f.allBranches} onChange={(e) => setF({ ...f, allBranches: e.target.checked })} />All branches</label>}
      </div>
      <div className="print-area">{q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : rows ? <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800"><AutoTable rows={rows} /></div> : q.data && <ReportView data={q.data} skip={['from', 'to', 'branchId', 'asOf']} />}</div>
    </div>
  );
}

// ---------- register sessions ----------
export const SessionsPage = () => <DocumentPage cfg={{
  title: 'Register sessions', subtitle: 'Each shift’s opening cash, takings and counted cash. Differences are highlighted.', path: '/finance/register-sessions', statuses: ['open', 'closed'],
  filters: [{ name: 'withVariance', label: 'Show', type: 'select', options: [{ value: 'true', label: 'Only with a cash difference' }] }, { name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }],
  columns: [{ key: 'reference_no', header: 'Session', render: (r) => r.reference_no ?? r.id.slice(0, 8) }, { key: 'register_name', header: 'Register', render: (r) => r.register_name ?? r.register_code }, { key: 'opened_by_name', header: 'Cashier' }, { key: 'opened_at', header: 'Opened', type: 'datetime' }, { key: 'closed_at', header: 'Closed', type: 'datetime' }, { key: 'variance', header: 'Difference', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }],
} as DocCfg} />;
