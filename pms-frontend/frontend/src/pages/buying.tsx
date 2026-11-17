import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { label, money, today } from '../lib/format';
import { DocCfg, DocumentPage } from '../ui/documents';
import { ResourcePage } from '../ui/resource';
import { ActionButton, DataTable, Empty, ErrorBox, FieldDef, FormFields, FormModal, KeyValues, Modal, PageHeader, Spinner, Tabs, useLookup, useToast, initialValues } from '../ui/kit';
import { BatchSelect, Line } from '../ui/lines';

const whLookup = { path: '/warehouses', label: (r: Row) => r.name };
const supLookup = { path: '/suppliers' };
const qtyField: FieldDef = { name: 'quantity', label: 'Quantity', type: 'decimal', required: true };
const decimalRe = /^\d+(\.\d{1,4})?$/;

// ---------- suppliers ----------
function SupplierView({ s, onClose }: { s: Row; onClose(): void }) {
  const [tab, setTab] = useState('statement'); const { can } = useAuth();
  const bal = useQuery({ queryKey: ['sup-bal', s.id], queryFn: () => api.get<Row>(`/suppliers/${s.id}/balance`) });
  const st = useQuery({ queryKey: ['sup-st', s.id], enabled: tab === 'statement', queryFn: () => api.get<Row>(`/suppliers/${s.id}/statement`) });
  const perf = useQuery({ queryKey: ['sup-perf', s.id], enabled: tab === 'perf', queryFn: () => api.get<Row>(`/suppliers/${s.id}/performance`) });
  const prods = useQuery({ queryKey: ['sup-prod', s.id], enabled: tab === 'products', queryFn: async () => (await api.list(`/suppliers/${s.id}/products`)).items });
  return (
    <Modal wide title={s.name} onClose={onClose}>
      {bal.data && <div className="mb-3"><KeyValues data={bal.data} /></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'statement', label: 'Statement' }, { id: 'perf', label: 'Performance' }, { id: 'products', label: 'Products supplied' }, { id: 'info', label: 'Details' }]} />
      <div className="mt-3">
        {tab === 'statement' && (st.isLoading ? <Spinner /> : st.error ? <ErrorBox error={st.error} /> : <DataTable rows={st.data?.lines ?? st.data?.rows ?? []} empty="No activity." columns={[{ key: 'date', header: 'Date', type: 'date' }, { key: 'type', header: 'Type', render: (r) => label(r.type ?? r.entry_type ?? '') }, { key: 'reference', header: 'Reference', render: (r) => r.reference ?? r.reference_no }, { key: 'debit', header: 'Debit', type: 'money' }, { key: 'credit', header: 'Credit', type: 'money' }, { key: 'balance', header: 'Balance', type: 'money' }]} />)}
        {tab === 'perf' && (perf.isLoading ? <Spinner /> : perf.error ? <ErrorBox error={perf.error} /> : <KeyValues data={perf.data ?? {}} />)}
        {tab === 'products' && (prods.isLoading ? <Spinner /> : <DataTable rows={prods.data ?? []} empty="Nothing recorded yet. This fills in as you buy." columns={[{ key: 'sku', header: 'SKU' }, { key: 'name', header: 'Product', render: (r) => r.name ?? r.product_name }, { key: 'supplier_sku', header: 'Their code' }, { key: 'last_price', header: 'Last price', type: 'money' }]} />)}
        {tab === 'info' && <KeyValues data={s} />}
      </div>
      {can('suppliers.manage') ? null : null}
    </Modal>
  );
}
export function SuppliersPage() {
  const [v, setV] = useState<Row | null>(null);
  const fields: FieldDef[] = [{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code' }, { name: 'contactPerson', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address' }, { name: 'taxId', label: 'TIN' }, { name: 'registrationNo', label: 'Trade licence no.' }, { name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', min: 0 }, { name: 'creditLimit', label: 'Credit limit', type: 'decimal' }, { name: 'bankDetails', label: 'Bank details', type: 'textarea' }];
  return <>
    <ResourcePage cfg={{
      title: 'Suppliers', path: '/suppliers', searchable: true, filters: [{ name: 'status', label: 'Status', type: 'select', options: ['active', 'inactive', 'blocked'].map((x) => ({ value: x, label: label(x) })) }],
      columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'phone', header: 'Phone' }, { key: 'payment_terms_days', header: 'Terms (days)', align: 'right' }, { key: 'status', header: 'Status', type: 'badge' }],
      create: { permission: 'suppliers.manage', fields }, edit: { permission: 'suppliers.manage', fields: [...fields.filter((f) => f.name !== 'code'), { name: 'status', label: 'Status', type: 'select', options: ['active', 'inactive', 'blocked'].map((x) => ({ value: x, label: label(x) })) }] },
      rowActions: (r) => <button className="btn-ghost py-1" onClick={() => setV(r)}>Account</button>, detail: false,
    }} />
    {v && <SupplierView s={v} onClose={() => setV(null)} />}
  </>;
}

// ---------- reorder suggestions → request ----------
export function ReorderPage() {
  const { branchId } = useBranch(); const { can } = useAuth(); const toast = useToast();
  const q = useQuery({ queryKey: ['reorder', branchId], enabled: !!branchId, queryFn: async () => (await api.list('/procurement/reorder-suggestions', { branchId: branchId ?? undefined })).items });
  const wh = useLookup('/warehouses'); const [sel, setSel] = useState<Record<string, string>>({}); const [warehouseId, setWarehouseId] = useState('');
  const myWh = (wh.data ?? []).filter((w) => w.branch_id === branchId);
  const chosen = Object.entries(sel).filter(([, v]) => decimalRe.test(v) && Number(v) > 0);
  return (
    <div>
      <PageHeader title="What to reorder" subtitle="Products at or below their reorder level, with a suggested quantity. Tick what you want and make a purchase request." />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : !q.data?.length ? <div className="card"><Empty text="Nothing needs reordering." /></div> : <>
        <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800"><table className="min-w-full"><thead><tr><th className="th" /><th className="th">Product</th><th className="th text-right">Available</th><th className="th text-right">Reorder level</th><th className="th text-right">Suggested</th><th className="th w-28">Order qty (base)</th></tr></thead><tbody>
          {q.data.map((r) => { const id = r.product_id; return <tr key={id} className="border-t border-slate-100 hover:bg-slate-50/70 transition-colors dark:border-slate-800 dark:hover:bg-slate-800/40"><td className="td"><input type="checkbox" checked={id in sel} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[id] = String(Number(r.suggested_base_quantity ?? 0) || ''); else delete n[id]; setSel(n); }} /></td><td className="td font-medium">{r.name ?? r.product_name}<div className="text-xs text-slate-500">{r.sku}</div></td><td className="td text-right tabular-nums">{Number(r.available ?? r.on_hand ?? 0)}</td><td className="td text-right tabular-nums">{Number(r.reorder_level ?? 0)}</td><td className="td text-right tabular-nums font-semibold text-brand-700 dark:text-brand-300">{Number(r.suggested_base_quantity ?? 0)}</td><td className="td">{id in sel && <input className="input py-1 font-semibold" inputMode="decimal" value={sel[id]} onChange={(e) => setSel({ ...sel, [id]: e.target.value })} />}</td></tr>; })}
        </tbody></table></div>
        {can('procurement.request') && <div className="mt-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900"><div><label className="label">Deliver to</label><select className="input" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}><option value="">Select warehouse…</option>{myWh.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
          <ActionButton className="btn-primary" disabled={!chosen.length || !warehouseId} run={async () => { await api.post('/purchase-requests', { warehouseId, items: chosen.map(([productId, quantity]) => ({ productId, quantity })) }); toast.ok('Purchase request created'); setSel({}); }}>Create purchase request</ActionButton></div>}
      </>}
    </div>
  );
}

// ---------- requests / orders ----------
export const PurchaseRequestsPage = () => <DocumentPage cfg={{
  title: 'Purchase requests', subtitle: 'Ask for stock to be bought. A manager approves, then it becomes an order.', path: '/purchase-requests', statuses: ['pending_approval', 'approved', 'converted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'warehouse_id', header: 'Warehouse', render: (r) => <Wh id={r.warehouse_id} /> }, { key: 'needed_by', header: 'Needed by', type: 'date' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Created', type: 'datetime' }],
  create: { permission: 'procurement.request', header: [{ name: 'warehouseId', label: 'Deliver to', type: 'lookup', lookup: whLookup, required: true }, { name: 'neededBy', label: 'Needed by', type: 'date' }, { name: 'note', label: 'Note', span: 2 }], lines: { purchasable: true, fields: [qtyField, { name: 'note', label: 'Note' }] }, build: (h, lines) => ({ ...h, items: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.quantity, ...(l.note ? { note: l.note } : {}) })) }) },
  actions: [{ label: 'Cancel', path: (d) => `/purchase-requests/${d.id}/cancel`, permission: 'procurement.request', show: (d) => ['pending_approval', 'approved'].includes(d.status), confirm: 'Cancel this request?', danger: true }],
} as DocCfg} />;
function Wh({ id }: { id: string }) { const w = useLookup('/warehouses'); return <>{w.data?.find((x) => x.id === id)?.name ?? '…'}</>; }

function Matching({ doc }: { doc: Row }) {
  const q = useQuery({ queryKey: ['po-match', doc.id], queryFn: () => api.get<Row>(`/purchase-orders/${doc.id}/matching`), enabled: doc.status !== 'draft' });
  if (doc.status === 'draft' || !q.data) return null;
  return <div><h3 className="mb-1 text-sm font-semibold">Three-way match (ordered · received · invoiced)</h3><KeyValues data={q.data} /></div>;
}
export const PurchaseOrdersPage = () => <DocumentPage cfg={{
  title: 'Purchase orders', path: '/purchase-orders', statuses: ['draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled', 'rejected'],
  filters: [{ name: 'supplierId', label: 'Supplier', type: 'lookup', lookup: supLookup }],
  columns: [{ key: 'reference_no', header: 'Order' }, { key: 'supplier_name', header: 'Supplier' }, { key: 'order_date', header: 'Date', type: 'date' }, { key: 'expected_date', header: 'Expected', type: 'date' }, { key: 'total', header: 'Total', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }],
  create: { permission: 'procurement.order', title: 'New purchase order', note: 'Prices are for the pack you choose. Tax is added from the product’s tax category.', header: [{ name: 'supplierId', label: 'Supplier', type: 'lookup', lookup: supLookup, required: true }, { name: 'warehouseId', label: 'Deliver to', type: 'lookup', lookup: whLookup, required: true }, { name: 'orderDate', label: 'Order date', type: 'date', default: today() }, { name: 'expectedDate', label: 'Expected on', type: 'date' }, { name: 'note', label: 'Note', span: 2 }], lines: { purchasable: true, fields: [qtyField, { name: 'unitPrice', label: 'Price per pack', type: 'decimal', required: true }] }, build: (h, lines) => ({ ...h, items: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.quantity, unitPrice: l.unitPrice })) }) },
  extra: (d) => <Matching doc={d} />,
  actions: [
    { label: 'Submit for approval', path: (d) => `/purchase-orders/${d.id}/submit`, permission: 'procurement.order', show: (d) => d.status === 'draft', body: () => ({}) },
    { label: 'Close order', path: (d) => `/purchase-orders/${d.id}/close`, permission: 'procurement.order', show: (d) => d.status === 'partially_received', fields: [{ name: 'reason', label: 'Why close with items outstanding?', required: true }] },
    { label: 'Cancel order', path: (d) => `/purchase-orders/${d.id}/cancel`, permission: 'procurement.order', show: (d) => ['draft', 'pending_approval', 'approved'].includes(d.status), danger: true, fields: [{ name: 'reason', label: 'Reason', required: true }] },
  ],
} as DocCfg} />;

// ---------- goods receipts ----------
type RecvRow = { qty: string; batch: string; expiry: string; made: string };
function ReceiveForm({ close, done }: { close(): void; done(r?: Row): void }) {
  const [poId, setPoId] = useState(''); const toast = useToast();
  const pos = useQuery({ queryKey: ['recv-pos'], queryFn: async () => (await api.list('/purchase-orders', { pageSize: 100 })).items.filter((o) => ['approved', 'partially_received'].includes(o.status)) });
  const po = useQuery({ queryKey: ['recv-po', poId], enabled: !!poId, queryFn: () => api.get<Row>(`/purchase-orders/${poId}`) });
  const [rows, setRows] = useState<Record<string, RecvRow>>({}); const [dn, setDn] = useState(''); const [note, setNote] = useState(''); const [err, setErr] = useState<unknown>(null);
  const items: Row[] = po.data?.items ?? [];
  const get = (id: string): RecvRow => rows[id] ?? { qty: '', batch: '', expiry: '', made: '' };
  const put = (id: string, p: Partial<RecvRow>) => setRows({ ...rows, [id]: { ...get(id), ...p } });
  const chosen = items.filter((i) => Number(get(i.id).qty) > 0);
  const ready = chosen.length > 0 && chosen.every((i) => decimalRe.test(get(i.id).qty) && get(i.id).batch.trim() && get(i.id).expiry);
  return (
    <Modal wide title="Receive goods" onClose={close} footer={<><button className="btn-ghost" onClick={close}>Cancel</button>
      <ActionButton className="btn-primary" disabled={!ready} run={async () => { try { setErr(null); const r = await api.post('/goods-receipts', { purchaseOrderId: poId, ...(dn ? { deliveryNoteNo: dn } : {}), ...(note ? { note } : {}), items: chosen.map((i) => ({ orderItemId: i.id, quantity: get(i.id).qty, unitId: i.unit_id, batchRef: get(i.id).batch.trim(), expiryDate: get(i.id).expiry, ...(get(i.id).made ? { manufactureDate: get(i.id).made } : {}) })) }); toast.ok('Goods received. They count as stock once inspected.'); done(r); } catch (e) { setErr(e); throw e; } }}>Save receipt</ActionButton></>}>
      {err ? <div className="mb-3"><ErrorBox error={err} /></div> : null}
      <div className="grid gap-3 sm:grid-cols-3"><div className="sm:col-span-3"><label className="label">Purchase order</label><select className="input" value={poId} onChange={(e) => { setPoId(e.target.value); setRows({}); }}><option value="">Select an approved order…</option>{pos.data?.map((o) => <option key={o.id} value={o.id}>{o.reference_no} · {o.supplier_name} · {money(o.total)}</option>)}</select></div>
        <div><label className="label">Delivery note no.</label><input className="input" value={dn} onChange={(e) => setDn(e.target.value)} /></div><div className="sm:col-span-2"><label className="label">Note</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div></div>
      {po.isLoading && <Spinner />}
      {items.length > 0 && <div className="mt-3 overflow-x-auto"><table className="min-w-full text-sm"><thead><tr><th className="th">Product</th><th className="th text-right">Ordered</th><th className="th text-right">Still to come (base)</th><th className="th w-24">Received</th><th className="th">Batch no.</th><th className="th">Expiry</th><th className="th">Made on</th></tr></thead><tbody>
        {items.map((i) => <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td">{i.product_name}</td><td className="td text-right">{Number(i.quantity)} {i.unit_code}</td><td className="td text-right">{Number(i.outstanding_base)}</td>
          <td className="td"><input className="input py-1" inputMode="decimal" aria-label="Quantity received" value={get(i.id).qty} onChange={(e) => put(i.id, { qty: e.target.value })} /></td>
          <td className="td"><input className="input py-1" aria-label="Batch number" value={get(i.id).batch} onChange={(e) => put(i.id, { batch: e.target.value })} /></td>
          <td className="td"><input type="date" className="input py-1" aria-label="Expiry date" value={get(i.id).expiry} onChange={(e) => put(i.id, { expiry: e.target.value })} /></td>
          <td className="td"><input type="date" className="input py-1" aria-label="Manufacture date" value={get(i.id).made} onChange={(e) => put(i.id, { made: e.target.value })} /></td></tr>)}
      </tbody></table><p className="mt-2 text-xs text-slate-500">Received is counted in the pack you ordered ({items[0]?.unit_code}). Leave the quantity empty for lines that did not arrive. Batch number and expiry come from the box.</p></div>}
    </Modal>
  );
}
function InspectReceipt({ doc, reload }: { doc: Row; reload(): void }) {
  const { can } = useAuth(); const toast = useToast(); const [acc, setAcc] = useState<Record<string, string>>({}); const [why, setWhy] = useState<Record<string, string>>({});
  if (!can('procurement.inspect') || doc.status !== 'pending_inspection') return null;
  const items: Row[] = doc.items ?? [];
  return (
    <div className="space-y-3 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900"><h3 className="font-bold text-xs uppercase tracking-wider text-slate-800 dark:text-slate-200">Inspect delivery</h3>
      <p className="text-xs text-slate-500">Check the goods against the order. Accepted goods become available stock; anything rejected is held for return to the supplier. The person who received the goods cannot inspect them.</p>
      {items.map((i) => <div key={i.id} className="grid grid-cols-[1fr_7rem_1fr] items-center gap-2 text-xs"><span>{i.product_name} · batch {i.batch_ref} · {Number(i.received_base)} received</span><input className="input py-1" placeholder="Accepted" inputMode="decimal" value={acc[i.id] ?? ''} onChange={(e) => setAcc({ ...acc, [i.id]: e.target.value })} /><input className="input py-1" placeholder="Reason if rejecting any" value={why[i.id] ?? ''} onChange={(e) => setWhy({ ...why, [i.id]: e.target.value })} /></div>)}
      <div className="flex justify-end gap-2 pt-1 border-t border-slate-100 dark:border-slate-800">
        <ActionButton className="btn-ghost" confirm="Accept everything exactly as received?" run={async () => { await api.post(`/goods-receipts/${doc.id}/inspect`, {}); toast.ok('Accepted'); reload(); }}>Accept all</ActionButton>
        <ActionButton className="btn-primary" disabled={!items.every((i) => acc[i.id] !== undefined && acc[i.id] !== '')} run={async () => { await api.post(`/goods-receipts/${doc.id}/inspect`, { items: items.map((i) => ({ itemId: i.id, acceptedQuantity: acc[i.id], ...(why[i.id] ? { rejectionReason: why[i.id] } : {}) })) }); toast.ok('Inspection saved'); reload(); }}>Save counts</ActionButton></div></div>
  );
}
export const ReceiptsPage = () => <DocumentPage cfg={{
  title: 'Goods receipts', path: '/goods-receipts', subtitle: 'Record what actually arrived against an order, then inspect it.', statuses: ['pending_inspection', 'completed'],
  columns: [{ key: 'reference_no', header: 'Receipt' }, { key: 'order_reference', header: 'Order' }, { key: 'supplier_name', header: 'Supplier' }, { key: 'delivery_note_no', header: 'Delivery note' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'received_at', header: 'Received', type: 'datetime' }],
  customCreate: { permission: 'procurement.receive', label: 'Receive goods', render: (close, done) => <ReceiveForm close={close} done={done} /> },
  extra: (d, reload) => <InspectReceipt doc={d} reload={reload} />,
} as DocCfg} />;

// ---------- invoices / payments / returns ----------
export const SupplierInvoicesPage = () => <DocumentPage cfg={{
  title: 'Supplier invoices', path: '/supplier-invoices', statuses: ['pending_approval', 'open', 'partially_paid', 'paid', 'rejected', 'cancelled'],
  filters: [{ name: 'supplierId', label: 'Supplier', type: 'lookup', lookup: supLookup }, { name: 'overdue', label: 'Overdue', type: 'select', options: [{ value: 'true', label: 'Only overdue' }] }],
  columns: [{ key: 'invoice_no', header: 'Invoice no.' }, { key: 'supplier_name', header: 'Supplier' }, { key: 'invoice_date', header: 'Date', type: 'date' }, { key: 'due_date', header: 'Due', type: 'date' }, { key: 'total', header: 'Total', type: 'money' }, { key: 'balance', header: 'Balance', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }],
  create: { permission: 'procurement.invoice', title: 'Enter supplier invoice', note: 'The amounts must match what the supplier printed. The system checks them against the order and what was received.', header: [{ name: 'purchaseOrderId', label: 'Purchase order', type: 'lookup', lookup: { path: '/purchase-orders', label: (r) => `${r.reference_no} · ${r.supplier_name}` }, required: true, span: 2 }, { name: 'invoiceNo', label: 'Supplier’s invoice no.', required: true }, { name: 'invoiceDate', label: 'Invoice date', type: 'date', required: true, default: today() }, { name: 'dueDate', label: 'Due date', type: 'date' }, { name: 'subtotal', label: 'Subtotal', type: 'decimal', required: true }, { name: 'taxTotal', label: 'Tax', type: 'decimal', required: true, default: '0' }, { name: 'total', label: 'Total', type: 'decimal', required: true }, { name: 'note', label: 'Note', span: 2 }], build: (h) => h },
  actions: [{ label: 'Cancel invoice', path: (d) => `/supplier-invoices/${d.id}/cancel`, permission: 'procurement.invoice', show: (d) => ['pending_approval', 'open'].includes(d.status), confirm: 'Cancel this invoice?', danger: true, body: () => ({}) }],
} as DocCfg} />;

function PayForm({ close, done }: { close(): void; done(r?: Row): void }) {
  const [sup, setSup] = useState(''); const [method, setMethod] = useState('bank_transfer'); const [ref, setRef] = useState(''); const [note, setNote] = useState(''); const [alloc, setAlloc] = useState<Record<string, string>>({}); const [err, setErr] = useState<unknown>(null);
  const inv = useQuery({ queryKey: ['pay-inv', sup], enabled: !!sup, queryFn: async () => (await api.list('/supplier-invoices', { supplierId: sup, pageSize: 100 })).items.filter((i) => ['open', 'partially_paid'].includes(i.status)) });
  const chosen = Object.entries(alloc).filter(([, v]) => decimalRe.test(v) && Number(v) > 0);
  const total = chosen.reduce((t, [, v]) => t + Number(v), 0);
  return (
    <Modal wide title="Pay a supplier" onClose={close} footer={<><button className="btn-ghost" onClick={close}>Cancel</button><ActionButton className="btn-primary" disabled={!chosen.length} run={async () => { try { setErr(null); done(await api.post('/supplier-payments', { supplierId: sup, method, ...(ref ? { externalRef: ref } : {}), ...(note ? { note } : {}), allocations: chosen.map(([invoiceId, amount]) => ({ invoiceId, amount })) })); } catch (e) { setErr(e); throw e; } }}>Record payment {total ? money(total) : ''}</ActionButton></>}>
      {err ? <div className="mb-3"><ErrorBox error={err} /></div> : null}
      <div className="grid gap-3 sm:grid-cols-3"><div><label className="label">Supplier</label><select className="input" value={sup} onChange={(e) => { setSup(e.target.value); setAlloc({}); }}><option value="">Select…</option>{useLookup('/suppliers').data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label className="label">Paid by</label><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{['cash', 'bank_transfer', 'cheque', 'mobile_money', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></div>
        <div><label className="label">Cheque / transfer ref.</label><input className="input" value={ref} onChange={(e) => setRef(e.target.value)} /></div></div>
      {sup && (inv.isLoading ? <Spinner /> : !inv.data?.length ? <Empty text="No unpaid invoices for this supplier." /> : <table className="mt-3 min-w-full text-sm"><thead><tr><th className="th">Invoice</th><th className="th">Due</th><th className="th text-right">Balance</th><th className="th w-32">Pay now</th></tr></thead><tbody>
        {inv.data.map((i) => <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td">{i.invoice_no}</td><td className="td">{i.due_date}</td><td className="td text-right">{money(i.balance)}</td><td className="td"><input className="input py-1" inputMode="decimal" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} /></td></tr>)}</tbody></table>)}
      <div className="mt-3"><label className="label">Note</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}
export const SupplierPaymentsPage = () => <DocumentPage cfg={{
  title: 'Supplier payments', path: '/supplier-payments', statuses: ['pending_approval', 'posted', 'reversed', 'rejected'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'supplier_name', header: 'Supplier' }, { key: 'payment_date', header: 'Date', type: 'date' }, { key: 'method', header: 'Method', render: (r) => label(r.method) }, { key: 'amount', header: 'Amount', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }],
  customCreate: { permission: 'procurement.pay', label: 'New payment', render: (close, done) => <PayForm close={close} done={done} /> },
  actions: [{ label: 'Reverse payment', path: (d) => `/supplier-payments/${d.id}/reverse`, permission: 'procurement.payment_reverse', show: (d) => d.status === 'posted', danger: true, fields: [{ name: 'reason', label: 'Reason', required: true }] }],
} as DocCfg} />;

export const PurchaseReturnsPage = () => <DocumentPage cfg={{
  title: 'Returns to suppliers', path: '/purchase-returns', statuses: ['pending_approval', 'posted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'supplier_name', header: 'Supplier' }, { key: 'reason', header: 'Reason' }, { key: 'total', header: 'Value', type: 'money' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Date', type: 'datetime' }],
  create: { permission: 'procurement.return', title: 'Return goods to a supplier', note: 'Only stock that is on hold or damaged can be returned. Move stock to “quarantined” or “damaged” first under Stock adjustments / disposals if needed.', header: [{ name: 'supplierId', label: 'Supplier', type: 'lookup', lookup: supLookup, required: true }, { name: 'warehouseId', label: 'From warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'reason', label: 'Reason', required: true, span: 2 }, { name: 'note', label: 'Note', span: 2 }],
    lines: { unitField: false, fields: [{ name: 'batchId', label: 'Batch', width: '16rem', render: (l: Line, set: (n: string, v: any) => void) => <BatchSelect productId={l.product.id} value={l.batchId} onChange={(v) => set('batchId', v)} required /> } as any, { name: 'status', label: 'Stock is', type: 'select', required: true, default: 'damaged', options: [{ value: 'damaged', label: 'Damaged' }, { value: 'quarantined', label: 'On hold' }] }, { ...qtyField, label: 'Quantity (base)' }] },
    build: (h, lines) => ({ ...h, items: lines.map((l) => ({ batchId: l.batchId, status: l.status, quantity: l.quantity })) }) },
  actions: [{ label: 'Cancel', path: (d) => `/purchase-returns/${d.id}/cancel`, permission: 'procurement.return', show: (d) => d.status === 'pending_approval', confirm: 'Cancel this return?', danger: true, body: () => ({}) }],
} as DocCfg} />;
