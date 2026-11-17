import { openDB, IDBPDatabase } from 'idb';
import { useEffect, useState } from 'react';
import { api, ApiError, Row } from '../lib/api';

/** Entities mirrored on the tablet; names match GET /sync/snapshot/:entity. */
export const ENTITIES = ['unit', 'tax_category', 'tax_rule', 'payment_method', 'product', 'product_unit', 'barcode', 'price', 'customer', 'register'] as const;
export type Entity = (typeof ENTITIES)[number];
export interface QueuedSale { offlineRef: string; body: Row; state: 'waiting' | 'conflict' | 'error'; conflictId?: string; code?: string; message?: string; queuedAt: string; summary: { total: string; items: number } }

let dbp: Promise<IDBPDatabase> | null = null;
export function db() {
  dbp ??= openDB('pms-pos', 1, {
    upgrade(d) {
      d.createObjectStore('meta');
      for (const e of ENTITIES) d.createObjectStore(e, { keyPath: 'id' });
      d.createObjectStore('stock', { keyPath: 'productId' });
      d.createObjectStore('queue', { keyPath: 'offlineRef' });
    },
  });
  return dbp;
}
const meta = {
  get: async <T = any>(k: string) => (await db()).get('meta', k) as Promise<T | undefined>,
  set: async (k: string, v: unknown) => { await (await db()).put('meta', v, k); },
};

// ---------- events ----------
const bus = new EventTarget();
const emit = () => bus.dispatchEvent(new Event('change'));
export function useOnline(): boolean {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => { const u = () => setOn(true), d = () => setOn(false); window.addEventListener('online', u); window.addEventListener('offline', d); return () => { window.removeEventListener('online', u); window.removeEventListener('offline', d); }; }, []);
  return on;
}
export function useQueueCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => { const f = async () => setN((await (await db()).getAll('queue')).filter((s: QueuedSale) => s.state === 'waiting').length); void f(); bus.addEventListener('change', f); return () => bus.removeEventListener('change', f); }, []);
  return n;
}

// ---------- device ----------
export const getDeviceId = (registerId: string) => meta.get<string>(`device:${registerId}`);
export async function ensureDevice(registerId: string, name: string): Promise<string> {
  const have = await getDeviceId(registerId);
  if (have) return have;
  const d = await api.post('/sync/devices', { name, platform: navigator.platform || 'browser', registerId });
  await meta.set(`device:${registerId}`, d.id);
  return d.id;
}
export const forgetDevice = (registerId: string) => meta.set(`device:${registerId}`, undefined);
export const lastSync = () => meta.get<string>('lastSync');
export const hasCatalogue = async () => (await (await db()).count('product')) > 0;

// ---------- download ----------
export async function fullSync(deviceId: string, onProgress?: (text: string) => void) {
  const cur = await api.get('/sync/cursor', { deviceId });
  const d = await db();
  for (const e of ENTITIES) {
    onProgress?.(`Downloading ${e.replace('_', ' ')}…`);
    await d.clear(e);
    let after: string | undefined;
    for (;;) {
      const r = await api.get('/sync/snapshot/' + e, { deviceId, limit: 500, afterId: after });
      const tx = d.transaction(e, 'readwrite');
      for (const item of r.items) tx.store.put(item);
      await tx.done;
      if (!r.hasMore) break;
      after = r.nextAfterId;
    }
  }
  await refreshStock(deviceId);
  await meta.set('cursor', cur.cursor); await meta.set('settings', cur.settings); await meta.set('lastSync', new Date().toISOString());
  emit();
}
export async function refreshStock(deviceId: string) {
  const s = await api.get('/sync/stock', { deviceId });
  const d = await db(); const tx = d.transaction('stock', 'readwrite'); await tx.store.clear();
  for (const i of s.items) tx.store.put(i);
  await tx.done;
}
/** Applies what changed on the server since the last sync. Cheap enough to run every few minutes. */
export async function incrementalSync(deviceId: string): Promise<number> {
  let since = (await meta.get<number>('cursor')) ?? 0, n = 0;
  const d = await db();
  for (;;) {
    const r = await api.get('/sync/changes', { deviceId, since, limit: 500 });
    for (const c of r.changes) {
      if (!ENTITIES.includes(c.entity)) continue;
      if (c.op === 'delete') await d.delete(c.entity, c.id); else await d.put(c.entity, c.data);
      n++;
    }
    since = r.cursor; await meta.set('cursor', since);
    if (!r.hasMore) break;
  }
  await refreshStock(deviceId).catch(() => undefined);
  await meta.set('lastSync', new Date().toISOString());
  emit();
  return n;
}

// ---------- local lookups ----------
export interface LocalProduct { id: string; sku: string; name: string; generic_name: string | null; strength: string | null; base_unit_id: string; requires_prescription: boolean; is_controlled: boolean; tax_category_id: string | null; is_active: boolean }
export async function searchLocal(text: string, limit = 12): Promise<LocalProduct[]> {
  const t = text.trim().toLowerCase(); if (t.length < 2) return [];
  const all: LocalProduct[] = await (await db()).getAll('product');
  return all.filter((p) => p.is_active && (p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || (p.generic_name ?? '').toLowerCase().includes(t))).slice(0, limit);
}
export async function byBarcodeLocal(code: string) {
  const d = await db();
  const all: Row[] = await d.getAll('barcode');
  const b = all.find((x) => x.barcode === code.trim());
  if (!b) return null;
  const product = (await d.get('product', b.product_id)) as LocalProduct | undefined;
  return product ? { product, unitId: b.unit_id as string } : null;
}
export async function packsFor(productId: string): Promise<Array<{ unit_id: string; name: string; factor_to_base: string; price: string | null }>> {
  const d = await db();
  const pus = ((await d.getAll('product_unit')) as Row[]).filter((x) => x.product_id === productId && x.is_sellable);
  const units = new Map(((await d.getAll('unit')) as Row[]).map((u) => [u.id, u]));
  const prices = ((await d.getAll('price')) as Row[]).filter((p) => p.product_id === productId && p.price_type === 'selling' && !p.effective_to);
  return pus.map((pu) => ({ unit_id: pu.unit_id, name: units.get(pu.unit_id)?.name ?? '?', factor_to_base: pu.factor_to_base, price: prices.find((p) => p.unit_id === pu.unit_id)?.amount ?? null }));
}
export async function taxRuleFor(categoryId: string | null, onDate: string): Promise<Row | null> {
  if (!categoryId) return null;
  const rules = ((await (await db()).getAll('tax_rule')) as Row[]).filter((r) => r.tax_category_id === categoryId && String(r.effective_from).slice(0, 10) <= onDate && (!r.effective_to || String(r.effective_to).slice(0, 10) >= onDate));
  return rules.sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)))[0] ?? null;
}
export const localStock = async (productId: string): Promise<string | null> => ((await (await db()).get('stock', productId)) as Row | undefined)?.available ?? null;
export const localList = async (e: Entity): Promise<Row[]> => (await db()).getAll(e);
export const settings = () => meta.get<{ maxOfflineHours: number; currencyDecimals: number }>('settings');

// ---------- queue ----------
export async function queueSale(body: Row, summary: QueuedSale['summary']) {
  const q: QueuedSale = { offlineRef: body.offlineRef, body, state: 'waiting', queuedAt: new Date().toISOString(), summary };
  await (await db()).put('queue', q); emit();
}
export const listQueue = async (): Promise<QueuedSale[]> => ((await (await db()).getAll('queue')) as QueuedSale[]).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
export async function removeQueued(ref: string) { await (await db()).delete('queue', ref); emit(); }

let uploading = false;
/** Sends waiting sales, oldest first, 25 at a time. A sale leaves the queue only once the server has answered about it. */
export async function uploadQueue(deviceId: string): Promise<{ synced: number; conflicts: number }> {
  if (uploading) return { synced: 0, conflicts: 0 };
  uploading = true;
  let synced = 0, conflicts = 0;
  try {
    const d = await db();
    const waiting = (await listQueue()).filter((s) => s.state === 'waiting');
    for (let i = 0; i < waiting.length; i += 25) {
      const batch = waiting.slice(i, i + 25);
      const r = await api.post('/sync/sales', { deviceId, sales: batch.map((b) => b.body) });
      for (const res of r.results) {
        const q = batch.find((b) => b.offlineRef === res.offlineRef); if (!q) continue;
        if (res.status === 'synced' || res.status === 'duplicate') { await d.delete('queue', q.offlineRef); synced++; }
        else { await d.put('queue', { ...q, state: 'conflict', conflictId: res.conflictId, code: res.code, message: res.message } satisfies QueuedSale); conflicts++; }
      }
    }
  } finally { uploading = false; emit(); }
  return { synced, conflicts };
}
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.network;
