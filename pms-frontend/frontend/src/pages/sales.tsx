import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { dateTime, label, money, today } from '../lib/format';
import { DocCfg, DocumentPage } from '../ui/documents';
import { ResourcePage } from '../ui/resource';
import { ActionButton, AutoTable, Badge, DataTable, Empty, ErrorBox, FieldDef, FormFields, FormModal, KeyValues, Modal, PageHeader, Pager, Spinner, usePagedList, useLookup, useToast, initialValues, cleanValues } from '../ui/kit';
import { listQueue, QueuedSale, removeQueued, uploadQueue, getDeviceId, useOnline, useQueueCount } from '../pos/offline';

const range: FieldDef[] = [{ name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }];

// ---------- sales history ----------
export function SalesPage() {
  const { branchId } = useBranch(); const { can } = useAuth();
  const [f, setF] = useState<Row>({ from: today(), to: today(), status: '' }); const [open, setOpen] = useState<string | null>(null);
  const query = { branchId: branchId ?? undefined, status: f.status || undefined, from: f.from || undefined, to: f.to || undefined };
  const list = usePagedList('/sales', query, 25);
  const sum = useQuery({ queryKey: ['sales-summary', query], queryFn: () => api.get<Row>('/sales/summary', { branchId: query.branchId, from: query.from, to: query.to }) });
  return (
    <div>
      <PageHeader title="Sales history" />
      <div className="mb-3 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <FormFields idPrefix="flt" values={f} setValues={setF} fields={[...range, { name: 'status', label: 'Status', type: 'select', options: ['completed', 'partially_returned', 'returned', 'cancelled'].map((v) => ({ value: v, label: label(v) })) }]} />
      </div>
      {sum.data && (
        <div className="mb-3 grid grid-cols-2 gap-2.5 md:grid-cols-5">
          {[['Sales', String(sum.data.sales)], ['Total', money(sum.data.total)], ['Tax', money(sum.data.tax)], ['On account', money(sum.data.credit)], ['Refunds', money(sum.data.refunds)]].map(([l, v]) => (
            <div key={l} className="card p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{l}</div>
              <div className="mt-1 text-lg font-bold text-slate-900 dark:text-white tabular-nums">{v}</div>
            </div>
          ))}
          {sum.data.grossProfit !== undefined && can('finance.read') && (
            <div key="gp" className="card p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Gross profit</div>
              <div className="mt-1 text-lg font-bold text-slate-900 dark:text-white tabular-nums">{money(sum.data.grossProfit)}</div>
            </div>
          )}
        </div>
      )}
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : (
          <>
            <DataTable onRowClick={(r) => setOpen(r.id)} rows={list.rows} columns={[{ key: 'reference_no', header: 'Receipt' }, { key: 'sold_at', header: 'Sold', type: 'datetime' }, { key: 'cashier_name', header: 'Cashier' }, { key: 'total', header: 'Total', type: 'money' }, { key: 'discount_total', header: 'Discount', type: 'money' }, { key: 'credit_total', header: 'On account', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }]} />
            <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} />
          </>
        )}
      </div>
      {open && <SaleDetail id={open} onClose={() => setOpen(null)} onChanged={() => void list.refetch()} />}
    </div>
  );
}
function SaleDetail({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => api.get<Row>(`/sales/${id}`) }); const { can } = useAuth(); const toast = useToast();
  const [receipt, setReceipt] = useState<string | null>(null); const [cancel, setCancel] = useState(false); const [ret, setRet] = useState(false);
  const d = q.data;
  return (
    <Modal wide title={d ? `Sale ${d.reference_no}` : 'Sale'} onClose={onClose} footer={d && <>
      <ActionButton className="btn-ghost" run={async () => { const r = await api.get(`/sales/${id}/receipt`); setReceipt(r.text); }}>Receipt</ActionButton>
      {can('sales.return') && ['completed', 'partially_returned'].includes(d.status) && <button className="btn-ghost" onClick={() => setRet(true)}>Take returns</button>}
      {can('sales.cancel') && d.status === 'completed' && <button className="btn-danger" onClick={() => setCancel(true)}>Cancel sale</button>}</>}>
      {q.isLoading || !d ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <div className="space-y-3">
        <div className="flex gap-2"><Badge value={d.status} />{d.offline_ref && <span className="text-xs text-slate-500">Offline sale {d.offline_ref}</span>}</div>
        <KeyValues data={d} skip={['items', 'payments', 'id', 'branch_id', 'register_id', 'cashier_id', 'customer_id', 'request_hash', 'idempotency_key', 'device_id', 'prescription_id', 'discount_request_id', 'version', 'max_discount_percent']} />
        <h3 className="font-semibold">Items</h3><DataTable rows={d.items} columns={[{ key: 'product_name', header: 'Product' }, { key: 'unit_code', header: 'Pack' }, { key: 'quantity', header: 'Qty', type: 'qty' }, { key: 'unit_price', header: 'Price', type: 'money' }, { key: 'discount_amount', header: 'Discount', type: 'money' }, { key: 'tax_amount', header: 'Tax', type: 'money' }, { key: 'line_total', header: 'Total', type: 'money' }]} />
        {d.payments?.length > 0 && <><h3 className="font-semibold">Payments</h3><AutoTable rows={d.payments} /></>}
      </div>}
      {receipt && <Modal title="Receipt" onClose={() => setReceipt(null)} footer={<button className="btn-primary" onClick={() => window.print()}>Print</button>}><pre className="print-area overflow-x-auto bg-white p-2 font-mono text-xs text-black">{receipt}</pre></Modal>}
      {cancel && <FormModal title="Cancel this sale" submitLabel="Cancel sale" fields={[{ name: 'reason', label: 'Reason', required: true, type: 'textarea' }]} onClose={() => setCancel(false)} onSubmit={async (v) => { const r = await api.post(`/sales/${id}/cancel`, v); toast.ok(r?.status === 'pending_cancel_approval' ? 'Sent to a manager for approval' : 'Sale cancelled'); void q.refetch(); onChanged(); }} />}
      {ret && d && <ReturnForm sale={d} onClose={() => setRet(false)} onDone={() => { void q.refetch(); onChanged(); }} />}
    </Modal>
  );
}
function ReturnForm({ sale, onClose, onDone }: { sale: Row; onClose(): void; onDone(): void }) {
  const methods = useLookup('/payment-methods'); const toast = useToast();
  const [qty, setQty] = useState<Record<string, string>>({}); const [reason, setReason] = useState(''); const [method, setMethod] = useState('cash'); const [ref, setRef] = useState('');
  const chosen = Object.entries(qty).filter(([, v]) => v && Number(v) > 0);
  return (
    <Modal wide title={`Return items · ${sale.reference_no}`} onClose={onClose} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button>
      <ActionButton className="btn-primary" disabled={!chosen.length || reason.trim().length < 3} run={async () => { await api.post('/sales-returns', { saleId: sale.id, reason, refundMethodCode: method, ...(ref ? { refundReference: ref } : {}), items: chosen.map(([saleItemId, quantity]) => ({ saleItemId, quantity })) }); toast.ok('Return recorded. The goods wait for inspection before going back on sale.'); onDone(); onClose(); }}>Record return</ActionButton></>}>
      <table className="min-w-full text-sm"><thead><tr><th className="th">Product</th><th className="th text-right">Sold</th><th className="th text-right">Already returned</th><th className="th w-28">Return qty</th></tr></thead><tbody>
        {sale.items.map((i: Row) => <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td">{i.product_name} <span className="text-xs text-slate-500">({i.unit_code})</span></td><td className="td text-right">{Number(i.quantity)}</td><td className="td text-right">{Number(i.returned_quantity ?? 0)}</td><td className="td"><input className="input py-1" inputMode="decimal" value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></td></tr>)}
      </tbody></table>
      <div className="mt-3 grid gap-3 sm:grid-cols-3"><div className="sm:col-span-3"><label className="label">Reason</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div><label className="label">Refund by</label><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{(methods.data ?? []).filter((m) => m.is_active).map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}</select></div>
        <div><label className="label">Refund reference</label><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></div></div>
    </Modal>
  );
}

// ---------- returns ----------
function InspectPanel({ doc, reload }: { doc: Row; reload(): void }) {
  const { can } = useAuth(); const toast = useToast();
  const pending = (doc.items ?? []).filter((i: Row) => i.disposition === 'pending');
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (doc.status !== 'posted' || !pending.length || !can('sales.return_inspect')) return null;
  return (
    <div className="space-y-2 rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900 shadow-xs"><h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 dark:text-slate-200">Inspect returned goods</h3>
      <p className="text-xs text-slate-500">Good items go back on sale. Damaged items are written off. A different person from the one who took the goods back must inspect.</p>
      {pending.map((i: Row) => <div key={i.id} className="flex items-center justify-between gap-2 text-sm"><span>{i.product_name} × {Number(i.quantity)}</span><select className="input w-40" value={choice[i.id] ?? ''} onChange={(e) => setChoice({ ...choice, [i.id]: e.target.value })}><option value="">Decide…</option><option value="resale">Can be sold again</option><option value="damaged">Damaged</option></select></div>)}
      <ActionButton className="btn-primary" disabled={!Object.values(choice).some(Boolean)} run={async () => { await api.post(`/sales-returns/${doc.id}/inspect`, { items: Object.entries(choice).filter(([, v]) => v).map(([itemId, disposition]) => ({ itemId, disposition })) }); toast.ok('Inspection saved'); reload(); }}>Save inspection</ActionButton></div>
  );
}
export const ReturnsPage = () => <DocumentPage cfg={{
  title: 'Customer returns', subtitle: 'To take something back, open the sale in Sales history and choose “Take returns”.', path: '/sales-returns', statuses: ['pending_approval', 'posted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'sale_reference', header: 'Sale' }, { key: 'refund_total', header: 'Refund', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Date', type: 'datetime' }],
  extra: (d, reload) => <InspectPanel doc={d} reload={reload} />,
  actions: [{ label: 'Cancel', path: (d) => `/sales-returns/${d.id}/cancel`, permission: 'sales.return', show: (d) => d.status === 'pending_approval', confirm: 'Cancel this return?', danger: true }],
} as DocCfg} />;

// ---------- customers ----------
function Statement({ c, onClose }: { c: Row; onClose(): void }) {
  const [f, setF] = useState<Row>({ from: '', to: '' });
  const q = useQuery({ queryKey: ['statement', c.id, f], queryFn: () => api.get<Row>(`/customers/${c.id}/statement`, { from: f.from || undefined, to: f.to || undefined }) });
  return (
    <Modal wide title={`Statement · ${c.name}`} onClose={onClose} footer={<button className="btn-ghost" onClick={() => window.print()}>Print</button>}>
      <div className="mb-3 grid max-w-md grid-cols-2 gap-3"><FormFields idPrefix="flt" fields={range} values={f} setValues={setF} /></div>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : q.data && <div className="print-area space-y-2">
        <div className="flex gap-6 text-sm"><span>Opening: <b>{money(q.data.openingBalance)}</b></span><span>Closing: <b>{money(q.data.closingBalance)}</b></span><span>Owing now: <b>{money(q.data.currentBalance)}</b></span></div>
        <DataTable rows={q.data.lines ?? []} columns={[{ key: 'date', header: 'Date', type: 'date' }, { key: 'type', header: 'Type', render: (r) => label(r.type) }, { key: 'reference', header: 'Reference' }, { key: 'note', header: 'Note' }, { key: 'charge', header: 'Charged', type: 'money' }, { key: 'payment', header: 'Paid', type: 'money' }, { key: 'balance', header: 'Balance', type: 'money' }]} /></div>}
    </Modal>
  );
}
function CustomerPayments({ c, onClose, onDone }: { c: Row; onClose(): void; onDone(): void }) {
  const { branchId } = useBranch(); const { can } = useAuth(); const toast = useToast(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cust-pay', c.id], queryFn: async () => (await api.list(`/customers/${c.id}/payments`)).items });
  const [adding, setAdding] = useState(false); const [rev, setRev] = useState<Row | null>(null);
  const re = () => { void qc.invalidateQueries({ queryKey: ['cust-pay', c.id] }); onDone(); };
  return (
    <Modal wide title={`Payments · ${c.name} (owes ${money(c.balance)})`} onClose={onClose} footer={can('customers.payment') && <button className="btn-primary" onClick={() => setAdding(true)}>Record payment</button>}>
      {q.isLoading ? <Spinner /> : <DataTable rows={q.data ?? []} empty="No payments yet." columns={[{ key: 'reference_no', header: 'Reference' }, { key: 'received_at', header: 'Received', type: 'datetime' }, { key: 'method_code', header: 'Method' }, { key: 'amount', header: 'Amount', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }, { key: '_', header: '', render: (r) => can('customers.payment_reverse') && r.status === 'posted' ? <button className="btn-ghost py-1" onClick={() => setRev(r)}>Reverse</button> : null }]} />}
      {adding && <FormModal title="Record payment" fields={[{ name: 'methodCode', label: 'Method', type: 'lookup', lookup: { path: '/payment-methods', value: 'code', filter: (r) => r.is_active && !r.is_credit }, required: true, default: 'cash' }, { name: 'amount', label: 'Amount', type: 'decimal', required: true }, { name: 'reference', label: 'Reference' }]} onClose={() => setAdding(false)} onSubmit={async (v) => { await api.post(`/customers/${c.id}/payments`, { ...v, branchId }); toast.ok('Payment recorded'); re(); }} />}
      {rev && <FormModal title={`Reverse ${rev.reference_no}`} fields={[{ name: 'reason', label: 'Reason', required: true }]} onClose={() => setRev(null)} onSubmit={async (v) => { await api.post(`/customer-payments/${rev.id}/reverse`, v); toast.ok('Reversed'); re(); }} />}
    </Modal>
  );
}
export function CustomersPage() {
  const [st, setSt] = useState<Row | null>(null); const [pay, setPay] = useState<Row | null>(null); const { can } = useAuth();
  const fields: FieldDef[] = [{ name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address' }, { name: 'creditLimit', label: 'Credit limit', type: 'decimal', help: 'Most this customer may owe. Empty or 0 = no credit.' }, { name: 'notes', label: 'Notes', type: 'textarea' }];
  return <>
    <ResourcePage cfg={{
      title: 'Customers', path: '/customers', searchable: true,
      filters: [{ name: 'owing', label: 'Show', type: 'select', options: [{ value: 'true', label: 'Only those who owe' }] }],
      columns: [{ key: 'code', header: 'No.' }, { key: 'name', header: 'Name' }, { key: 'phone', header: 'Phone' }, { key: 'credit_limit', header: 'Credit limit', type: 'money' }, { key: 'balance', header: 'Owes', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }],
      create: { permission: 'customers.manage', fields }, edit: { permission: 'customers.manage', fields: [...fields, { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }] },
      rowActions: (r) => <><button className="btn-ghost py-1" onClick={() => setSt(r)}>Statement</button>{can('customers.read') && <button className="btn-ghost py-1" onClick={() => setPay(r)}>Payments</button>}</>, detail: false,
    }} />
    {st && <Statement c={st} onClose={() => setSt(null)} />}
    {pay && <CustomerPayments c={pay} onClose={() => setPay(null)} onDone={() => undefined} />}
  </>;
}

// ---------- prescriptions ----------
function RxAttachment({ doc, reload }: { doc: Row; reload(): void }) {
  const toast = useToast(); const [file, setFile] = useState<File | null>(null); const { can } = useAuth();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">Scan / photo:</span>
      {doc.has_attachment && <ActionButton className="btn-ghost py-1" run={async () => { const { blob } = await api.blob(`/prescriptions/${doc.id}/attachment`); window.open(URL.createObjectURL(blob), '_blank'); }}>View</ActionButton>}
      {can('prescriptions.manage') && !['fulfilled', 'cancelled'].includes(doc.status) && <><input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><ActionButton className="btn-ghost py-1" disabled={!file} run={async () => { await api.upload('PUT', `/prescriptions/${doc.id}/attachment`, file!); toast.ok('Saved'); reload(); }}>Upload</ActionButton></>}
    </div>
  );
}
export function PrescriptionsPage() {
  const { branchId } = useBranch();
  return <DocumentPage cfg={{
    title: 'Prescriptions', subtitle: 'Record a prescription, have a pharmacist validate it, then sell against it at the till.', path: '/prescriptions', statuses: ['pending_validation', 'valid', 'rejected', 'fulfilled', 'cancelled'],
    columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'patient_name', header: 'Patient' }, { key: 'prescriber_name', header: 'Prescriber' }, { key: 'prescribed_date', header: 'Date', type: 'date' }, { key: 'status', header: 'Status', type: 'badge' }],
    create: {
      permission: 'prescriptions.manage', title: 'Record prescription',
      header: [{ name: 'branchId', label: 'Branch', type: 'lookup', lookup: { path: '/branches' }, required: true, default: branchId ?? '' }, { name: 'patientName', label: 'Patient name', required: true }, { name: 'patientBirthDate', label: 'Date of birth', type: 'date' }, { name: 'patientPhone', label: 'Patient phone' }, { name: 'customerId', label: 'Customer record', type: 'lookup', lookup: { path: '/customers' } }, { name: 'prescriberName', label: 'Prescriber', required: true }, { name: 'prescriberLicenseNo', label: 'Prescriber licence no.' }, { name: 'facility', label: 'Clinic / hospital' }, { name: 'prescribedDate', label: 'Date prescribed', type: 'date', required: true, default: today() }, { name: 'notes', label: 'Notes', type: 'textarea' }],
      lines: { label: 'Medicines', fields: [{ name: 'quantity', label: 'Quantity', type: 'decimal', required: true }, { name: 'dosage', label: 'Dosage' }, { name: 'frequency', label: 'How often' }, { name: 'duration', label: 'For how long' }] },
      build: (h, lines) => ({ ...h, items: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.quantity, ...(l.dosage ? { dosage: l.dosage } : {}), ...(l.frequency ? { frequency: l.frequency } : {}), ...(l.duration ? { duration: l.duration } : {}) })) }),
    },
    extra: (d, reload) => <RxAttachment doc={d} reload={reload} />,
    actions: [
      { label: 'Validate', path: (d) => `/prescriptions/${d.id}/validate`, permission: 'prescriptions.validate', show: (d) => d.status === 'pending_validation', confirm: 'Confirm this prescription is genuine and complete?', body: () => ({}) },
      { label: 'Reject', path: (d) => `/prescriptions/${d.id}/reject`, permission: 'prescriptions.validate', show: (d) => d.status === 'pending_validation', danger: true, fields: [{ name: 'reason', label: 'Reason', required: true }] },
      { label: 'Cancel', path: (d) => `/prescriptions/${d.id}/cancel`, permission: 'prescriptions.manage', show: (d) => ['pending_validation', 'valid'].includes(d.status), confirm: 'Cancel this prescription?', danger: true, body: () => ({}) },
    ],
  } as DocCfg} />;
}

// ---------- register session ----------
export function RegisterSessionPage() {
  const { branchId } = useBranch(); const toast = useToast(); const qc = useQueryClient();
  const regs = useQuery({ queryKey: ['regs', branchId], enabled: !!branchId, queryFn: async () => (await api.list('/cash-registers', { branchId: branchId! })).items.filter((r) => r.status === 'active') });
  const [reg, setReg] = useState(localStorage.getItem('pms.pos.register') ?? '');
  useEffect(() => { if (regs.data?.length && !regs.data.some((r) => r.id === reg)) setReg(regs.data[0].id); }, [regs.data, reg]);
  const cur = useQuery({ queryKey: ['session', reg], enabled: !!reg, queryFn: async () => (await api.get<Row | null>(`/finance/register-sessions/current/${reg}`)) ?? null });
  const [amount, setAmount] = useState(''); const [counted, setCounted] = useState(''); const [note, setNote] = useState(''); const [result, setResult] = useState<Row | null>(null);
  const s = cur.data && (cur.data as Row).id ? (cur.data as Row) : null;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['session', reg] });
  return (
    <div className="max-w-2xl">
      <PageHeader title="Cash register" subtitle="Open the till before selling and close it at the end of the shift." />
      <div className="mb-4 max-w-xs"><label className="label">Register</label><select className="input" value={reg} onChange={(e) => { setReg(e.target.value); localStorage.setItem('pms.pos.register', e.target.value); }}>{(regs.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
      {cur.isLoading ? <Spinner /> : cur.error ? <ErrorBox error={cur.error} /> : !s ? (
        <div className="card space-y-4 max-w-md"><p className="font-semibold text-slate-800 dark:text-slate-200">No session is open on this register.</p><div className="max-w-xs"><label className="label">Cash in drawer now</label><input className="input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <ActionButton className="btn-primary" disabled={!/^\d+(\.\d{1,4})?$/.test(amount)} run={async () => { await api.post('/finance/register-sessions', { registerId: reg, openingAmount: amount }); toast.ok('Register opened'); setAmount(''); refresh(); }}>Open register</ActionButton></div>
      ) : (
        <div className="card space-y-4"><div className="flex items-center gap-2.5 pb-2 border-b border-slate-100 dark:border-slate-800"><Badge value="open" /><span className="text-xs font-medium text-slate-500">Since {dateTime(s.opened_at)}</span></div>
          <KeyValues data={s} skip={['id', 'register_id', 'branch_id', 'version', 'opened_by']} />
          <div className="grid gap-3.5 sm:grid-cols-2"><div><label className="label">Cash counted in the drawer</label><input className="input" inputMode="decimal" placeholder="0.00" value={counted} onChange={(e) => setCounted(e.target.value)} /></div><div><label className="label">Note</label><input className="input" placeholder="Optional notes…" value={note} onChange={(e) => setNote(e.target.value)} /></div></div>
          <ActionButton className="btn-primary" disabled={!/^\d+(\.\d{1,4})?$/.test(counted)} confirm="Close the register? You cannot sell on it until it is opened again." run={async () => { const r = await api.post(`/finance/register-sessions/${s.id}/close`, { countedAmount: counted, ...(note ? { note } : {}) }); setResult(r); setCounted(''); refresh(); }}>Close register</ActionButton></div>
      )}
      {result && <Modal title="Register closed" onClose={() => setResult(null)}><KeyValues data={result} skip={['id', 'register_id', 'branch_id', 'version']} /></Modal>}
    </div>
  );
}

// ---------- offline sales on this tablet ----------
export function OfflinePage() {
  const online = useOnline(); const count = useQueueCount(); const toast = useToast(); const { branchId } = useBranch();
  const [rows, setRows] = useState<QueuedSale[]>([]);
  useEffect(() => { void listQueue().then(setRows); }, [count]);
  const mine = useQuery({ queryKey: ['my-conflicts'], enabled: online, queryFn: async () => (await api.list('/sync/my-conflicts')).items });
  const reg = localStorage.getItem('pms.pos.register') ?? '';
  return (
    <div>
      <PageHeader title="Offline sales" subtitle="Sales made without a connection are kept on this tablet and uploaded automatically." actions={<ActionButton className="btn-primary" disabled={!online || !rows.length} run={async () => { const dev = await getDeviceId(reg); if (!dev) throw new Error('This tablet has not been set up. Open the point of sale once while online.'); const r = await uploadQueue(dev); toast.ok(`${r.synced} uploaded${r.conflicts ? `, ${r.conflicts} need attention` : ''}`); setRows(await listQueue()); void mine.refetch(); }}>Upload now</ActionButton>} />
      <div className="card mb-4 overflow-hidden p-0 shadow-sm">{rows.length === 0 ? <Empty text="Nothing waiting on this tablet." /> : <DataTable rows={rows as unknown as Row[]} columns={[{ key: 'offlineRef', header: 'Ref' }, { key: 'queuedAt', header: 'Made', render: (r) => dateTime(r.queuedAt) }, { key: 'summary', header: 'Total', render: (r) => money(r.summary?.total ?? 0) }, { key: 'state', header: 'State', type: 'badge' }, { key: 'message', header: 'Problem' }, { key: '_', header: '', render: (r) => r.state !== 'waiting' ? <ActionButton className="btn-ghost py-1" confirm="Remove this sale from the tablet? It will never be recorded." run={async () => { await removeQueued(r.offlineRef); setRows(await listQueue()); }}>Discard</ActionButton> : null }]} />}</div>
      <h2 className="mb-2 text-sm font-bold text-slate-900 dark:text-white">Problems reported by the server</h2>
      <div className="card overflow-hidden p-0 shadow-sm">{mine.isLoading ? <Spinner /> : !mine.data?.length ? <Empty text="No problems reported." /> : <DataTable rows={mine.data} columns={[{ key: 'offline_ref', header: 'Ref' }, { key: 'code', header: 'Problem', type: 'badge' }, { key: 'message', header: 'Detail' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'When', type: 'datetime' }]} />}</div>
      <p className="mt-2 text-xs text-slate-500">A manager can retry or dismiss these under Setup → Offline sale problems.{branchId ? '' : ''}</p>
    </div>
  );
}
