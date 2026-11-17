import { ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Row } from '../lib/api';
import { FieldDef, FieldInput } from './kit';
import { PickedProduct, ProductPicker } from './product-picker';

export interface Line { key: string; product: PickedProduct; [field: string]: any }
export interface LineField extends FieldDef { width?: string; render?(line: Line, set: (name: string, v: any) => void): ReactNode }

/** Batches of one product with how much is available; leave blank is not allowed where a batch is required. */
export function BatchSelect({ productId, value, onChange, required }: { productId: string; value: string; onChange(v: string): void; required?: boolean }) {
  const q = useQuery({ queryKey: ['batches', productId], queryFn: async () => (await api.list('/inventory/batches', { productId })).items });
  return <select className="input" required={required} value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">{q.isLoading ? 'Loading…' : 'Select batch…'}</option>{(q.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.batch_ref} · exp {b.expiry_date} · {Number(b.available)} avail.</option>)}</select>;
}

/** A list of product lines: pick a product, then fill the extra columns (quantity, price, batch, ...). */
export function LinesEditor({ lines, setLines, fields, unitField = true, purchasable, sellable, label = 'Items' }: {
  lines: Line[]; setLines(l: Line[]): void; fields: LineField[]; unitField?: boolean; purchasable?: boolean; sellable?: boolean; label?: string;
}) {
  const add = (p: PickedProduct) => {
    const init: Row = {};
    for (const f of fields) init[f.name] = f.default ?? (f.type === 'checkbox' ? false : '');
    setLines([...lines, { key: crypto.randomUUID(), product: p, unitId: p.base_unit_id, ...init }]);
  };
  const set = (key: string, name: string, v: any) => setLines(lines.map((l) => (l.key === key ? { ...l, [name]: v } : l)));
  return (
    <div>
      <span className="label">{label}</span>
      <ProductPicker onPick={add} />
      {lines.length > 0 && (
        <div className="mt-2.5 overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
          <table className="min-w-full text-xs divide-y divide-slate-200 dark:divide-slate-800">
            <thead>
              <tr>
                <th className="th">Product</th>
                {unitField && <th className="th">Pack</th>}
                {fields.map((f) => <th key={f.name} className="th">{f.label}</th>)}
                <th className="th w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 bg-white dark:bg-slate-900">
              {lines.map((l) => {
                const units = (l.product.units ?? []).filter((u) => (purchasable ? u.is_purchasable : sellable ? u.is_sellable : true));
                return (
                  <tr key={l.key} className="align-middle transition-colors even:bg-slate-50/30 dark:even:bg-slate-800/20">
                    <td className="td min-w-[10rem]">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{l.product.name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{l.product.sku}</div>
                    </td>
                    {unitField && (
                      <td className="td">
                        <select className="input py-1 text-xs" value={l.unitId} onChange={(e) => set(l.key, 'unitId', e.target.value)}>
                          {units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.name}{u.factor_to_base !== '1.0000' ? ` (×${Number(u.factor_to_base)})` : ''}</option>)}
                        </select>
                      </td>
                    )}
                    {fields.filter((f) => !f.show || f.show(l)).map((f) => (
                      <td key={f.name} className="td min-w-[7rem]" style={f.width ? { minWidth: f.width } : undefined}>
                        {f.render ? f.render(l, (n, v) => set(l.key, n, v)) : <FieldInput f={{ ...f, required: f.required }} value={l[f.name]} onChange={(v) => set(l.key, f.name, v)} />}
                      </td>
                    ))}
                    <td className="td text-right">
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-400 transition-colors"
                        aria-label="Remove line"
                        onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
export const useLines = () => useState<Line[]>([]);
