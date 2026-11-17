import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { dateTime, label, money, pct, qty } from '../lib/format';
import { ActionButton, Badge, Column, DataTable, Empty, ErrorBox, FormModal, KeyValues, PageHeader, Spinner, Tabs, Pager, useLookup, usePagedList, useToast } from '../ui/kit';
import { NAV } from '../lib/nav';

const colType = (t?: string): Column['type'] => (t === 'money' ? 'money' : t === 'qty' ? 'qty' : t === 'date' ? 'date' : t === 'datetime' ? 'datetime' : t === 'percent' ? 'pct' : undefined);
const toColumns = (cols: Row[]): Column[] => cols.map((c) => ({ key: c.key, header: c.label, type: colType(c.type), align: ['int', 'money', 'qty', 'percent'].includes(c.type) ? 'right' : undefined }));
const fmtTile = (t: Row) => (t.type === 'money' ? money(t.value) : t.type === 'percent' ? `${t.value}%` : t.type === 'qty' ? qty(t.value) : String(t.value));

const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'this_year', 'custom'];
function PeriodPicker({ value, onChange }: { value: Row; onChange(v: Row): void }) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div><label className="label">Period</label><select className="input text-xs" value={value.period} onChange={(e) => onChange({ ...value, period: e.target.value })}>{PERIODS.map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></div>
      {value.period === 'custom' && <><div><label className="label">From</label><input type="date" className="input text-xs" value={value.from ?? ''} onChange={(e) => onChange({ ...value, from: e.target.value })} /></div><div><label className="label">To</label><input type="date" className="input text-xs" value={value.to ?? ''} onChange={(e) => onChange({ ...value, to: e.target.value })} /></div></>}
    </div>
  );
}
function ResultTable({ t }: { t: Row }) {
  const cols = toColumns(t.columns);
  const sums = t.totals ? <tr className="border-t-2 border-slate-300 font-bold bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/50">{cols.map((c, i) => <td key={c.key} className={`td ${c.align === 'right' ? 'text-right' : ''}`}>{i === 0 ? 'Total' : t.totals[c.key] !== undefined ? (c.type === 'money' ? money(t.totals[c.key]) : c.type === 'qty' ? qty(t.totals[c.key]) : String(t.totals[c.key])) : ''}</td>)}</tr> : null;
  return <DataTable columns={cols} rows={t.rows ?? []} empty="No data for this period." footer={sums} />;
}

// ---------- home / dashboards ----------
export function Home() {
  const { can, me } = useAuth(); const { branchId } = useBranch();
  const list = useQuery({ queryKey: ['dash-list'], queryFn: async () => (await api.list('/dashboards')).items });
  const roles = (list.data ?? []).filter((d) => d.role === 'dispenser' || can('dashboards.management'));
  const [role, setRole] = useState(''); const [p, setP] = useState<Row>({ period: 'this_month' });
  useEffect(() => { if (!role && roles.length) setRole(roles[0].role); }, [roles, role]);
  const q = useQuery({ queryKey: ['dash', role, p, branchId], enabled: !!role, queryFn: () => api.get<Row>(`/dashboards/${role}`, { period: p.period, from: p.from || undefined, to: p.to || undefined, branchId: branchId ?? undefined }) });
  const shortcuts = NAV.flatMap((g) => g.items).filter((i) => ['/pos', '/sales', '/products', '/stock', '/purchase-orders'].includes(i.to) && (Array.isArray(i.permission) ? i.permission.some((x) => can(x)) : can(i.permission ?? '')));
  return (
    <div>
      <PageHeader title={`Hello${me?.user.full_name ? `, ${me.user.full_name}` : me?.user.username ? `, ${me.user.username}` : ''}`} subtitle="Here is how things are going." />
      <div className="mb-4 flex flex-wrap gap-2">{shortcuts.map((s) => <Link key={s.to} className="btn-ghost py-1.5 px-3 text-xs font-semibold" to={s.to}>{s.label}</Link>)}</div>
      {list.isLoading ? <Spinner /> : roles.length === 0 ? <Empty text="No dashboard for your role." /> : <>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><Tabs value={role} onChange={setRole} tabs={roles.map((d) => ({ id: d.role, label: d.title }))} /><PeriodPicker value={p} onChange={setP} /></div>
        {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : q.data && <div className="space-y-4">
          <p className="text-xs font-medium text-slate-500">{q.data.period.from} to {q.data.period.to}{branchId ? '' : ' · all branches'}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{q.data.tiles.map((t: Row) => (
            <div key={t.key} className="card p-3.5 border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.label}</div>
              <div className="mt-1 text-xl font-bold text-slate-900 dark:text-white tabular-nums">{fmtTile(t)}</div>
            </div>
          ))}</div>
          {q.data.tables.map((t: Row) => (
            <div key={t.code} className="space-y-1.5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t.title}</h3>
              <p className="text-xs text-slate-500">{t.description}</p>
              <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800"><ResultTable t={t} /></div>
            </div>
          ))}
        </div>}
      </>}
    </div>
  );
}

// ---------- approvals ----------
export function Approvals() {
  const [all, setAll] = useState(false); const qc = useQueryClient(); const toast = useToast(); const [act, setAct] = useState<{ row: Row; kind: 'approve' | 'reject' } | null>(null);
  const q = useQuery({ queryKey: ['approvals', all], queryFn: async () => (await api.list('/approvals', { status: all ? 'all' : 'pending' })).items });
  const re = () => { void qc.invalidateQueries({ queryKey: ['approvals'] }); void qc.invalidateQueries({ queryKey: ['unread'] }); };
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Things waiting for a decision. You cannot approve your own requests." actions={<label className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={all} onChange={(e) => setAll(e.target.checked)} />Include decided</label>} />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <div className="card"><Empty text="Nothing is waiting." /></div> : <div className="space-y-3">
        {q.data.map((r) => (
          <div key={r.id} className="card shadow-xs border border-slate-200 dark:border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-bold text-xs uppercase tracking-wider text-slate-900 dark:text-white">{label(r.action_code)}</div>
                <div className="text-[11px] text-slate-500">Requested by {r.requested_by_name} · {dateTime(r.requested_at)}</div>
              </div>
              <Badge value={r.status} />
            </div>
            <div className="my-2.5"><KeyValues data={r.summary ?? {}} /></div>
            {r.comment && <p className="mb-2 text-xs italic text-slate-600 dark:text-slate-300">“{r.comment}” — {r.decided_by_name}</p>}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              {r.can_decide && (
                <>
                  <button className="btn-danger py-1 px-3 text-xs" onClick={() => setAct({ row: r, kind: 'reject' })}>Reject</button>
                  <button className="btn-primary py-1 px-3 text-xs" onClick={() => setAct({ row: r, kind: 'approve' })}>Approve</button>
                </>
              )}
              {r.is_mine && r.status === 'pending' && <ActionButton className="btn-ghost py-1 px-3 text-xs" confirm="Withdraw this request?" run={async () => { await api.post(`/approvals/${r.id}/cancel`, {}); re(); }}>Withdraw</ActionButton>}
              {r.status === 'pending' && !r.can_decide && !r.is_mine && <span className="text-xs text-slate-500 self-center">Waiting for someone else to decide.</span>}
            </div>
          </div>
        ))}</div>}
      {act && <FormModal title={act.kind === 'approve' ? 'Approve' : 'Reject'} submitLabel={act.kind === 'approve' ? 'Approve' : 'Reject'} fields={[{ name: 'comment', label: act.kind === 'approve' ? 'Comment (optional)' : 'Why?', required: act.kind === 'reject' }]} onClose={() => setAct(null)} onSubmit={async (v) => { await api.post(`/approvals/${act.row.id}/${act.kind}`, v); toast.ok(act.kind === 'approve' ? 'Approved' : 'Rejected'); re(); }} />}
    </div>
  );
}

// ---------- notifications ----------
export function Notifications() {
  const [tab, setTab] = useState('inbox'); const [unread, setUnread] = useState(false); const qc = useQueryClient(); const toast = useToast();
  const list = usePagedList('/notifications', { unread: unread ? 'true' : undefined }, 25);
  const prefs = useQuery({ queryKey: ['prefs'], enabled: tab === 'prefs', queryFn: async () => (await api.list('/notifications/preferences')).items });
  const re = () => { void qc.invalidateQueries({ queryKey: ['list', '/notifications'] }); void qc.invalidateQueries({ queryKey: ['unread'] }); };
  const sev = { info: 'bg-sky-500', warning: 'bg-amber-500', critical: 'bg-red-600' } as Record<string, string>;
  return (
    <div>
      <PageHeader title="Notifications" actions={<ActionButton className="btn-ghost py-1 px-3 text-xs" run={async () => { await api.post('/notifications/read', { all: true }); re(); }}>Mark all read</ActionButton>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'inbox', label: 'Inbox' }, { id: 'prefs', label: 'What I get told about' }]} />
      <div className="mt-3">
        {tab === 'inbox' && <>
          <label className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"><input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={unread} onChange={(e) => setUnread(e.target.checked)} />Only unread</label>
          <div className="card overflow-hidden p-0 shadow-sm">{list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : !list.rows.length ? <Empty text="You are all caught up." /> : <>
            {list.rows.map((n) => (
              <div key={n.id} className={`flex items-start gap-3 border-b border-slate-100 p-3.5 last:border-0 transition-colors hover:bg-slate-50/60 dark:border-slate-800 dark:hover:bg-slate-800/40 ${n.is_read ? 'opacity-60' : ''}`}>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${sev[n.severity] ?? 'bg-slate-400'}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-slate-900 dark:text-white">{n.title}</div>
                  {n.body && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{n.body}</div>}
                  <div className="mt-1 text-[11px] text-slate-400">{dateTime(n.created_at)}</div>
                </div>
                {!n.is_read && <ActionButton className="btn-ghost py-1 px-2.5 text-xs" run={async () => { await api.post('/notifications/read', { ids: [n.id] }); re(); }}>Mark read</ActionButton>}
              </div>))}
            <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} /></>}</div></>}
        {tab === 'prefs' && (prefs.isLoading ? <Spinner /> : <div className="card overflow-hidden p-0 shadow-sm"><DataTable rows={prefs.data ?? []} columns={[{ key: 'type', header: 'Alert', render: (r) => label(r.type) },
          { key: 'inApp', header: 'In the app', render: (r) => <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={r.inApp} onChange={async (e) => { try { await api.put(`/notifications/preferences/${r.type}`, { inApp: e.target.checked, email: r.email }); void prefs.refetch(); } catch (x) { toast.error(x); } }} /> },
          { key: 'email', header: 'By email', render: (r) => <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={r.email} onChange={async (e) => { try { await api.put(`/notifications/preferences/${r.type}`, { inApp: r.inApp, email: e.target.checked }); void prefs.refetch(); } catch (x) { toast.error(x); } }} /> }]} /></div>)}
      </div>
    </div>
  );
}

// ---------- reports ----------
export function Reports() {
  const { branchId } = useBranch(); const toast = useToast();
  const cat = useQuery({ queryKey: ['report-catalog'], queryFn: async () => (await api.list('/reports')).items });
  const [code, setCode] = useState(''); const [p, setP] = useState<Row>({ period: 'this_month' }); const [all, setAll] = useState(true);
  useEffect(() => { if (!code && cat.data?.length) setCode(cat.data[0].code); }, [cat.data, code]);
  const def = cat.data?.find((r) => r.code === code);
  const query = { period: def?.ranged === false ? undefined : p.period, from: p.period === 'custom' ? p.from || undefined : undefined, to: p.period === 'custom' ? p.to || undefined : undefined, branchId: all ? undefined : branchId ?? undefined, limit: 500 };
  const run = useQuery({ queryKey: ['report', code, query], enabled: !!code, queryFn: () => api.get<Row>(`/reports/${code}`, query) });
  const groups = [...new Set((cat.data ?? []).map((r) => r.group))];
  return (
    <div>
      <PageHeader title="Reports" subtitle="Choose a report, a period, and download it if you need a copy." />
      {cat.isLoading ? <Spinner /> : cat.error ? <ErrorBox error={cat.error} /> : <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <div className="card space-y-3.5 self-start p-3.5 shadow-sm">
          {groups.map((g) => (
            <div key={g}>
              <div className="mb-1.5 px-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">{label(g)}</div>
              <div className="space-y-0.5">
                {cat.data!.filter((r) => r.group === g).map((r) => (
                  <button
                    key={r.code}
                    onClick={() => setCode(r.code)}
                    className={`block w-full rounded px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                      r.code === code
                        ? 'bg-brand-600 text-white shadow-xs font-semibold'
                        : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
                    }`}
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="min-w-0 space-y-3.5">
          {def && <>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">{def.title}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{def.description}</p>
            </div>
            <div className="flex flex-wrap items-end gap-3 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
              {def.ranged !== false && <PeriodPicker value={p} onChange={setP} />}
              <label className="flex items-center gap-1.5 pb-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={all} onChange={(e) => setAll(e.target.checked)} />
                All branches
              </label>
              <div className="flex-1" />
              <div className="flex items-center gap-1.5">
                {(['xlsx', 'pdf', 'csv'] as const).map((f) => (
                  <ActionButton key={f} className="btn-ghost py-1 px-2.5 text-xs font-bold" run={async () => { try { await api.download(`/reports/${code}/export`, { ...query, format: f }); } catch (e) { toast.error(e); } }}>
                    {f.toUpperCase()}
                  </ActionButton>
                ))}
              </div>
            </div>
            {run.isLoading ? <Spinner /> : run.error ? <ErrorBox error={run.error} /> : run.data && <>
              <p className="text-xs font-medium text-slate-500">{run.data.period ? `${run.data.period.from} to ${run.data.period.to}` : 'As of now'} · {(run.data.rows ?? []).length} records</p>
              <div className="card overflow-hidden p-0 shadow-sm"><ResultTable t={run.data} /></div>
            </>}
          </>}
        </div>
      </div>}
    </div>
  );
}
