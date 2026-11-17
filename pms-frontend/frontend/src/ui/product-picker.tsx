import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, Row } from '../lib/api';
import { useDebounced } from './kit';

export interface PickedProduct extends Row { id: string; name: string; sku: string; base_unit_id: string; units?: Array<{ unit_id: string; code: string; name: string; factor_to_base: string; is_sellable: boolean; is_purchasable: boolean }> }

/** Type to search by name, generic name or SKU; a scanned barcode followed by Enter picks that product directly. */
export function ProductPicker({ onPick, autoFocus, placeholder = 'Search product or scan barcode…', clearOnPick = true, extraQuery }: { onPick(p: PickedProduct): void; autoFocus?: boolean; placeholder?: string; clearOnPick?: boolean; extraQuery?: Record<string, string> }) {
  const [text, setText] = useState(''); const d = useDebounced(text, 150);
  const [open, setOpen] = useState(false); const [msg, setMsg] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['product-search', d, extraQuery], enabled: d.trim().length >= 2, queryFn: () => api.list('/products', { search: d.trim(), pageSize: 8, isActive: true, ...extraQuery }) });
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const pick = async (id: string) => {
    const full = await api.get<PickedProduct>(`/products/${id}`);
    onPick(full); setOpen(false); setMsg('');
    if (clearOnPick) setText('');
    ref.current?.focus();
  };
  const onEnter = async () => {
    const code = text.trim(); if (!code) return;
    try { const p = await api.get<PickedProduct>(`/products/by-barcode/${encodeURIComponent(code)}`); if (p?.id) { await pick(p.id); return; } } catch { /* not a barcode */ }
    if (q.data?.items.length === 1) await pick(q.data.items[0].id);
    else setMsg('No product with that barcode.');
  };
  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </span>
        <input
          ref={ref}
          className="input pl-10"
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onChange={(e) => { setText(e.target.value); setOpen(true); setMsg(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onEnter(); } }}
        />
      </div>
      {msg && <p className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">{msg}</p>}
      {open && d.trim().length >= 2 && (
        <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-slate-300 bg-white shadow-md dark:border-slate-700 dark:bg-slate-900">
          {q.isLoading && <li className="px-3 py-2 text-xs text-slate-500">Searching…</li>}
          {q.data?.items.length === 0 && <li className="px-3 py-2 text-xs text-slate-500">No matching products found</li>}
          {q.data?.items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left text-xs transition-colors hover:bg-brand-50 last:border-0 dark:border-slate-800 dark:hover:bg-brand-950/40"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(p.id)}
              >
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {p.name}{p.strength ? ` ${p.strength}` : ''}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-500 dark:bg-slate-800 dark:text-slate-400">
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
