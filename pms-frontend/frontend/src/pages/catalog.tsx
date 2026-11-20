import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Row } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, label } from '../lib/format';
import { isValidEan13 } from '../domain/barcode';
import { DocumentPage } from '../ui/documents';
import {
  ActionButton, AutoTable, Badge, DataTable, Empty, ErrorBox, FieldDef, FormFields, FormModal, KeyValues, Modal, PageHeader, Pager, SearchBox, Spinner, Tabs, initialValues, useConfirm, useDebounced, useLookup, usePagedList, useToast, cleanValues,
} from '../ui/kit';

const DETAIL_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, span: 2 },
  { name: 'genericName', label: 'Generic name' }, { name: 'brandName', label: 'Brand' },
  { name: 'strength', label: 'Strength', placeholder: '500 mg' },
  { name: 'dosageFormId', label: 'Dosage form', type: 'lookup', lookup: { path: '/dosage-forms' } },
  { name: 'categoryId', label: 'Category', type: 'lookup', lookup: { path: '/categories' } },
  { name: 'manufacturerId', label: 'Manufacturer', type: 'lookup', lookup: { path: '/manufacturers' } },
  { name: 'taxCategoryId', label: 'Tax category', type: 'lookup', lookup: { path: '/tax-categories' } },
  { name: 'registrationNo', label: 'Registration no.', help: 'Regulator registration number' },
  { name: 'reorderLevel', label: 'Reorder level (base units)', type: 'decimal' }, { name: 'minStock', label: 'Minimum stock', type: 'decimal' }, { name: 'maxStock', label: 'Maximum stock', type: 'decimal' },
  { name: 'requiresPrescription', label: 'Prescription', type: 'checkbox', help: 'Only sold against a validated prescription' },
  { name: 'isControlled', label: 'Controlled', type: 'checkbox', help: 'Controlled medicine' },
  { name: 'description', label: 'Description', type: 'textarea' },
];
const CREATE_FIELDS: FieldDef[] = [
  { name: 'baseUnitId', label: 'Smallest unit sold (base unit)', type: 'lookup', lookup: { path: '/units', label: (r) => r.name }, required: true, help: 'e.g. tablet, ampoule, bottle. Stock is counted in this unit.' },
  { name: 'sku', label: 'SKU', help: 'Leave empty to number automatically' },
  ...DETAIL_FIELDS,
  { name: 'sellingPrice', label: 'Selling price per base unit', type: 'decimal' }, { name: 'purchasePrice', label: 'Purchase price per base unit', type: 'decimal' },
  { name: 'barcode', label: 'Barcode (base unit)', help: 'Scan or type; optional' },
  { name: 'packUnitId', label: 'Larger pack (optional)', type: 'lookup', lookup: { path: '/units' }, help: 'e.g. strip or box' },
  { name: 'packFactor', label: 'Base units in one pack', type: 'decimal', show: (v) => !!v.packUnitId, required: true },
  { name: 'packPrice', label: 'Selling price per pack', type: 'decimal', show: (v) => !!v.packUnitId },
];

export function ProductsPage() {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast(); const confirm = useConfirm();
  const [search, setSearch] = useState(''); const s = useDebounced(search); const [active, setActive] = useState('true'); const [cat, setCat] = useState('');
  const [openId, setOpenId] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const list = usePagedList('/products', { search: s || undefined, isActive: active, categoryId: cat || undefined });
  const cats = useLookup('/categories');
  const reload = () => void qc.invalidateQueries({ queryKey: ['list', '/products'] });
  const create = async (v: Row, confirmDuplicate = false): Promise<void> => {
    const { baseUnitId, sellingPrice, purchasePrice, barcode, packUnitId, packFactor, packPrice, ...rest } = v;
    const units = [{ unitId: baseUnitId, factorToBase: '1', isSellable: true, isPurchasable: true }, ...(packUnitId ? [{ unitId: packUnitId, factorToBase: packFactor, isSellable: true, isPurchasable: true }] : [])];
    const prices = [
      ...(sellingPrice ? [{ unitId: baseUnitId, priceType: 'selling', amount: sellingPrice }] : []), ...(purchasePrice ? [{ unitId: baseUnitId, priceType: 'purchase', amount: purchasePrice }] : []),
      ...(packUnitId && packPrice ? [{ unitId: packUnitId, priceType: 'selling', amount: packPrice }] : []),
    ];
    try {
      const p = await api.post('/products', { ...rest, baseUnitId, units, prices, barcodes: barcode ? [{ unitId: baseUnitId, barcode, isPrimary: true }] : [], ...(confirmDuplicate ? { confirmDuplicate: true } : {}) });
      toast.ok('Product added'); reload(); setOpenId(p.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE' && await confirm.ask('A product with the same name, strength, form and manufacturer already exists. Add it anyway?')) return create(v, true);
      throw e;
    }
  };
  return (
    <div>
      <PageHeader title="Products" actions={can('products.create') && <button className="btn-primary" onClick={() => setCreating(true)}>New product</button>} />
      <div className="mb-3 flex flex-wrap items-end gap-2.5 rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <SearchBox value={search} onChange={setSearch} placeholder="Name, generic, SKU or barcode" />
        <div><label className="label">Category</label><select className="input text-xs" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label className="label">Show</label><select className="input text-xs" value={active} onChange={(e) => setActive(e.target.value)}><option value="true">Active products</option><option value="false">Inactive products</option></select></div>
      </div>
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorBox error={list.error} /></div> : <>
          <DataTable onRowClick={(r) => setOpenId(r.id)} rows={list.rows} columns={[{ key: 'sku', header: 'SKU', className: 'font-mono text-xs' }, { key: 'name', header: 'Name', render: (r) => <span><span className="font-semibold text-slate-900 dark:text-white">{r.name}</span>{r.strength ? ` ${r.strength}` : ''}{r.requires_prescription && <span className="ml-1.5 rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">Rx</span>}{r.is_controlled && <span className="ml-1.5 rounded border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 dark:border-purple-900 dark:bg-purple-950/60 dark:text-purple-300">Controlled</span>}</span> }, { key: 'generic_name', header: 'Generic' }, { key: 'brand_name', header: 'Brand' }, { key: 'is_active', header: 'Active', type: 'bool' }]} />
          <Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} /></>}
      </div>
      {creating && <FormModal wide title="New product" fields={CREATE_FIELDS} onClose={() => setCreating(false)} onSubmit={(v) => create(v)} />}
      {openId && <ProductDetail id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
      {confirm.dialog}
    </div>
  );
}

function ProductDetail({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api.get<Row>(`/products/${id}`) });
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth(); const [tab, setTab] = useState('details');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['product', id] }); onChanged(); };
  const p = q.data; const edit = can('products.update');
  return (
    <Modal wide title={p ? `${p.name}${p.strength ? ` ${p.strength}` : ''}` : 'Product'} onClose={onClose}>
      {q.isLoading || !p ? <Spinner /> : q.error ? <ErrorBox error={q.error} /> : <>
        <div className="mb-2 flex items-center gap-2 text-sm text-slate-500"><span>{p.sku}</span><Badge value={p.is_active ? 'active' : 'inactive'} />
          {edit && <ActionButton className="btn-ghost py-0.5 text-xs" confirm={p.is_active ? 'Deactivate this product? It can no longer be sold or ordered.' : undefined} run={async () => { await api.post(`/products/${id}/${p.is_active ? 'deactivate' : 'activate'}`); toast.ok('Updated'); refresh(); }}>{p.is_active ? 'Deactivate' : 'Activate'}</ActionButton>}</div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Details' }, { id: 'packs', label: 'Packs' }, { id: 'barcodes', label: 'Barcodes' }, { id: 'prices', label: 'Prices' }, { id: 'image', label: 'Photo' }]} />
        <div className="mt-3">
          {tab === 'details' && <Details p={p} edit={edit} onSaved={refresh} />}
          {tab === 'packs' && <Packs p={p} edit={edit} onSaved={refresh} />}
          {tab === 'barcodes' && <Barcodes p={p} edit={edit} onSaved={refresh} />}
          {tab === 'prices' && <Prices p={p} onSaved={refresh} />}
          {tab === 'image' && <Photo p={p} edit={edit} onSaved={refresh} />}
        </div></>}
    </Modal>
  );
}

function Details({ p, edit, onSaved }: { p: Row; edit: boolean; onSaved(): void }) {
  const [v, setV] = useState<Row>(() => initialValues(DETAIL_FIELDS, p)); const toast = useToast(); const [err, setErr] = useState<unknown>(null);
  const fields = DETAIL_FIELDS.map((f) => ({ ...f, readOnly: !edit }));
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await api.patch(`/products/${p.id}`, { version: p.version, ...cleanValues(DETAIL_FIELDS, v) }); toast.ok('Saved'); onSaved(); } catch (x) { setErr(x); } }}>
      {err ? <ErrorBox error={err} /> : null}
      <FormFields fields={fields} values={v} setValues={setV} />
      {edit && <button className="btn-primary">Save</button>}
    </form>
  );
}

function Packs({ p, edit, onSaved }: { p: Row; edit: boolean; onSaved(): void }) {
  const units = useLookup('/units'); const toast = useToast();
  const [rows, setRows] = useState<Row[]>(() => p.units.map((u: Row) => ({ ...u })));
  const used = new Set(rows.map((r) => r.unit_id));
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">Packs are the ways this product is sold or bought. The base unit always has a factor of 1. Changing a factor does not change stock already counted.</p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1.4fr_1fr_auto_auto_auto] items-center gap-2">
          <select className="input" disabled={!edit || r.unit_id === p.base_unit_id} value={r.unit_id} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unit_id: e.target.value } : x)))}>{units.data?.filter((u) => u.id === r.unit_id || !used.has(u.id)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <input className="input" inputMode="decimal" disabled={!edit || r.unit_id === p.base_unit_id} value={r.factor_to_base} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, factor_to_base: e.target.value } : x)))} aria-label="Base units in this pack" />
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!edit} checked={r.is_sellable} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, is_sellable: e.target.checked } : x)))} />Sell</label>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" disabled={!edit} checked={r.is_purchasable} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, is_purchasable: e.target.checked } : x)))} />Buy</label>
          {edit && r.unit_id !== p.base_unit_id ? <button className="text-red-600" aria-label="Remove pack" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button> : <span />}
        </div>
      ))}
      {edit && <div className="flex gap-2"><button className="btn-ghost" onClick={() => { const u = units.data?.find((x) => !used.has(x.id)); if (u) setRows([...rows, { unit_id: u.id, factor_to_base: '1', is_sellable: true, is_purchasable: true }]); }}>Add pack</button>
        <ActionButton className="btn-primary" run={async () => { await api.put(`/products/${p.id}/units`, { units: rows.map((r) => ({ unitId: r.unit_id, factorToBase: String(r.factor_to_base), isSellable: r.is_sellable, isPurchasable: r.is_purchasable })) }); toast.ok('Saved'); onSaved(); }}>Save packs</ActionButton></div>}
    </div>
  );
}

function Barcodes({ p, edit, onSaved }: { p: Row; edit: boolean; onSaved(): void }) {
  const toast = useToast(); const [code, setCode] = useState(''); const [unitId, setUnitId] = useState<string>(p.base_unit_id);
  const unitName = (id: string) => p.units.find((u: Row) => u.unit_id === id)?.name ?? '';
  return (
    <div className="space-y-3">
      {p.barcodes.length ? <DataTable rows={p.barcodes} columns={[{ key: 'barcode', header: 'Barcode', render: (r) => <span className="font-mono">{r.barcode}</span> }, { key: 'unit_id', header: 'Pack', render: (r) => unitName(r.unit_id) }, { key: 'is_primary', header: 'Main', type: 'bool' }, { key: 'source', header: 'Source', render: (r) => (r.is_generated ? 'Generated' : 'Manufacturer') },
        { key: '_', header: '', render: (r) => <div className="flex justify-end gap-1"><button className="btn-ghost py-1" onClick={async () => { try { const { blob } = await api.blob(`/products/${p.id}/barcodes/${r.id}/label`); window.open(URL.createObjectURL(blob), '_blank'); } catch (e) { toast.error(e); } }}>Label</button>
          {edit && <ActionButton className="btn-ghost py-1" confirm="Remove this barcode?" run={async () => { await api.del(`/products/${p.id}/barcodes/${r.id}`); onSaved(); }}>Remove</ActionButton>}</div> }]} /> : <Empty text="No barcodes yet." />}
      {edit && <div className="flex flex-wrap items-end gap-2">
        <div><label className="label">Pack</label><select className="input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>{p.units.map((u: Row) => <option key={u.unit_id} value={u.unit_id}>{u.name}</option>)}</select></div>
        <div className="min-w-[14rem] flex-1"><label className="label">Scan or type a barcode</label><input className="input" value={code} onChange={(e) => setCode(e.target.value)} />{code && <p className="mt-1 text-xs text-slate-500">{/^\d{13}$/.test(code) ? (isValidEan13(code) ? 'Valid EAN-13' : 'EAN-13 check digit does not match') : 'Accepted as an internal code'}</p>}</div>
        <ActionButton className="btn-primary" disabled={!code.trim()} run={async () => { await api.post(`/products/${p.id}/barcodes`, { unitId, barcode: code.trim(), isPrimary: !p.barcodes.length }); setCode(''); toast.ok('Added'); onSaved(); }}>Add</ActionButton>
        <ActionButton className="btn-ghost" run={async () => { await api.post(`/products/${p.id}/barcodes/generate`, { unitId }); toast.ok('Barcode generated'); onSaved(); }}>Generate one for in-house labels</ActionButton>
      </div>}
    </div>
  );
}

function Prices({ p, onSaved }: { p: Row; onSaved(): void }) {
  const { can } = useAuth(); const hist = useQuery({ queryKey: ['prices', p.id, p.version], queryFn: async () => (await api.list(`/products/${p.id}/prices`)).items });
  const [setting, setSetting] = useState(false); const toast = useToast(); const canChange = can('prices.change');
  const unitName = (id: string) => p.units.find((u: Row) => u.unit_id === id)?.name ?? '';
  const showCost = can('finance.read') || can('procurement.read') || true;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><h3 className="font-semibold">Current prices</h3>{canChange && <button className="btn-primary" onClick={() => setSetting(true)}>Change a price</button>}</div>
      <DataTable rows={p.prices} empty="No prices set." columns={[{ key: 'unit_id', header: 'Pack', render: (r) => unitName(r.unit_id) }, { key: 'price_type', header: 'Type', render: (r) => label(r.price_type) }, { key: 'amount', header: 'Price', type: 'money' }, { key: 'effective_from', header: 'Since', type: 'date' }]} />
      <h3 className="font-semibold">History</h3>
      {hist.isLoading ? <Spinner /> : <DataTable rows={hist.data ?? []} empty="No changes." columns={[{ key: 'changed_at', header: 'When', type: 'datetime' }, { key: 'unit_code', header: 'Pack' }, { key: 'price_type', header: 'Type', render: (r) => label(r.price_type) }, { key: 'old_amount', header: 'From', type: 'money' }, { key: 'new_amount', header: 'To', type: 'money' }, { key: 'reason', header: 'Reason' }, { key: 'changed_by', header: 'By' }]} />}
      {setting && <FormModal title="Change price" fields={[{ name: 'unitId', label: 'Pack', type: 'select', required: true, options: p.units.map((u: Row) => ({ value: u.unit_id, label: u.name })), default: p.base_unit_id }, { name: 'priceType', label: 'Price type', type: 'select', required: true, default: 'selling', options: ['selling', 'purchase', 'wholesale'].map((v) => ({ value: v, label: label(v) })) }, { name: 'amount', label: 'New price', type: 'decimal', required: true }, { name: 'reason', label: 'Reason', required: true }]} onClose={() => setSetting(false)}
        onSubmit={async (v) => { await api.post(`/products/${p.id}/prices`, v); toast.ok('Price changed'); onSaved(); }} />}
    </div>
  );
}

function Photo({ p, edit, onSaved }: { p: Row; edit: boolean; onSaved(): void }) {
  const [src, setSrc] = useState<string | null>(null); const toast = useToast(); const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { let url: string | null = null; if (p.image_path) void api.objectUrl(`/products/${p.id}/image`).then((u) => { url = u; setSrc(u); }).catch(() => setSrc(null)); else setSrc(null); return () => { if (url) URL.revokeObjectURL(url); }; }, [p.id, p.image_path]);
  return (
    <div className="space-y-3">
      {src ? <img src={src} alt={p.name} className="max-h-64 rounded border border-slate-200" /> : <Empty text="No photo." />}
      {edit && <div className="flex gap-2"><input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="text-sm" />
        <ActionButton className="btn-primary" run={async () => { const f = ref.current?.files?.[0]; if (!f) throw new Error('Choose a picture first.'); await api.upload('PUT', `/products/${p.id}/image`, f); toast.ok('Photo saved'); onSaved(); }}>Upload</ActionButton>
        {p.image_path && <ActionButton className="btn-ghost" confirm="Remove the photo?" run={async () => { await api.del(`/products/${p.id}/image`); onSaved(); }}>Remove</ActionButton>}</div>}
    </div>
  );
}

// ---------- import ----------
export function ImportPage() {
  const toast = useToast(); const ref = useRef<HTMLInputElement>(null); const [autoCreate, setAutoCreate] = useState(false);
  const [job, setJob] = useState<Row | null>(null); const [result, setResult] = useState<Row | null>(null); const [skipInvalid, setSkipInvalid] = useState(true); const [dups, setDups] = useState(false);
  const qc = useQueryClient();
  return (
    <div>
      <PageHeader title="Import products" subtitle="Add many products from a spreadsheet saved as CSV. You see a preview before anything is saved." />
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-3"><ActionButton className="btn-ghost" run={() => api.download('/products/import/template')}>Download template</ActionButton>
          <input ref={ref} type="file" accept=".csv,text/csv" className="text-sm" />
          {/* The server stores this choice with the preview and reuses it on Import, so changing it discards the preview. */}
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={autoCreate} onChange={(e) => { setAutoCreate(e.target.checked); setJob(null); setResult(null); }} />Create missing categories and manufacturers</label>
          <ActionButton className="btn-primary" run={async () => { const f = ref.current?.files?.[0]; if (!f) throw new Error('Choose a CSV file first.'); setResult(null); setJob(await api.upload('POST', `/products/import/preview${autoCreate ? '?autoCreate=true' : ''}`, f)); }}>Preview</ActionButton></div>
        <p className="text-xs text-slate-500">Dates and prices use plain numbers (e.g. 12.50). Packs are written like <code>strip=10;box=100</code>.</p>
      </div>
      {job && !result && (
        <div className="card mt-3 space-y-3 shadow-xs">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">Total: <b className="ml-1 tabular-nums">{job.total}</b></span>
            <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-800 dark:border-emerald-800/80 dark:bg-emerald-950/60 dark:text-emerald-200">Ready: <b className="ml-1 tabular-nums">{job.ok}</b></span>
            <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-800 dark:border-amber-800/80 dark:bg-amber-950/60 dark:text-amber-200">Possible duplicates: <b className="ml-1 tabular-nums">{job.duplicates}</b></span>
            <span className="rounded border border-red-200 bg-red-50 px-2 py-0.5 text-red-800 dark:border-red-800/80 dark:bg-red-950/60 dark:text-red-200">Problems: <b className="ml-1 tabular-nums">{job.errors}</b></span>
          </div>
          <DataTable rows={job.results} columns={[{ key: 'row', header: 'Row' }, { key: 'name', header: 'Name' }, { key: 'status', header: 'Result', type: 'badge' }, { key: 'messages', header: 'Notes', render: (r) => (r.messages ?? r.errors ?? []).join('; ') }]} />
          <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />Skip rows with problems</label>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={dups} onChange={(e) => setDups(e.target.checked)} />Add possible duplicates anyway</label>
            <ActionButton className="btn-primary" confirm="Add these products now?" run={async () => { const r = await api.post(`/products/import/${job.jobId}/commit`, { skipInvalid, confirmDuplicates: dups }); setResult(r); toast.ok(`${r.created} products added`); void qc.invalidateQueries({ queryKey: ['list', '/products'] }); }}>Import</ActionButton></div>
        </div>
      )}
      {result && <div className="card mt-3"><p className="font-semibold">Done: {result.created} added, {result.skipped} skipped.</p><button className="btn-ghost mt-2" onClick={() => { setJob(null); setResult(null); }}>Import another file</button></div>}
    </div>
  );
}

// ---------- bulk price changes ----------
export function PriceUpdatesPage() {
  const { can } = useAuth(); const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false); const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState('');
  const list = usePagedList('/prices/bulk', { status: status || undefined });
  const reload = () => void qc.invalidateQueries({ queryKey: ['list', '/prices/bulk'] });
  const fields: FieldDef[] = [
    { name: 'priceType', label: 'Price type', type: 'select', required: true, default: 'selling', options: ['selling', 'purchase', 'wholesale'].map((v) => ({ value: v, label: label(v) })) },
    { name: 'mode', label: 'How', type: 'select', required: true, default: 'percent', options: [{ value: 'percent', label: 'Increase/decrease by %' }, { value: 'amount', label: 'Increase/decrease by amount' }, { value: 'set', label: 'Set to exactly' }] },
    { name: 'value', label: 'Value', type: 'decimal', required: true, help: 'Use a minus sign for a decrease, e.g. -5' },
    { name: 'categoryId', label: 'Only this category', type: 'lookup', lookup: { path: '/categories' } }, { name: 'manufacturerId', label: 'Only this manufacturer', type: 'lookup', lookup: { path: '/manufacturers' } },
    { name: 'reason', label: 'Reason', required: true, span: 2 },
  ];
  return (
    <div>
      <PageHeader title="Price changes" subtitle="Change many prices at once. Review the preview, then submit for approval." actions={can('prices.change') && <button className="btn-primary" onClick={() => setCreating(true)}>New price change</button>} />
      <div className="mb-3 max-w-xs rounded border border-slate-200 bg-white p-3 shadow-xs dark:border-slate-800 dark:bg-slate-900"><label className="label">Status</label><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['draft', 'pending', 'applied', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
      <div className="card overflow-hidden p-0 shadow-xs border border-slate-200 dark:border-slate-800">{list.isLoading ? <Spinner /> : list.error ? <div className="p-3"><ErrorBox error={list.error} /></div> : <><DataTable onRowClick={(r) => setOpen(r.id)} rows={list.rows} columns={[{ key: 'reference_no', header: 'Reference' }, { key: 'price_type', header: 'Price', render: (r) => label(r.price_type) }, { key: 'mode', header: 'How', render: (r) => `${label(r.mode)} ${r.value}` }, { key: 'item_count', header: 'Items', align: 'right' }, { key: 'status', header: 'Status', type: 'badge' }, { key: 'created_at', header: 'Created', type: 'datetime' }]} /><Pager page={list.page} pageSize={list.pageSize} total={list.total} onPage={list.setPage} /></>}</div>
      {creating && <FormModal title="New price change" fields={fields} onClose={() => setCreating(false)} onSubmit={async (v) => { const r = await api.post('/prices/bulk/preview', v); toast.ok('Preview ready'); reload(); setOpen(r.id); }} />}
      {open && <BulkDetail id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}
function BulkDetail({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const q = useQuery({ queryKey: ['bulk', id], queryFn: () => api.get<Row>(`/prices/bulk/${id}`) }); const qc = useQueryClient(); const toast = useToast();
  const d = q.data; const re = () => { void qc.invalidateQueries({ queryKey: ['bulk', id] }); onChanged(); };
  return (
    <Modal wide title={d ? `${d.reference_no} · ${label(d.status)}` : 'Price change'} onClose={onClose} footer={d && <>
      {d.status === 'draft' && <ActionButton className="btn-primary" run={async () => { await api.post(`/prices/bulk/${id}/submit`); toast.ok('Submitted'); re(); }}>Submit</ActionButton>}
      {['draft', 'pending'].includes(d.status) && <ActionButton className="btn-ghost" confirm="Cancel this price change?" run={async () => { await api.post(`/prices/bulk/${id}/cancel`, {}); re(); }}>Cancel</ActionButton>}</>}>
      {q.isLoading || !d ? <Spinner /> : <><KeyValues data={d} skip={['items', 'skipped', 'id']} />
        <h3 className="mt-3 font-semibold">Items</h3>
        <DataTable rows={d.items} columns={[{ key: 'sku', header: 'SKU' }, { key: 'name', header: 'Product' }, { key: 'unit_code', header: 'Pack' }, { key: 'old_amount', header: 'Now', type: 'money' }, { key: 'new_amount', header: 'New', type: 'money' }, { key: 'warning', header: 'Warning', render: (r) => (r.warning ? <span className="text-amber-700">{r.warning}</span> : '') }]} />
        {d.skipped?.length > 0 && <><h3 className="mt-3 font-semibold">Skipped</h3><AutoTable rows={d.skipped} /></>}</>}
    </Modal>
  );
}
