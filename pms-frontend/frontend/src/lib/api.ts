const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';
const ACCESS = 'pms.access', REFRESH = 'pms.refresh';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) { super(message); }
  /** true when there was no answer at all (offline, server down) */
  get network() { return this.status === 0; }
}

export const tokens = {
  get access() { return sessionStorage.getItem(ACCESS) ?? ''; },
  get refresh() { return localStorage.getItem(REFRESH) ?? ''; },
  set(access: string, refresh: string) { sessionStorage.setItem(ACCESS, access); localStorage.setItem(REFRESH, refresh); },
  clear() { sessionStorage.removeItem(ACCESS); localStorage.removeItem(REFRESH); },
};

type Query = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Query) => {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

let onSignedOut: () => void = () => undefined;
export const setSignedOutHandler = (fn: () => void) => { onSignedOut = fn; };

let refreshing: Promise<boolean> | null = null;
async function refreshTokens(): Promise<boolean> {
  if (!tokens.refresh) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: tokens.refresh }) });
      if (!res.ok) return false;
      const b = await res.json();
      tokens.set(b.accessToken, b.refreshToken);
      return true;
    } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

async function raw(method: string, path: string, opts: { query?: Query; body?: unknown; form?: FormData; retry?: boolean } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (tokens.access) headers.authorization = `Bearer ${tokens.access}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs(opts.query)}`, { method, headers, body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check the connection.');
  }
  if (res.status === 401 && opts.retry !== false && !path.startsWith('/auth/')) {
    if (await refreshTokens()) return raw(method, path, { ...opts, retry: false });
    tokens.clear(); onSignedOut();
  }
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new ApiError(res.status, b.code ?? 'ERROR', b.message ?? `Request failed (${res.status})`, b.details, b.requestId);
  }
  return res;
}

async function json<T>(method: string, path: string, opts?: Parameters<typeof raw>[2]): Promise<T> {
  const res = await raw(method, path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export type Row = Record<string, any>;

/** Lists that do not take paging (or some filters): remembered after the first refusal so later calls are clean. */
const unpaged = new Map<string, string[]>([['/warehouses', ['page', 'pageSize']], ['/cash-registers', ['page', 'pageSize']], ['/tax-rules', ['page', 'pageSize']], ['/storage-locations', ['page', 'pageSize']], ['/inventory/stock/summary', ['page', 'pageSize']], ['/inventory/low-stock', ['page', 'pageSize']], ['/inventory/expiring', ['page', 'pageSize']], ['/inventory/batches', ['page', 'pageSize']], ['/procurement/reorder-suggestions', ['page', 'pageSize']]]);
export const api = {
  get: <T = any>(path: string, query?: Query) => json<T>('GET', path, { query }),
  post: <T = any>(path: string, body: unknown = {}, query?: Query) => json<T>('POST', path, { body, query }),
  put: <T = any>(path: string, body: unknown = {}) => json<T>('PUT', path, { body }),
  patch: <T = any>(path: string, body: unknown = {}) => json<T>('PATCH', path, { body }),
  del: <T = any>(path: string) => json<T>('DELETE', path),
  upload: <T = any>(method: 'PUT' | 'POST', path: string, file: File, field = 'file') => { const f = new FormData(); f.append(field, file); return json<T>(method, path, { form: f }); },
  /** Lists come back either as a plain array or as { items, total }; this always gives a page. */
  async list<T = Row>(path: string, query?: Query): Promise<Page<T>> {
    let r: any;
    const known = unpaged.get(path);
    if (known && query) { query = { ...query }; for (const k of known) delete query[k]; }
    try { r = await json<any>('GET', path, { query }); } catch (e) {
      // some lists are not paged or take fewer filters: drop what the server says it does not know and retry once
      const bad = e instanceof ApiError && e.code === 'VALIDATION_ERROR' && Array.isArray(e.details) ? (e.details as string[]).map((d) => /^property (\w+) should not exist/.exec(d)?.[1]).filter(Boolean) as string[] : [];
      if (!bad.length || !query) throw e;
      unpaged.set(path, [...new Set([...(unpaged.get(path) ?? []), ...bad])]);
      const q2 = { ...query }; for (const k of bad) delete q2[k];
      r = await json<any>('GET', path, { query: q2 });
    }
    if (Array.isArray(r)) return { items: r, total: r.length, page: 1, pageSize: r.length };
    return r;
  },
  async blob(path: string, query?: Query): Promise<{ blob: Blob; filename: string }> {
    const res = await raw('GET', path, { query });
    const cd = res.headers.get('content-disposition') ?? '';
    return { blob: await res.blob(), filename: /filename="([^"]+)"/.exec(cd)?.[1] ?? 'download' };
  },
  async download(path: string, query?: Query) {
    const { blob, filename } = await this.blob(path, query);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  /** Image or file as an object URL (the request needs the auth header, so <img src> cannot be used directly). */
  async objectUrl(path: string): Promise<string> { return URL.createObjectURL((await this.blob(path)).blob); },
};

export function newKey(prefix = 'K'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
