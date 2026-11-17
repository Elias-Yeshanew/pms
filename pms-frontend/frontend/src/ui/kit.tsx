import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, Page, Row } from '../lib/api';
import { date, dateTime, label, money, qty } from '../lib/format';

// ---------- toasts ----------
interface Toast { id: number; kind: 'ok' | 'error'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => { const f = useContext(ToastCtx); return { ok: (t: string) => f('ok', t), error: (e: unknown) => f('error', errText(e)) }; };
export const errText = (e: unknown): string => (e instanceof ApiError ? `${e.message}${e.requestId ? ` (ref ${e.requestId.slice(0, 8)})` : ''}` : e instanceof Error ? e.message : String(e));
export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, kind, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2 pointer-events-none" role="status" aria-live="polite">
        {list.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-2.5 rounded border px-3 py-2 text-xs font-medium shadow-md transition-all ${
              t.kind === 'ok'
                ? 'bg-slate-900 text-white border-slate-800'
                : 'bg-red-900 text-white border-red-800'
            }`}
          >
            {t.kind === 'ok' ? (
              <svg className="h-4 w-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-4 w-4 shrink-0 text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            )}
            <span className="flex-1 leading-snug">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- basic pieces ----------
export const Spinner = ({ text = 'Loading…' }: { text?: string }) => (
  <div className="flex flex-col items-center justify-center gap-2.5 p-8 text-xs text-slate-500 dark:text-slate-400">
    <svg className="h-5 w-5 animate-spin text-brand-600 dark:text-brand-400" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
    <span className="font-medium">{text}</span>
  </div>
);

export const ErrorBox = ({ error }: { error: unknown }) => (
  <div className="flex items-start gap-2.5 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-900 shadow-xs dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
    <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <div className="flex-1 leading-snug font-medium">{errText(error)}</div>
  </div>
);

export const Empty = ({ text = 'Nothing to show.' }: { text?: string }) => (
  <div className="flex flex-col items-center justify-center p-8 text-center text-xs text-slate-500 dark:text-slate-400">
    <div className="mb-2 flex h-8 w-8 items-center justify-center rounded bg-slate-100 dark:bg-slate-800 text-slate-400">
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
      </svg>
    </div>
    <span className="font-medium">{text}</span>
  </div>
);

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white sm:text-xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

const TONE: Record<string, { bg: string; dot: string }> = {
  green: { bg: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60', dot: 'bg-emerald-600' },
  red: { bg: 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/60', dot: 'bg-rose-600' },
  amber: { bg: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60', dot: 'bg-amber-600' },
  blue: { bg: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60', dot: 'bg-blue-600' },
  purple: { bg: 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/60', dot: 'bg-purple-600' },
  gray: { bg: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-700', dot: 'bg-slate-500' },
};
const STATUS_TONE: Record<string, string> = {
  active: 'green', completed: 'green', approved: 'green', posted: 'green', valid: 'green', received: 'green', paid: 'green', available: 'green', resolved: 'green', open: 'blue', synced: 'green',
  pending: 'amber', pending_approval: 'amber', pending_inspection: 'amber', pending_validation: 'amber', draft: 'gray', submitted: 'blue', partially_received: 'amber', partially_returned: 'amber', in_transit: 'blue', quarantined: 'amber', dispatched: 'blue',
  inactive: 'gray', closed: 'gray', cancelled: 'gray', dismissed: 'gray', revoked: 'red', rejected: 'red', blocked: 'red', damaged: 'red', expired: 'red', returned: 'red', conflict: 'red', terminated: 'red',
};
export const Badge = ({ value, tone }: { value: unknown; tone?: keyof typeof TONE }) => {
  const v = String(value ?? '');
  const t = TONE[tone ?? STATUS_TONE[v] ?? 'gray'] ?? TONE.gray;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium border ${t.bg}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {label(v)}
    </span>
  );
};

// ---------- modal ----------
export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`my-8 w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} rounded-lg bg-white shadow-xl border border-slate-300 dark:border-slate-700 dark:bg-slate-900 overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-850">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white leading-tight">{title}</h2>
          <button className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors" onClick={onClose} aria-label="Close">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-4 sm:p-5 max-h-[calc(100vh-12rem)] overflow-y-auto text-xs">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-850">{footer}</div>}
      </div>
    </div>
  );
}

export function useConfirm() {
  const [state, setState] = useState<{ text: string; resolve(v: boolean): void } | null>(null);
  const ask = useCallback((text: string) => new Promise<boolean>((resolve) => setState({ text, resolve })), []);
  const dialog = state && (
    <Modal title="Please confirm" onClose={() => { state.resolve(false); setState(null); }}
      footer={<><button className="btn-ghost" onClick={() => { state.resolve(false); setState(null); }}>No</button><button className="btn-primary" onClick={() => { state.resolve(true); setState(null); }}>Yes</button></>}>
      <p className="text-sm text-slate-700 dark:text-slate-300">{state.text}</p>
    </Modal>
  );
  return { ask, dialog };
}

// ---------- tables ----------
export interface Column<T = Row> { key: string; header: string; render?(row: T): ReactNode; type?: 'money' | 'qty' | 'date' | 'datetime' | 'badge' | 'bool' | 'pct'; align?: 'right'; className?: string }
export function renderCell(c: Pick<Column, 'type'>, v: unknown): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="text-slate-400">–</span>;
  switch (c.type) {
    case 'money': return money(v);
    case 'qty': return qty(v);
    case 'pct': return `${Number(v).toFixed(2)}%`;
    case 'date': return date(v);
    case 'datetime': return dateTime(v);
    case 'badge': return <Badge value={v} />;
    case 'bool': return v ? <span className="text-emerald-600 font-bold">✓</span> : <span className="text-slate-400">–</span>;
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}
export function DataTable<T extends Row = Row>({ columns, rows, onRowClick, empty, footer }: { columns: Column<T>[]; rows: T[]; onRowClick?(r: T): void; empty?: string; footer?: ReactNode }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
      <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
        <thead><tr>{columns.map((c) => <th key={c.key} className={`th ${isNum(c) ? 'text-right' : ''}`}>{c.header}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 bg-white dark:bg-slate-900">
          {rows.map((r, i) => (
            <tr
              key={(r.id as string) ?? i}
              className={`transition-colors even:bg-slate-50/40 dark:even:bg-slate-800/20 ${onRowClick ? 'cursor-pointer hover:bg-brand-50/50 dark:hover:bg-brand-950/20' : ''}`}
              onClick={() => onRowClick?.(r)}
            >
              {columns.map((c) => <td key={c.key} className={`td ${isNum(c) ? 'text-right tabular-nums' : ''} ${c.className ?? ''}`}>{c.render ? c.render(r) : renderCell(c, r[c.key])}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );
}
const isNum = (c: Column<any>) => c.align === 'right' || c.type === 'money' || c.type === 'qty' || c.type === 'pct';

/** Builds columns from the data itself: used for line items and other shapes not worth a hand-written table. */
const HIDE = /(^id$|_id$|^version$|created_by|updated_by|updated_at|^sale_id$|request_hash|idempotency)/;
export function autoColumns(rows: Row[], max = 9): Column[] {
  const keys = Object.keys(rows[0] ?? {}).filter((k) => !HIDE.test(k) && typeof rows[0][k] !== 'object').slice(0, max);
  return keys.map((k) => ({ key: k, header: label(k), type: guessType(k, rows[0][k]) }));
}
function guessType(k: string, v: unknown): Column['type'] | undefined {
  if (/status$/.test(k) && typeof v === 'string') return 'badge';
  if (/_at$|^at$/.test(k)) return 'datetime';
  if (/(date|expiry)/.test(k)) return 'date';
  if (/(amount|total|price|cost|value|balance|subtotal|tax_amount|float|debit|credit)/.test(k) && typeof v === 'string') return 'money';
  if (/(quantity|qty|available|counted|expected|variance|reserved|sent|received|accepted)/.test(k) && typeof v === 'string') return 'qty';
  if (typeof v === 'boolean') return 'bool';
  return undefined;
}
export const AutoTable = ({ rows, onRowClick }: { rows: Row[]; onRowClick?(r: Row): void }) => <DataTable columns={autoColumns(rows)} rows={rows} onRowClick={onRowClick} />;

export function KeyValues({ data, skip = [] }: { data: Row; skip?: string[] }) {
  const entries = Object.entries(data).filter(([k, v]) => !HIDE.test(k) && !skip.includes(k) && v !== null && v !== '' && typeof v !== 'object');
  return (
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded border border-slate-200 bg-slate-50/50 p-2.5 dark:border-slate-800 dark:bg-slate-900/40">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label(k)}</dt>
          <dd className="mt-0.5 text-xs font-semibold text-slate-900 dark:text-slate-100">{renderCell({ type: guessType(k, v) }, v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage(p: number): void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <div className="border-t border-slate-200 px-3 py-2 text-xs font-medium text-slate-500 dark:border-slate-800">{total} record{total === 1 ? '' : 's'}</div>;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
      <span className="font-medium text-slate-500 dark:text-slate-400">{total} total records</span>
      <div className="flex items-center gap-1.5">
        <button className="btn-ghost py-1 px-2 text-xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300 px-1">
          Page {page} of {pages}
        </span>
        <button className="btn-ghost py-1 px-2 text-xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: Array<{ id: string; label: string }>; value: string; onChange(id: string): void }) {
  return (
    <div className="mb-4 flex gap-4 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`whitespace-nowrap pb-2 pt-1 text-xs font-semibold transition-colors border-b-2 -mb-px ${
            value === t.id
              ? 'border-brand-600 text-brand-700 dark:border-brand-400 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------- forms ----------
export interface Option { value: string; label: string }
export interface FieldDef {
  name: string; label: string; type?: 'text' | 'email' | 'password' | 'number' | 'decimal' | 'date' | 'datetime' | 'select' | 'lookup' | 'checkbox' | 'textarea' | 'multi';
  required?: boolean; options?: Option[]; help?: string; placeholder?: string; default?: unknown;
  lookup?: { path: string; label?: string | ((r: Row) => string); value?: string; query?: Record<string, string | undefined>; filter?: (r: Row) => boolean };
  show?(values: Row): boolean; readOnly?: boolean; min?: number; max?: number; span?: 2;
}

/** Loads a reference list once and keeps it for the session. */
export function useLookup(path: string | undefined, query?: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['lookup', path, query], enabled: !!path, staleTime: 5 * 60_000, queryFn: async () => (await api.list(path!, { pageSize: 100, ...query })).items });
}
const lbl = (r: Row, l?: string | ((r: Row) => string)) => (typeof l === 'function' ? l(r) : r[l ?? 'name'] ?? r.name ?? r.code ?? r.username ?? r.id);

export function LookupSelect({ spec, value, onChange, required, disabled, id }: { spec: NonNullable<FieldDef['lookup']>; value: string; onChange(v: string): void; required?: boolean; disabled?: boolean; id?: string }) {
  const { data, isLoading } = useLookup(spec.path, spec.query);
  const rows = (data ?? []).filter((r) => (spec.filter ? spec.filter(r) : true));
  return (
    <select id={id} className="input" value={value} required={required} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{isLoading ? 'Loading…' : 'Select…'}</option>
      {rows.map((r) => <option key={r[spec.value ?? 'id']} value={r[spec.value ?? 'id']}>{lbl(r, spec.label)}</option>)}
    </select>
  );
}

export function FieldInput({ f, value, onChange, idPrefix = 'f' }: { f: FieldDef; value: any; onChange(v: any): void; idPrefix?: string }) {
  const common = { id: `${idPrefix}-${f.name}`, required: f.required, disabled: f.readOnly, placeholder: f.placeholder };
  switch (f.type) {
    case 'textarea': return <textarea {...common} className="input min-h-[80px]" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'checkbox': return (
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 font-medium cursor-pointer">
        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={!!value} disabled={f.readOnly} onChange={(e) => onChange(e.target.checked)} />
        {f.help}
      </label>
    );
    case 'select': return <select {...common} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>{!f.required && <option value="">—</option>}{f.required && !value && <option value="">Select…</option>}{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
    case 'lookup': return <LookupSelect id={common.id} spec={f.lookup!} value={value ?? ''} onChange={onChange} required={f.required} disabled={f.readOnly} />;
    case 'multi': return <div className="flex flex-wrap gap-2.5">{f.options?.map((o) => { const on = (value ?? []).includes(o.value); return <label key={o.value} className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 font-medium"><input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={on} onChange={() => onChange(on ? value.filter((x: string) => x !== o.value) : [...(value ?? []), o.value])} />{o.label}</label>; })}</div>;
    case 'decimal': return <input {...common} className="input" inputMode="decimal" pattern="^\d+(\.\d{1,4})?$" title="A number with up to 4 decimals" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number': return <input {...common} className="input" type="number" min={f.min} max={f.max} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime': return <input {...common} className="input" type="datetime-local" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default: return <input {...common} className="input" type={f.type ?? 'text'} autoComplete={f.type === 'password' ? 'new-password' : 'off'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function initialValues(fields: FieldDef[], row?: Row | null): Row {
  const v: Row = {};
  for (const f of fields) {
    const raw = row ? row[f.name] ?? row[f.name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] : undefined;
    v[f.name] = raw ?? f.default ?? (f.type === 'checkbox' ? false : f.type === 'multi' ? [] : '');
    if (f.type === 'date' && typeof v[f.name] === 'string') v[f.name] = String(v[f.name]).slice(0, 10);
  }
  return v;
}
/** Drops empty optional values and turns numbers into numbers so the request body is clean. */
export function cleanValues(fields: FieldDef[], v: Row): Row {
  const out: Row = {};
  for (const f of fields) {
    if (f.show && !f.show(v)) continue;
    const x = v[f.name];
    if (x === '' || x === undefined || x === null) continue;
    out[f.name] = f.type === 'number' ? Number(x) : f.type === 'datetime' ? new Date(x).toISOString() : typeof x === 'string' ? x.trim() : x;
  }
  return out;
}

export function FormFields({ fields, values, setValues, idPrefix = 'f' }: { fields: FieldDef[]; values: Row; setValues(v: Row): void; idPrefix?: string }) {
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
      {fields.filter((f) => !f.show || f.show(values)).map((f) => (
        <div key={f.name} className={f.span === 2 || f.type === 'textarea' || f.type === 'multi' ? 'sm:col-span-2' : ''}>
          {f.type !== 'checkbox' && (
            <label className="label" htmlFor={`${idPrefix}-${f.name}`}>
              {f.label}{f.required && <span className="text-red-500"> *</span>}
            </label>
          )}
          {f.type === 'checkbox' && <span className="label">{f.label}</span>}
          <FieldInput f={f} idPrefix={idPrefix} value={values[f.name]} onChange={(v) => setValues({ ...values, [f.name]: v })} />
          {f.help && f.type !== 'checkbox' && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{f.help}</p>}
        </div>
      ))}
    </div>
  );
}

export function FormModal({ title, fields, row, submitLabel = 'Save', onClose, onSubmit, wide, children }: {
  title: string; fields: FieldDef[]; row?: Row | null; submitLabel?: string; onClose(): void; onSubmit(values: Row, raw: Row): Promise<unknown>; wide?: boolean; children?: ReactNode;
}) {
  const [values, setValues] = useState<Row>(() => initialValues(fields, row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await onSubmit(cleanValues(fields, values), values); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={submit} className="space-y-4">
        {error ? <ErrorBox error={error} /> : null}
        <FormFields fields={fields} values={values} setValues={setValues} />
        {children}
        <div className="flex justify-end gap-2.5 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

/** A button that runs an async action, shows progress, and reports errors. */
export function ActionButton({ children, run, className = 'btn-ghost', confirm, success, disabled }: { children: ReactNode; run(): Promise<unknown>; className?: string; confirm?: string; success?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const t = useToast(); const c = useConfirm();
  return (
    <>
      <button className={className} disabled={busy || disabled} onClick={async (e) => {
        e.stopPropagation();
        if (confirm && !(await c.ask(confirm))) return;
        setBusy(true);
        try { await run(); if (success) t.ok(success); } catch (err) { t.error(err); } finally { setBusy(false); }
      }}>{busy ? '…' : children}</button>
      {c.dialog}
    </>
  );
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <div className="relative max-w-xs w-full">
      <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-slate-400">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </span>
      <input className="input pl-8" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function usePagedList(path: string, query: Record<string, string | number | undefined>, pageSize = 25) {
  const [page, setPage] = useState(1);
  const key = JSON.stringify(query);
  useEffect(() => setPage(1), [key]);
  const q = useQuery({ queryKey: ['list', path, key, page, pageSize], queryFn: () => api.list(path, { ...query, page, pageSize }), placeholderData: (p) => p });
  return { ...q, page, setPage, pageSize, rows: q.data?.items ?? [], total: q.data?.total ?? 0 };
}
export type { Page };
export const useMemoRef = useMemo; export const _r = useRef;
