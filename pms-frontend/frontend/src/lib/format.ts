export const money = (v: unknown, dp = 2): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
export const qty = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
};
export const pct = (v: unknown) => (v === null || v === undefined || v === '' ? '' : `${Number(v).toFixed(2)}%`);
export const date = (v: unknown): string => (v ? String(v).slice(0, 10) : '');
export const dateTime = (v: unknown): string => {
  if (!v) return '';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};
export const label = (s: unknown): string => String(s ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const today = () => new Date().toISOString().slice(0, 10);
export const isDecimal = (s: string) => /^\d+(\.\d{1,4})?$/.test(s.trim());
export const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => { let t: number; return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); }; };
