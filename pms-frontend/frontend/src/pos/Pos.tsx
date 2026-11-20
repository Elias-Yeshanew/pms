import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, newKey, Row } from '../lib/api';
import { useAuth, useBranch } from '../lib/auth';
import { money, qty as fmtQty } from '../lib/format';
import { lineTotal, percentDiscount, computeTax } from '../domain/pricing';
import { add, cmp, sub } from '../domain/decimal';
import { renderReceipt } from '../domain/receipt';
import { Modal, ErrorBox, Spinner, useToast, useDebounced, ActionButton } from '../ui/kit';
import {
  byBarcodeLocal, ensureDevice, fullSync, hasCatalogue, incrementalSync, isNetworkError, lastSync, localList, localStock, LocalProduct, packsFor, queueSale, searchLocal, settings, taxRuleFor, uploadQueue, useOnline,
} from './offline';

interface CartLine {
  key: string; productId: string; name: string; requiresRx: boolean; taxCategoryId: string | null;
  packs: Array<{ unit_id: string; name: string; factor_to_base: string; price: string | null }>; unitId: string; quantity: string; discountPercent: string;
  rule: { rate: string; inclusive: boolean; rounding: any } | null; stock: string | null;
}
interface Priced { gross: string; discount: string; net: string; tax: string; total: string }
interface PayRow { methodCode: string; amount: string; tendered: string; reference: string }

const REG_KEY = 'pms.pos.register', HELD_KEY = 'pms.pos.held';

function priceLine(l: CartLine, dp: number): Priced | null {
  const pack = l.packs.find((p) => p.unit_id === l.unitId);
  if (!pack?.price || !/^\d+(\.\d{1,4})?$/.test(l.quantity) || Number(l.quantity) <= 0) return null;
  const gross = lineTotal(pack.price, l.quantity, 'half_up', dp);
  const discount = l.discountPercent && Number(l.discountPercent) > 0 ? percentDiscount(gross, l.discountPercent, 'half_up', dp) : '0.0000';
  const taxable = sub(gross, discount);
  if (!l.rule) return { gross, discount, net: taxable, tax: '0.0000', total: taxable };
  const t = computeTax({ amount: taxable, ratePercent: l.rule.rate, inclusive: l.rule.inclusive, rounding: l.rule.rounding, currencyDecimals: dp });
  return { gross, discount, net: t.net, tax: t.tax, total: t.gross };
}

export function Pos() {
  const { me, can } = useAuth(); const { branchId } = useBranch(); const toast = useToast(); const online = useOnline();
  const [ready, setReady] = useState<'checking' | 'needs-sync' | 'syncing' | 'ready'>('checking');
  const [progress, setProgress] = useState(''); const [syncError, setSyncError] = useState<unknown>(null);
  const [registerId, setRegisterId] = useState(localStorage.getItem(REG_KEY) ?? '');
  const [deviceId, setDeviceId] = useState('');
  const [dp, setDp] = useState(2);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<Row | null>(null);
  const [rxId, setRxId] = useState('');
  const [discountRequestId, setDiscountRequestId] = useState('');
  const [paying, setPaying] = useState(false); const [done, setDone] = useState<{ text: string; ref: string; provisional: boolean; change: string } | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string; code?: string; details?: any } | null>(null);

  const regs = useQuery({
    queryKey: ['pos-registers', branchId, online], enabled: !!branchId,
    queryFn: async () => { try { return (await api.list('/cash-registers', { branchId: branchId!, pageSize: 50 })).items.filter((r) => r.status === 'active'); } catch { return (await localList('register')).filter((r) => r.branch_id === branchId && r.status === 'active'); } },
  });
  useEffect(() => { if (regs.data?.length && !regs.data.some((r) => r.id === registerId)) { setRegisterId(regs.data[0].id); } }, [regs.data, registerId]);
  useEffect(() => { if (registerId) localStorage.setItem(REG_KEY, registerId); }, [registerId]);
  const register = regs.data?.find((r) => r.id === registerId);

  // make sure this tablet has a device id and a catalogue
  const prepare = useCallback(async (force = false) => {
    if (!registerId) return;
    try {
      setSyncError(null);
      const have = await hasCatalogue();
      if (!online && !have) { setReady('needs-sync'); return; }
      if (online) {
        setReady(have && !force ? 'ready' : 'syncing');
        const id = await ensureDevice(registerId, `${register?.name ?? 'Register'} (${navigator.platform || 'browser'})`);
        setDeviceId(id);
        if (!have || force) { await fullSync(id, setProgress); } else { void incrementalSync(id).catch(() => undefined); void uploadQueue(id).then((r) => r.synced && toast.ok(`${r.synced} offline sale(s) uploaded`)).catch(() => undefined); }
      } else {
        const stored = await import('./offline').then((m) => m.getDeviceId(registerId)); if (stored) setDeviceId(stored);
      }
      setDp(((await settings())?.currencyDecimals) ?? 2);
      setReady('ready');
    } catch (e) { setSyncError(e); setReady('needs-sync'); }
  }, [registerId, online]); // eslint-disable-line
  useEffect(() => { void prepare(); }, [prepare]);
  useEffect(() => { if (!online || !deviceId) return; const t = setInterval(() => { void incrementalSync(deviceId).catch(() => undefined); void uploadQueue(deviceId).catch(() => undefined); }, 120_000); return () => clearInterval(t); }, [online, deviceId]);

  const methods = useQuery({ queryKey: ['pos-methods', online], queryFn: async () => { if (!online) return await localList('payment_method'); try { return (await api.list('/payment-methods')).items; } catch { return await localList('payment_method'); } } });
  const activeMethods = (methods.data ?? []).filter((m) => m.is_active).sort((a, b) => a.sort_order - b.sort_order);
  // Same query as the header BranchPicker, so it shares the cache. Only needed to explain why no branch is selected.
  const branches = useQuery({ queryKey: ['lookup', '/branches'], staleTime: 300_000, enabled: !branchId && can('branches.read'), queryFn: async () => (await api.list('/branches', { pageSize: 100 })).items });

  // ---- cart ----
  const addProduct = useCallback(async (p: LocalProduct, unitId?: string) => {
    const packs = await packsFor(p.id);
    if (!packs.length) { toast.error(new Error(`${p.name} has no sellable pack.`)); return; }
    const chosen = unitId ?? p.base_unit_id;
    const existing = cart.find((l) => l.productId === p.id && l.unitId === chosen);
    if (existing) { setCart(cart.map((l) => (l === existing ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l))); return; }
    const rule = await taxRuleFor(p.tax_category_id, new Date().toISOString().slice(0, 10));
    const pack = packs.find((x) => x.unit_id === chosen) ?? packs[0];
    if (!pack.price) { toast.error(new Error(`${p.name} has no selling price for ${pack.name}.`)); return; }
    setCart((c) => [...c, {
      key: crypto.randomUUID(), productId: p.id, name: p.strength ? `${p.name} ${p.strength}` : p.name, requiresRx: p.requires_prescription || p.is_controlled, taxCategoryId: p.tax_category_id,
      packs, unitId: pack.unit_id, quantity: '1', discountPercent: '', rule: rule ? { rate: rule.rate, inclusive: rule.is_inclusive, rounding: rule.rounding_rule } : null, stock: null,
    }]);
    void localStock(p.id).then((s) => setCart((c) => c.map((l) => (l.productId === p.id ? { ...l, stock: s } : l))));
  }, [cart, toast]);

  const priced = useMemo(() => cart.map((l) => priceLine(l, dp)), [cart, dp]);
  const totals = useMemo(() => priced.reduce((t, p) => (p ? { gross: add(t.gross, p.gross), discount: add(t.discount, p.discount), tax: add(t.tax, p.tax), total: add(t.total, p.total) } : t), { gross: '0.0000', discount: '0.0000', tax: '0.0000', total: '0.0000' }), [priced]);
  const invalid = cart.some((_, i) => !priced[i]);
  const needsRx = cart.some((l) => l.requiresRx);
  const blocked = needsRx && !online ? 'Prescription items cannot be sold without a connection.' : needsRx && !rxId ? 'Choose a validated prescription for the marked items.' : '';

  const hold = () => { const held = JSON.parse(localStorage.getItem(HELD_KEY) ?? '[]'); held.push({ at: Date.now(), cart, customer }); localStorage.setItem(HELD_KEY, JSON.stringify(held)); setCart([]); setCustomer(null); toast.ok('Sale put on hold'); };
  const clear = () => { setCart([]); setCustomer(null); setRxId(''); setDiscountRequestId(''); setMessage(null); };

  // keyboard shortcuts: F2 search, F9 pay
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'F9' && cart.length && !invalid && !blocked) { e.preventDefault(); setPaying(true); } if (e.key === 'F2') { e.preventDefault(); document.getElementById('pos-search')?.focus(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [cart.length, invalid, blocked]);

  if (!can('sales.create')) return <div className="card">You do not have permission to sell.</div>;
  if (!branchId) {
    // The header picker selects the first usable branch automatically, so getting here means there is none to pick.
    if (branches.isLoading) return <Spinner text="Loading branches…" />;
    if (branches.isError) return <div className="card mx-auto mt-10 max-w-md"><ErrorBox error={branches.error} /></div>;
    const canManage = can('branches.manage');
    return (
      <div className="card mx-auto mt-10 max-w-md space-y-3 text-center">
        <p className="font-semibold text-slate-900 dark:text-white">There is no active branch you can sell from.</p>
        <p className="text-sm text-slate-500">{canManage ? 'Add a branch and a cash register for it, then come back here.' : 'Ask an administrator to add a branch or give you access to one.'}</p>
        {canManage && <Link className="btn-primary inline-block" to="/admin/branches">Go to Branches</Link>}
      </div>
    );
  }
  if (regs.isSuccess && !regs.data.length) return <div className="card">This branch has no active cash register. Ask an administrator to add one.</div>;
  if (ready === 'checking' || ready === 'syncing') return <div className="card mx-auto mt-10 max-w-md text-center"><Spinner text={ready === 'syncing' ? `Preparing this tablet… ${progress}` : 'Starting…'} /></div>;
  if (ready === 'needs-sync') return (
    <div className="card mx-auto mt-10 max-w-md space-y-3 text-center">
      <p className="font-semibold text-slate-900 dark:text-white">This tablet needs to download the product list first.</p>
      <p className="text-sm text-slate-500">{online ? 'It will work offline afterwards.' : 'Connect to the internet once to do this.'}</p>
      {syncError ? <ErrorBox error={syncError} /> : null}
      <button className="btn-primary" disabled={!online} onClick={() => void prepare(true)}>Download now</button>
    </div>
  );

  const submitSale = async (payments: PayRow[]) => {
    const items = cart.map((l) => ({ productId: l.productId, unitId: l.unitId, quantity: l.quantity, ...(l.discountPercent && Number(l.discountPercent) > 0 ? { discountPercent: l.discountPercent } : {}) }));
    const body: Row = {
      registerId, idempotencyKey: newKey('POS'), items,
      payments: payments.map((p) => ({ methodCode: p.methodCode, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}) })),
      ...(customer ? { customerId: customer.id } : {}), ...(rxId ? { prescriptionId: rxId } : {}), ...(discountRequestId ? { discountRequestId } : {}),
    };
    const change = payments.reduce((t, p) => (p.tendered ? add(t, sub(p.tendered, p.amount)) : t), '0.0000');
    const tryOnline = async () => api.post('/sales', body);
    let sale: Row | null = null;
    if (online) {
      try { sale = await tryOnline(); } catch (e) {
        if (isNetworkError(e)) { try { sale = await tryOnline(); } catch (e2) { if (!isNetworkError(e2)) throw e2; } } else throw e;
      }
    }
    if (sale) {
      let text = '';
      try { const r = await api.get(`/sales/${sale.id}/receipt`); text = r.text; } catch { text = `Receipt ${sale.reference_no}\nTotal ${money(sale.total)}`; }
      setDone({ text, ref: sale.reference_no, provisional: false, change }); clear(); setPaying(false);
      return;
    }
    // no connection: keep the sale on the tablet and upload it later
    if (!deviceId) throw new Error('This tablet is offline and has not been set up for offline selling. Connect once and open the point of sale.');
    const offlineRef = `OFF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const soldAt = new Date().toISOString();
    await queueSale({ ...body, deviceId: undefined, offlineRef, soldAt }, { total: totals.total, items: cart.length });
    const methodName = (c: string) => activeMethods.find((m) => m.code === c)?.name ?? c;
    const text = renderReceipt({
      businessName: '', branchName: 'PROVISIONAL RECEIPT', reference: offlineRef, soldAt: soldAt.slice(0, 16).replace('T', ' '), cashier: me?.user.full_name ?? me?.user.username ?? '', customer: customer?.name ?? null, currency: 'ETB',
      lines: cart.map((l, i) => ({ name: l.name, unit: l.packs.find((p) => p.unit_id === l.unitId)?.name ?? '', quantity: l.quantity, unitPrice: l.packs.find((p) => p.unit_id === l.unitId)?.price ?? '0', discount: priced[i]?.discount ?? '0', total: priced[i]?.total ?? '0' })),
      subtotal: sub(totals.total, totals.tax), discountTotal: totals.discount, taxTotal: totals.tax, total: totals.total, payments: payments.map((p) => ({ method: methodName(p.methodCode), amount: p.amount, reference: p.reference })), changeGiven: change, creditTotal: '0.0000',
    }, 48);
    setDone({ text, ref: offlineRef, provisional: true, change }); clear(); setPaying(false);
  };

  return (
    <div className="grid gap-3.5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-3">
        <div className="card flex flex-wrap items-center gap-2.5 p-3">
          <div className="relative inline-flex items-center">
            <span className="pointer-events-none absolute left-2.5 text-slate-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </span>
            <select
              className="input w-auto py-1.5 pl-8 pr-7 text-xs font-semibold"
              aria-label="Register"
              value={registerId}
              onChange={(e) => setRegisterId(e.target.value)}
            >
              {(regs.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
            online
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
              : 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {online ? 'Online' : 'Offline Mode'}
          </span>
          <LastSync onSync={() => void prepare(true)} online={online} />
          <div className="flex-1" />
          <HeldCarts onResume={(h) => { setCart(h.cart); setCustomer(h.customer); }} />
        </div>

        <Search onAdd={addProduct} />

        <div className="card overflow-hidden p-0 shadow-sm">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center text-slate-500">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800 text-slate-400">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Cart is empty</p>
              <p className="mt-1 text-xs text-slate-500">Scan barcode or type to search products.</p>
              <div className="mt-3 flex gap-2">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-400">F2 search</span>
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-400">F9 pay</span>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200/80 dark:divide-slate-800">
                <thead>
                  <tr>
                    <th className="th">Item</th>
                    <th className="th">Pack</th>
                    <th className="th w-24">Qty</th>
                    <th className="th w-20">Disc %</th>
                    <th className="th text-right">Total</th>
                    <th className="th w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                  {cart.map((l, i) => (
                    <tr key={l.key} className="transition-colors even:bg-slate-50/30 dark:even:bg-slate-800/20">
                      <td className="td">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {l.name}
                          {l.requiresRx && (
                            <span className="ml-1.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.2 text-[10px] font-bold text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
                              Rx
                            </span>
                          )}
                        </div>
                        {l.stock !== null && Number(l.stock) < Number(l.quantity || 0) * Number(l.packs.find((p) => p.unit_id === l.unitId)?.factor_to_base ?? 1) && (
                          <div className="mt-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                            Only {fmtQty(l.stock)} in stock (base units)
                          </div>
                        )}
                      </td>
                      <td className="td">
                        <select className="input py-1 text-xs" value={l.unitId} onChange={(e) => setCart(cart.map((x) => (x === l ? { ...x, unitId: e.target.value } : x)))}>
                          {l.packs.map((p) => <option key={p.unit_id} value={p.unit_id}>{p.name} — {money(p.price ?? 0)}</option>)}
                        </select>
                      </td>
                      <td className="td">
                        <input className="input py-1 text-xs font-semibold tabular-nums text-center" inputMode="decimal" aria-label="Quantity" value={l.quantity} onChange={(e) => setCart(cart.map((x) => (x === l ? { ...x, quantity: e.target.value } : x)))} />
                      </td>
                      <td className="td">
                        <input className="input py-1 text-xs font-semibold tabular-nums text-center" inputMode="decimal" aria-label="Discount percent" value={l.discountPercent} onChange={(e) => setCart(cart.map((x) => (x === l ? { ...x, discountPercent: e.target.value } : x)))} />
                      </td>
                      <td className="td text-right font-bold tabular-nums text-slate-900 dark:text-white">
                        {priced[i] ? money(priced[i]!.total, dp) : <span className="text-red-500 font-bold">check</span>}
                      </td>
                      <td className="td text-right">
                        <button
                          aria-label="Remove"
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/40 dark:hover:text-rose-400 transition-colors"
                          onClick={() => setCart(cart.filter((x) => x !== l))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {needsRx && <PrescriptionPicker value={rxId} onChange={setRxId} customerId={customer?.id} branchId={branchId} online={online} />}
      </div>

      <div className="space-y-3">
        <CustomerPicker customer={customer} onChange={setCustomer} online={online} />

        <div className="card space-y-2 p-3.5">
          <Row2 l="Subtotal (gross)" v={money(totals.gross, dp)} />
          <Row2 l="Discount" v={`- ${money(totals.discount, dp)}`} />
          <Row2 l="Tax" v={money(totals.tax, dp)} />
          <div className="mt-2 rounded border border-slate-300 bg-slate-50 p-2.5 dark:border-slate-700 dark:bg-slate-800 flex items-center justify-between">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">Total Payable</span>
            </div>
            <span className="text-xl font-bold text-slate-900 dark:text-white tabular-nums">
              {money(totals.total, dp)}
            </span>
          </div>
        </div>

        {message && (
          <div className={`rounded border p-3 text-xs ${
            message.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200'
              : 'border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-900 dark:bg-brand-950/50 dark:text-brand-200'
          }`}>
            <p className="font-semibold">{message.text}</p>
            {message.code === 'DISCOUNT_APPROVAL_REQUIRED' && <DiscountRequest branchId={branchId} registerId={registerId} percent={String(message.details?.requested ?? '')} limit={message.details?.limit} onApproved={setDiscountRequestId} current={discountRequestId} />}
            {message.code === 'NO_OPEN_SESSION' && <Link className="mt-1.5 inline-block text-xs font-bold underline text-brand-600 dark:text-brand-400" to="/register-session">Open the register session →</Link>}
          </div>
        )}

        {blocked && cart.length > 0 && <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">{blocked}</p>}

        <button
          className="btn-primary w-full py-3.5 text-base font-bold shadow-lg shadow-brand-700/25 flex items-center justify-center gap-2"
          disabled={!cart.length || invalid || !!blocked}
          onClick={() => { setMessage(null); setPaying(true); }}
        >
          <span>Pay</span>
          <kbd className="rounded bg-brand-800/50 px-2 py-0.5 text-xs font-mono font-normal">F9</kbd>
        </button>

        <div className="flex gap-2">
          <button className="btn-ghost flex-1 py-2 text-xs font-semibold" disabled={!cart.length} onClick={hold}>
            Hold Sale
          </button>
          <button className="btn-ghost flex-1 py-2 text-xs font-semibold text-slate-500 hover:text-red-600" disabled={!cart.length} onClick={clear}>
            Clear
          </button>
        </div>
      </div>

      {paying && <PayDialog total={totals.total} methods={activeMethods} customer={customer} dp={dp} onClose={() => setPaying(false)} online={online}
        onSubmit={async (rows) => { try { await submitSale(rows); } catch (e) { setPaying(false); if (e instanceof ApiError) setMessage({ kind: 'error', text: e.message, code: e.code, details: e.details }); else setMessage({ kind: 'error', text: (e as Error).message }); } }} />}
      {done && <ReceiptDialog d={done} onClose={() => setDone(null)} />}
    </div>
  );
}

const Row2 = ({ l, v }: { l: string; v: string }) => (
  <div className="flex justify-between text-xs">
    <span className="text-slate-500 dark:text-slate-400 font-medium">{l}</span>
    <span className="tabular-nums font-semibold text-slate-800 dark:text-slate-200">{v}</span>
  </div>
);

function LastSync({ onSync, online }: { onSync(): void; online: boolean }) {
  const [t, setT] = useState('');
  useEffect(() => { void lastSync().then((v) => setT(v ? new Date(v).toLocaleTimeString() : '')); }, []);
  return (
    <button className="btn-ghost py-1 px-2.5 text-xs font-semibold" disabled={!online} onClick={onSync} title="Download the latest products and prices">
      <span className="flex items-center gap-1.5">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
        <span>Catalogue{t ? ` · ${t}` : ''}</span>
      </span>
    </button>
  );
}

function HeldCarts({ onResume }: { onResume(h: { cart: CartLine[]; customer: Row | null }): void }) {
  const [open, setOpen] = useState(false); const [held, setHeld] = useState<any[]>([]);
  useEffect(() => { if (open) setHeld(JSON.parse(localStorage.getItem(HELD_KEY) ?? '[]')); }, [open]);
  return (
    <>
      <button className="btn-ghost py-1 px-2.5 text-xs font-semibold" onClick={() => setOpen(true)}>
        Held sales {held.length > 0 && <span className="ml-1 rounded-full bg-brand-100 px-1.5 py-0.2 text-[10px] font-bold text-brand-700 dark:bg-brand-900 dark:text-brand-300">{held.length}</span>}
      </button>
      {open && <Modal title="Held sales" onClose={() => setOpen(false)}>
        {held.length === 0 ? <p className="text-sm text-slate-500">Nothing on hold. Held sales do not reserve stock.</p> : held.map((h, i) => (
          <div key={h.at} className="flex items-center justify-between border-b border-slate-100 py-2.5 text-sm dark:border-slate-800 last:border-0">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{new Date(h.at).toLocaleTimeString()}</span>
              <span className="text-xs text-slate-500 ml-2">({h.cart.length} item{h.cart.length === 1 ? '' : 's'}{h.customer ? ` · ${h.customer.name}` : ''})</span>
            </div>
            <span className="flex gap-2">
              <button className="btn-primary py-1 px-2.5 text-xs" onClick={() => { const rest = held.filter((_, j) => j !== i); localStorage.setItem(HELD_KEY, JSON.stringify(rest)); onResume(h); setOpen(false); }}>Resume</button>
              <button className="btn-ghost py-1 px-2 text-xs text-slate-400 hover:text-red-600" onClick={() => { const rest = held.filter((_, j) => j !== i); localStorage.setItem(HELD_KEY, JSON.stringify(rest)); setHeld(rest); }}>Delete</button>
            </span>
          </div>
        ))}
      </Modal>}
    </>
  );
}

function Search({ onAdd }: { onAdd(p: LocalProduct, unitId?: string): void }) {
  const [text, setText] = useState(''); const d = useDebounced(text, 120); const [res, setRes] = useState<LocalProduct[]>([]); const [msg, setMsg] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { void searchLocal(d).then(setRes); }, [d]);
  useEffect(() => ref.current?.focus(), []);
  const enter = async () => {
    const code = text.trim(); if (!code) return;
    const b = await byBarcodeLocal(code);
    if (b) { onAdd(b.product, b.unitId); setText(''); setMsg(''); return; }
    if (res.length === 1) { onAdd(res[0]); setText(''); return; }
    setMsg('No product with that barcode.');
  };
  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
          </svg>
        </span>
        <input
          id="pos-search"
          ref={ref}
          className="input py-3 pl-11 pr-14 text-base font-medium shadow-sm"
          autoComplete="off"
          placeholder="Scan barcode or search product name / SKU…"
          value={text}
          onChange={(e) => { setText(e.target.value); setMsg(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void enter(); } }}
        />
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
          <kbd className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-bold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            F2
          </kbd>
        </div>
      </div>
      {msg && <p className="mt-1.5 text-xs font-semibold text-red-600 dark:text-red-400">{msg}</p>}
      {res.length > 0 && text.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {res.map((p) => (
            <li key={p.id}>
              <button
                className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-brand-50/60 last:border-0 dark:border-slate-800 dark:hover:bg-brand-950/40"
                onClick={() => { onAdd(p); setText(''); ref.current?.focus(); }}
              >
                <div>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {p.name}{p.strength ? ` ${p.strength}` : ''}
                  </span>
                  {(p.requires_prescription || p.is_controlled) && (
                    <span className="ml-1.5 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.2 text-[10px] font-bold text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
                      Rx
                    </span>
                  )}
                </div>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  {p.sku}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomerPicker({ customer, onChange, online }: { customer: Row | null; onChange(c: Row | null): void; online: boolean }) {
  const [open, setOpen] = useState(false); const [s, setS] = useState(''); const d = useDebounced(s);
  const q = useQuery({ queryKey: ['pos-customers', d, online], enabled: open, queryFn: async () => { try { return (await api.list('/customers', { search: d || undefined, status: 'active', pageSize: 10 })).items; } catch { return (await localList('customer')).filter((c) => c.status === 'active' && (!d || c.name.toLowerCase().includes(d.toLowerCase()) || (c.phone ?? '').includes(d))).slice(0, 10); } } });
  return (
    <div className="card text-sm p-3.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Customer</span>
        {customer ? (
          <button className="text-xs font-semibold text-rose-600 hover:underline" onClick={() => onChange(null)}>
            Remove
          </button>
        ) : (
          <button className="text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => setOpen(true)}>
            Choose
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
        <div className="font-semibold text-slate-900 dark:text-white">
          {customer ? `${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}` : 'Walk-in Customer'}
        </div>
      </div>
      {open && <Modal title="Choose customer" onClose={() => setOpen(false)}>
        <input className="input mb-3" autoFocus placeholder="Name or phone number…" value={s} onChange={(e) => setS(e.target.value)} />
        <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {(q.data ?? []).map((c) => (
            <button key={c.id} className="block w-full px-3 py-2.5 text-left text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => { onChange(c); setOpen(false); }}>
              <div className="font-semibold text-slate-900 dark:text-white">{c.name}</div>
              <div className="text-xs text-slate-500">{c.phone}</div>
            </button>
          ))}
          {q.data?.length === 0 && <p className="py-4 text-center text-xs text-slate-500">No customers found. Add them under Customers.</p>}
        </div>
      </Modal>}
    </div>
  );
}

function PrescriptionPicker({ value, onChange, customerId, branchId, online }: { value: string; onChange(v: string): void; customerId?: string; branchId: string; online: boolean }) {
  const q = useQuery({ queryKey: ['pos-rx', customerId, branchId], enabled: online, queryFn: async () => (await api.list('/prescriptions', { status: 'valid', branchId, customerId, pageSize: 50 })).items });
  return (
    <div className="card border-rose-200 bg-rose-50/40 dark:border-rose-900/60 dark:bg-rose-950/20">
      <label className="label text-rose-800 dark:text-rose-300">Prescription (required for marked items)</label>
      {!online ? (
        <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Prescriptions can only be verified online. Reconnect to sell these items.</p>
      ) : (
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select a validated prescription…</option>
          {(q.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.reference_no ?? r.id.slice(0, 8)} · {r.patient_name} · {r.prescriber_name}
            </option>
          ))}
        </select>
      )}
      <p className="mt-1 text-[11px] text-slate-500">New prescriptions are entered and validated under Prescriptions.</p>
    </div>
  );
}

function DiscountRequest({ branchId, registerId, percent, limit, onApproved, current }: { branchId: string; registerId: string; percent: string; limit?: string; onApproved(id: string): void; current: string }) {
  const [reason, setReason] = useState(''); const [reqId, setReqId] = useState(current); const toast = useToast();
  return (
    <div className="mt-2.5 space-y-2 text-slate-900 dark:text-slate-100">
      <p className="text-xs">The limit is {limit}%. Ask a manager to approve {percent}%.</p>
      {!reqId ? (
        <div className="space-y-2">
          <input className="input text-xs" placeholder="Reason for discount…" value={reason} onChange={(e) => setReason(e.target.value)} />
          <ActionButton className="btn-primary py-1.5 text-xs" run={async () => { const r = await api.post('/discount-requests', { branchId, registerId, percent, reason }); setReqId(r.id); toast.ok('Sent to a manager'); }}>Request approval</ActionButton>
        </div>
      ) : (
        <ActionButton className="btn-ghost py-1.5 text-xs" run={async () => { const r = await api.get(`/discount-requests/${reqId}`); if (r.status === 'approved') { onApproved(reqId); toast.ok('Approved. Press Pay again.'); } else toast.ok(`Status: ${r.status}`); }}>Check approval</ActionButton>
      )}
    </div>
  );
}

function PayDialog({ total, methods, customer, dp, onClose, onSubmit, online }: { total: string; methods: Row[]; customer: Row | null; dp: number; onClose(): void; onSubmit(rows: PayRow[]): Promise<void>; online: boolean }) {
  const usable = methods.filter((m) => !m.is_credit || (customer && online));
  const [rows, setRows] = useState<PayRow[]>([{ methodCode: usable.find((m) => m.is_cash)?.code ?? usable[0]?.code ?? '', amount: total, tendered: '', reference: '' }]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (usable.length && rows.some((r) => !r.methodCode)) setRows(rows.map((r) => (r.methodCode ? r : { ...r, methodCode: usable.find((m) => m.is_cash)?.code ?? usable[0].code }))); }, [usable.length]); // eslint-disable-line
  const paid = rows.reduce((t, r) => (/^\d+(\.\d{1,4})?$/.test(r.amount) ? add(t, r.amount) : t), '0.0000');
  const remaining = sub(total, paid);
  const method = (c: string) => methods.find((m) => m.code === c);
  const valid = cmp(remaining, '0') === 0 && rows.every((r) => !!r.methodCode && Number(r.amount) > 0 && (!method(r.methodCode)?.requires_reference || r.reference.trim()) && (!r.tendered || cmp(r.tendered, r.amount) >= 0));
  const change = rows.reduce((t, r) => (r.tendered && cmp(r.tendered, r.amount) >= 0 ? add(t, sub(r.tendered, r.amount)) : t), '0.0000');
  const set = (i: number, p: Partial<PayRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Modal title={`Payment · ${money(total, dp)}`} onClose={onClose} footer={<><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary px-8" disabled={!valid || busy} onClick={async () => { setBusy(true); await onSubmit(rows); setBusy(false); }}>{busy ? 'Saving…' : 'Complete sale'}</button></>}>
      <div className="space-y-3.5">
        {rows.map((r, i) => {
          const m = method(r.methodCode);
          return (
            <div key={i} className="grid grid-cols-2 gap-2.5 rounded border border-slate-200 bg-slate-50/70 p-2.5 dark:border-slate-700 dark:bg-slate-800/40">
              <select className="input font-semibold" value={r.methodCode} onChange={(e) => set(i, { methodCode: e.target.value, tendered: '' })}>{usable.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
              <input className="input font-bold tabular-nums" inputMode="decimal" aria-label="Amount" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} />
              {m?.is_cash && <input className="input font-semibold" inputMode="decimal" placeholder="Cash handed over" value={r.tendered} onChange={(e) => set(i, { tendered: e.target.value })} />}
              {m?.requires_reference && <input className="input" placeholder="Reference / transaction id" value={r.reference} onChange={(e) => set(i, { reference: e.target.value })} />}
              {rows.length > 1 && <button className="col-span-2 text-left text-xs font-semibold text-rose-600" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove this payment</button>}
            </div>
          );
        })}
        <button className="btn-ghost text-xs" disabled={cmp(remaining, '0') <= 0} onClick={() => setRows([...rows, { methodCode: usable[0]?.code ?? '', amount: remaining, tendered: '', reference: '' }])}>
          + Split payment
        </button>
        <div className="flex justify-between items-center rounded border border-slate-200 bg-slate-50 p-2.5 text-sm dark:border-slate-800 dark:bg-slate-800/50">
          <span className="font-medium text-slate-600 dark:text-slate-300">Remaining</span>
          <b className={`font-bold tabular-nums text-base ${cmp(remaining, '0') === 0 ? 'text-brand-600 dark:text-brand-400' : 'text-red-600 dark:text-red-400'}`}>{money(remaining, dp)}</b>
        </div>
        {cmp(change, '0') > 0 && (
          <div className="flex justify-between items-center rounded border border-brand-300 bg-brand-50 p-3 text-brand-900 dark:bg-brand-950/60 dark:text-brand-200 dark:border-brand-800">
            <span className="font-semibold text-xs uppercase tracking-wider">Change Due</span>
            <span className="text-xl font-bold tabular-nums">{money(change, dp)}</span>
          </div>
        )}
        {!online && <p className="text-xs text-amber-800 dark:text-amber-300">Offline: this sale will be saved on the tablet and sent when connection returns.</p>}
      </div>
    </Modal>
  );
}

function ReceiptDialog({ d, onClose }: { d: { text: string; ref: string; provisional: boolean; change: string }; onClose(): void }) {
  return (
    <Modal title={d.provisional ? `Saved on tablet · ${d.ref}` : `Sale complete · ${d.ref}`} onClose={onClose} footer={<><button className="btn-ghost" onClick={() => window.print()}>Print receipt</button><button className="btn-primary" onClick={onClose}>New sale</button></>}>
      {Number(d.change) > 0 && <div className="mb-3 rounded border border-brand-300 bg-brand-50 p-2.5 text-center text-lg font-bold text-brand-900 dark:bg-brand-950/50 dark:text-brand-200 dark:border-brand-800">Change: {money(d.change)}</div>}
      {d.provisional && <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">No connection. This sale will upload automatically. Give customer provisional receipt.</p>}
      <pre className="print-area overflow-x-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-black dark:border-slate-700 dark:bg-white">{d.text}</pre>
    </Modal>
  );
}
