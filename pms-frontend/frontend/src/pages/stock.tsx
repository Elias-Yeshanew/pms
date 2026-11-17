import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { label, money } from '../lib/format';
import { DocCfg, DocumentPage } from '../ui/documents';
import { ActionButton, Column, DataTable, Empty, ErrorBox, FieldDef, FormFields, PageHeader, Pager, SearchBox, Spinner, Tabs, usePagedList, useLookup, useToast, initialValues, cleanValues } from '../ui/kit';
import { BatchSelect, Line } from '../ui/lines';

const whLookup = { path: '/warehouses', label: (r: Row) => r.name };
const decimalRe = /^\d+(\.\d{1,4})?$/;

// ---------- stock views ----------
export function StockPage() {
  const { branchId: rawBranch } = useBranch(); const branchId = rawBranch ?? undefined; const { can } = useAuth(); const toast = useToast();
  const [tab, setTab] = useState('summary'); const [days, setDays] = useState('90');
  return (
    <div>
      <PageHeader title="Stock" subtitle="What is on the shelves and in the store, for the branch chosen at the top." actions={can('inventory.adjust') && <ActionButton className="btn-ghost" confirm="Move all expired stock out of 'available' now?" run={async () => { const r = await api.post('/inventory/expiry-sweep', branchId ? { branchId } : {}); toast.ok(`Done${r?.moved !== undefined ? `: ${r.moved} batch(es) moved` : ''}`); }}>Run expiry sweep</ActionButton>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'By product' }, { id: 'batches', label: 'By batch' }, { id: 'low', label: 'Low stock' }, { id: 'expiring', label: 'Expiring' }, { id: 'movements', label: 'Movements' }, { id: 'value', label: 'Value' }]} />
      <div className="mt-3">
        {tab === 'summary' && <Simple key="s" path="/inventory/stock/summary" q={{ branchId }} columns={[{ key: 'sku', header: 'SKU' }, { key: 'name', header: 'Product' }, { key: 'available', header: 'Available', type: 'qty' }, { key: 'quarantined', header: 'Quarantined', type: 'qty' }, { key: 'damaged', header: 'Damaged', type: 'qty' }, { key: 'expired', header: 'Expired', type: 'qty' }, { key: 'reorder_level', header: 'Reorder at', type: 'qty' }, { key: 'nearest_expiry', header: 'Nearest expiry', type: 'date' }]} search />}
        {tab === 'batches' && <Paged key="b" path="/inventory/stock" q={{ branchId }} columns={[{ key: 'sku', header: 'SKU' }, { key: 'product_name', header: 'Product' }, { key: 'batch_ref', header: 'Batch' }, { key: 'expiry_date', header: 'Expiry', type: 'date' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'quantity', header: 'Quantity', type: 'qty' }, { key: 'reserved_quantity', header: 'Reserved', type: 'qty' }]} />}
        {tab === 'low' && <Simple key="l" path="/inventory/low-stock" q={{ branchId }} columns={[{ key: 'sku', header: 'SKU' }, { key: 'name', header: 'Product', render: (r) => r.name ?? r.product_name }, { key: 'available', header: 'Available', type: 'qty' }, { key: 'reorder_level', header: 'Reorder at', type: 'qty' }, { key: 'min_stock', header: 'Minimum', type: 'qty' }]} />}
        {tab === 'expiring' && <>
          <div className="mb-3 max-w-[10rem]"><label className="label">Within (days)</label><select className="input" value={days} onChange={(e) => setDays(e.target.value)}>{['30', '60', '90', '180'].map((d) => <option key={d}>{d}</option>)}</select></div>
          <Simple key={`e${days}`} path="/inventory/expiring" q={{ branchId, withinDays: days }} columns={[{ key: 'sku', header: 'SKU' }, { key: 'product_name', header: 'Product' }, { key: 'batch_ref', header: 'Batch' }, { key: 'expiry_date', header: 'Expiry', type: 'date' }, { key: 'days_left', header: 'Days left', align: 'right' }, { key: 'quantity', header: 'Quantity', type: 'qty' }]} /></>}
        {tab === 'movements' && <Movements branchId={branchId} />}
        {tab === 'value' && <Valuation branchId={branchId} />}
      </div>
    </div>
  );
}
function Simple({ path, q, columns, search }: { path: string; q: Record<string, string | undefined>; columns: Column[]; search?: boolean }) {
  const [text, setText] = useState('');
  const r = useQuery({ queryKey: ['stockv', path, q], queryFn: async () => (await api.list(path, q)).items });
  const rows = (r.data ?? []).filter((x) => !text || JSON.stringify(x).toLowerCase().includes(text.toLowerCase()));
  return <div>{search && <div className="mb-3"><SearchBox placeholder="Filter stock…" value={text} onChange={setText} /></div>}<div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{r.isLoading ? <Spinner /> : r.error ? <div className="p-4"><ErrorBox error={r.error} /></div> : <DataTable columns={columns} rows={rows} empty="Nothing to show." />}</div></div>;
}
function Paged({ path, q, columns }: { path: string; q: Record<string, string | undefined>; columns: Column[] }) {
  const l = usePagedList(path, q, 50);
  return <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{l.isLoading ? <Spinner /> : l.error ? <div className="p-4"><ErrorBox error={l.error} /></div> : <><DataTable columns={columns} rows={l.rows} /><Pager page={l.page} pageSize={l.pageSize} total={l.total} onPage={l.setPage} /></>}</div>;
}
function Movements({ branchId }: { branchId?: string }) {
  const [type, setType] = useState(''); const [ref, setRef] = useState('');
  return <><div className="mb-3 flex flex-wrap gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900"><div><label className="label">Type</label><select className="input text-xs" value={type} onChange={(e) => setType(e.target.value)}><option value="">All movement types</option>{['purchase_receipt', 'sale', 'sale_return', 'adjustment', 'transfer_out', 'transfer_in', 'disposal', 'status_change', 'purchase_return', 'count'].map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></div><div><label className="label">Reference</label><input className="input text-xs" placeholder="Filter by ref…" value={ref} onChange={(e) => setRef(e.target.value)} /></div></div>
    <Paged path="/inventory/movements" q={{ branchId, movementType: type || undefined, referenceNo: ref || undefined }} columns={[{ key: 'created_at', header: 'When', type: 'datetime' }, { key: 'reference_no', header: 'Reference' }, { key: 'movement_type', header: 'Type', render: (r) => label(r.movement_type) }, { key: 'product_id', header: 'Product', render: (r) => <ProductName id={r.product_id} /> }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'quantity_delta', header: 'Change', type: 'qty' }, { key: 'balance_after', header: 'Balance', type: 'qty' }]} /></>;
}
export function ProductName({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['pname', id], staleTime: Infinity, queryFn: async () => (await api.get<Row>(`/products/${id}`)).name as string });
  return <>{q.data ?? '…'}</>;
}
function Valuation({ branchId }: { branchId?: string }) {
  const q = useQuery({ queryKey: ['valuation', branchId], queryFn: () => api.get<Row>('/inventory/valuation', { branchId }) });
  const wh = useLookup('/warehouses');
  if (q.isLoading) return <Spinner />; if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="card p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Stock value at cost</div>
          <div className="mt-1 text-lg font-bold text-slate-900 dark:text-white tabular-nums">{money(d.total)}</div>
        </div>
        <div className="card p-3 border border-slate-200 dark:border-slate-800 shadow-xs">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">On the way between branches</div>
          <div className="mt-1 text-lg font-bold text-slate-900 dark:text-white tabular-nums">{money(d.inTransit)}</div>
        </div>
      </div>
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
        <DataTable rows={d.rows} columns={[{ key: 'warehouse_id', header: 'Warehouse', render: (r) => <>{wh.data?.find((w) => w.id === r.warehouse_id)?.name ?? '…'}</> }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'quantity', header: 'Quantity', type: 'qty' }, { key: 'value', header: 'Value', type: 'money' }]} />
      </div>
    </div>
  );
}

// ---------- documents ----------
const qtyField: FieldDef = { name: 'quantity', label: 'Quantity', type: 'decimal', required: true };
const adjustmentBatch = {
  name: 'batch', label: 'Batch', width: '16rem',
  render: (l: Line, set: (n: string, v: any) => void) => l.direction === 'decrease'
    ? <BatchSelect productId={l.product.id} value={l.batchId} onChange={(v) => set('batchId', v)} required />
    : <div className="space-y-1">
        <BatchSelect productId={l.product.id} value={l.batchId} onChange={(v) => set('batchId', v)} />
        {!l.batchId && <><input className="input" placeholder="New batch no." value={l.newRef ?? ''} onChange={(e) => set('newRef', e.target.value)} /><input className="input" type="date" aria-label="Expiry" value={l.newExpiry ?? ''} onChange={(e) => set('newExpiry', e.target.value)} /><input className="input" inputMode="decimal" placeholder="Cost per base unit" value={l.newCost ?? ''} onChange={(e) => set('newCost', e.target.value)} /></>}
      </div>,
} as any;

export const AdjustmentsPage = () => <DocumentPage cfg={{
  title: 'Stock adjustments', subtitle: 'Correct stock after a count, loss or when entering opening balances.', path: '/inventory/adjustments', statuses: ['pending_approval', 'posted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'reason_code', header: 'Reason', render: (r) => label(r.reason_code) }, { key: 'reason', header: 'Note' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'requested_at', header: 'Date', type: 'datetime' }, { key: 'requested_by_name', header: 'By' }],
  create: {
    permission: 'inventory.adjust', title: 'New adjustment', note: 'Large adjustments may need a manager’s approval before stock changes.',
    header: [{ name: 'warehouseId', label: 'Warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'reasonCode', label: 'Reason', type: 'select', required: true, options: ['opening_balance', 'count_correction', 'loss', 'found', 'data_entry_error', 'other'].map((v) => ({ value: v, label: label(v) })) }, { name: 'reason', label: 'Explain', required: true, span: 2 }],
    lines: { unitField: true, fields: [{ name: 'direction', label: 'Add / remove', type: 'select', required: true, default: 'increase', options: [{ value: 'increase', label: 'Add' }, { value: 'decrease', label: 'Remove' }] }, qtyField, adjustmentBatch, { name: 'note', label: 'Line note' }] },
    build: (h, lines) => ({ ...h, items: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.quantity, direction: l.direction, ...(l.batchId ? { batchId: l.batchId } : { newBatch: { batchRef: l.newRef, expiryDate: l.newExpiry, unitCost: l.newCost } }), ...(l.note ? { note: l.note } : {}) })) }),
  },
  actions: [{ label: 'Cancel', path: (d) => `/inventory/adjustments/${d.id}/cancel`, permission: 'inventory.adjust', show: (d) => d.status === 'pending_approval', confirm: 'Cancel this adjustment?', danger: true }],
} as DocCfg} />;

export const DisposalsPage = () => <DocumentPage cfg={{
  title: 'Disposals', subtitle: 'Write off expired or damaged stock.', path: '/inventory/disposals', statuses: ['pending_approval', 'posted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'reason', header: 'Reason', render: (r) => label(r.reason) }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Date', type: 'datetime' }],
  create: {
    permission: 'inventory.dispose', title: 'New disposal',
    header: [{ name: 'warehouseId', label: 'Warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'reason', label: 'Reason', type: 'select', required: true, options: ['expired', 'damaged', 'returned', 'other'].map((v) => ({ value: v, label: label(v) })) }, { name: 'note', label: 'Note', span: 2 }],
    lines: { unitField: false, fields: [{ name: 'batchId', label: 'Batch', width: '16rem', render: (l: Line, set: (n: string, v: any) => void) => <BatchSelect productId={l.product.id} value={l.batchId} onChange={(v) => set('batchId', v)} required /> } as any, { name: 'status', label: 'Stock is', type: 'select', required: true, default: 'expired', options: ['expired', 'damaged', 'quarantined'].map((v) => ({ value: v, label: label(v) })) }, { ...qtyField, label: 'Quantity (base units)' }] },
    build: (h, lines) => ({ ...h, items: lines.map((l) => ({ batchId: l.batchId, status: l.status, quantity: l.quantity })) }),
  },
  actions: [{ label: 'Cancel', path: (d) => `/inventory/disposals/${d.id}/cancel`, permission: 'inventory.dispose', show: (d) => d.status === 'pending_approval', confirm: 'Cancel this disposal?', danger: true }],
} as DocCfg} />;

export const TransfersPage = () => <DocumentPage cfg={{
  title: 'Transfers', subtitle: 'Move stock between warehouses or branches.', path: '/inventory/transfers', statuses: ['draft', 'in_transit', 'received', 'received_with_discrepancy', 'resolved', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'from_warehouse_id', header: 'From', render: (r) => <WhName id={r.from_warehouse_id} /> }, { key: 'to_warehouse_id', header: 'To', render: (r) => <WhName id={r.to_warehouse_id} /> }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Date', type: 'datetime' }],
  create: {
    permission: 'inventory.transfer', title: 'New transfer', note: 'Stock leaves the sender when you press Dispatch, and enters the receiver when they press Receive.',
    header: [{ name: 'fromWarehouseId', label: 'From warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'toWarehouseId', label: 'To warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'note', label: 'Note', span: 2 }],
    lines: { fields: [{ ...qtyField }] },
    build: (h, lines) => ({ ...h, items: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.quantity })) }),
  },
  actions: [
    { label: 'Dispatch', path: (d) => `/inventory/transfers/${d.id}/dispatch`, permission: 'inventory.transfer', show: (d) => d.status === 'draft', confirm: 'Send this stock now? It leaves your shelves.' },
    { label: 'Receive all', path: (d) => `/inventory/transfers/${d.id}/receive`, permission: 'inventory.transfer', show: (d) => d.status === 'in_transit', confirm: 'Confirm everything arrived as listed?', body: () => ({}) },
    { label: 'Resolve difference', path: (d) => `/inventory/transfers/${d.id}/resolve`, permission: 'inventory.transfer', show: (d) => d.status === 'received_with_discrepancy', fields: [{ name: 'note', label: 'How was it settled?', type: 'textarea', required: true }] },
    { label: 'Cancel', path: (d) => `/inventory/transfers/${d.id}/cancel`, permission: 'inventory.transfer', show: (d) => ['draft', 'in_transit'].includes(d.status), confirm: 'Cancel this transfer?', danger: true },
  ],
} as DocCfg} />;
function WhName({ id }: { id: string }) { const w = useLookup('/warehouses'); return <>{w.data?.find((x) => x.id === id)?.name ?? '…'}</>; }

function CountEntry({ doc, reload }: { doc: Row; reload(): void }) {
  const toast = useToast(); const [vals, setVals] = useState<Record<string, string>>({});
  const { can } = useAuth();
  if (doc.status !== 'counting') return null;
  const entered = Object.entries(vals).filter(([, v]) => v !== '' && decimalRe.test(v));
  return (
    <div className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700">
      <h3 className="font-semibold">Enter what you counted (base units)</h3>
      <div className="max-h-80 overflow-auto"><table className="min-w-full text-sm"><thead><tr><th className="th">Product</th><th className="th">Batch</th><th className="th text-right">System</th><th className="th w-32">Counted</th></tr></thead><tbody>
        {doc.items.map((i: Row) => <tr key={i.id} className="border-t border-slate-100 dark:border-slate-800"><td className="td">{i.product_name}</td><td className="td">{i.batch_ref}</td><td className="td text-right tabular-nums">{Number(i.system_quantity)}</td><td className="td"><input className="input py-1" inputMode="decimal" placeholder={i.counted_quantity ? String(Number(i.counted_quantity)) : ''} value={vals[i.id] ?? ''} onChange={(e) => setVals({ ...vals, [i.id]: e.target.value })} /></td></tr>)}
      </tbody></table></div>
      <div className="flex justify-end gap-2">
        <ActionButton className="btn-ghost" disabled={!entered.length} run={async () => { await api.put(`/inventory/counts/${doc.id}/items`, { items: entered.map(([itemId, countedQuantity]) => ({ itemId, countedQuantity })) }); toast.ok('Counts saved'); setVals({}); reload(); }}>Save counts</ActionButton>
        {can('inventory.count') && <ActionButton className="btn-primary" confirm="Submit this count for review? Items you did not count are left unchanged." run={async () => { await api.post(`/inventory/counts/${doc.id}/submit`, {}); toast.ok('Submitted'); reload(); }}>Submit for review</ActionButton>}
      </div>
    </div>
  );
}
export const CountsPage = () => <DocumentPage cfg={{
  title: 'Stock counts', subtitle: 'Count the shelves and compare with the system. Differences are posted after approval.', path: '/inventory/counts', statuses: ['counting', 'pending_approval', 'posted', 'rejected', 'cancelled'],
  columns: [{ key: 'reference_no', header: 'Reference' }, { key: 'warehouse_id', header: 'Warehouse', render: (r) => <WhName id={r.warehouse_id} /> }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Started', type: 'datetime' }, { key: 'created_by_name', header: 'By' }],
  create: { permission: 'inventory.count', title: 'Start a count', note: 'A snapshot of the current system quantities is taken now.', header: [{ name: 'warehouseId', label: 'Warehouse', type: 'lookup', lookup: whLookup, required: true }, { name: 'note', label: 'Note' }], build: (h) => h },
  extra: (d, reload) => <CountEntry doc={d} reload={reload} />,
  actions: [{ label: 'Cancel count', path: (d) => `/inventory/counts/${d.id}/cancel`, permission: 'inventory.count', show: (d) => d.status === 'counting', confirm: 'Cancel this count?', danger: true }],
} as DocCfg} />;
