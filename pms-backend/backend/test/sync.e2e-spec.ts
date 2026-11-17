import { randomUUID } from 'crypto';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

type Client = ReturnType<typeof authed>;
const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

describe('Offline sync', () => {
  let ctx: TestCtx;
  let admin: Client, mgr: Client, keeper: Client, cashier: Client, cashierB: Client, mgrA: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, R1: any, R2: any, para: any, vit: any, dev: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  async function userWith(username: string, role: string, branchId?: string): Promise<Client> {
    expect((await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] })).status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
    A = (await admin.post('/branches', { code: 'MAIN', name: 'Main Dispenser' })).body;
    B = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa Dispenser' })).body;
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W', name: 'Main store' })).body;
    R1 = (await admin.post('/cash-registers', { branchId: A.id, code: 'R1', name: 'Counter 1', offlineMode: 'offline_capable' })).body;
    R2 = (await admin.post('/cash-registers', { branchId: B.id, code: 'R2', name: 'Counter 2' })).body;
    const price = (amount: string) => [{ unitId: U.tablet, priceType: 'selling', amount }];
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, prices: price('2') })).body;
    vit = (await admin.post('/products', { name: 'Vitamin C', baseUnitId: U.tablet, prices: price('1') })).body;
    await ctx.db.query(`update catalog.product_prices set effective_from = now() - interval '10 days'`);
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    mgrA = await userWith('mgra', 'Branch Manager', A.id);
    cashier = await userWith('cashier', 'Cashier', A.id);
    cashierB = await userWith('cashierb', 'Cashier', B.id);
    dev = (await cashier.post('/sync/devices', { name: 'Tablet 1', platform: 'android', registerId: R1.id })).body;
    await ctx.db.query(`update sales.payment_methods set is_active = true`);
  });

  async function stockIn(product: any, qty: number) {
    const r = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: product.id, quantity: String(qty), direction: 'increase', newBatch: { batchRef: `L${Math.random()}`.slice(0, 8), expiryDate: new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10), unitCost: '1' } }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const sale = (over: Record<string, unknown> = {}, qty = '5', product: any = para) => ({
    registerId: R1.id, idempotencyKey: `K-${randomUUID()}`, offlineRef: `OFF-${randomUUID().slice(0, 8)}`, soldAt: ago(1),
    items: [{ productId: product.id, quantity: qty }], payments: [{ methodCode: 'cash', amount: String(Number(qty) * (product === para ? 2 : 1)) }], ...over,
  });
  const upload = (c: Client, sales: any[], deviceId = dev.id) => c.post('/sync/sales', { deviceId, sales });

  it('registers devices inside the caller\'s branches and lets managers revoke them', async () => {
    expect(dev.branch_id).toBe(A.id);
    expect((await cashierB.post('/sync/devices', { name: 'Nope', registerId: R1.id })).status).toBe(403);
    expect((await cashier.get('/sync/devices')).status).toBe(403);
    expect((await mgrA.get('/sync/devices')).body.total).toBe(1);
    expect((await cashierB.get(`/sync/cursor?deviceId=${dev.id}`)).status).toBe(404);
    expect((await mgrA.post(`/sync/devices/${dev.id}/revoke`)).status).toBe(200);
    const r = await cashier.get(`/sync/cursor?deviceId=${dev.id}`);
    expect(r.status).toBe(403); expect(r.body.code).toBe('DEVICE_REVOKED');
  });

  it('downloads reference data in pages and then follows changes from the cursor', async () => {
    const cur = (await cashier.get(`/sync/cursor?deviceId=${dev.id}`)).body;
    expect(cur.entities).toEqual(expect.arrayContaining(['product', 'price', 'tax_rule', 'barcode']));
    expect(cur.settings.maxOfflineHours).toBe(72);
    const p1 = (await cashier.get(`/sync/snapshot/product?deviceId=${dev.id}&limit=1`)).body;
    expect(p1.items).toHaveLength(1); expect(p1.hasMore).toBe(true);
    const p2 = (await cashier.get(`/sync/snapshot/product?deviceId=${dev.id}&limit=1&afterId=${p1.nextAfterId}`)).body;
    expect(p2.items).toHaveLength(1); expect(p2.hasMore).toBe(false);
    const regs = (await cashier.get(`/sync/snapshot/register?deviceId=${dev.id}`)).body.items;
    expect(regs.map((r: any) => r.code)).toEqual(['R1']); // only this branch's registers
    expect((await cashier.get(`/sync/snapshot/nonsense?deviceId=${dev.id}`)).body.code).toBe('UNKNOWN_ENTITY');

    // a price change shows up once as an upsert, a later one replaces it
    expect((await admin.post(`/products/${para.id}/prices`, { unitId: U.tablet, priceType: 'selling', amount: '3', reason: 'New tariff' })).status).toBeLessThan(300);
    const ch = (await cashier.get(`/sync/changes?deviceId=${dev.id}&since=${cur.cursor}`)).body;
    expect(ch.hasMore).toBe(false);
    expect(ch.changes.filter((c: any) => c.entity === 'price').every((c: any) => c.op === 'upsert' && c.data.product_id === para.id)).toBe(true);
    expect(ch.changes.some((c: any) => c.entity === 'price')).toBe(true);
    const again = (await cashier.get(`/sync/changes?deviceId=${dev.id}&since=${ch.cursor}`)).body;
    expect(again.changes).toHaveLength(0); expect(again.cursor).toBe(ch.cursor);
    const small = (await cashier.get(`/sync/changes?deviceId=${dev.id}&since=${cur.cursor}&limit=1`)).body;
    expect(small.changes).toHaveLength(1); expect(small.hasMore).toBe(true);
  });

  it('shows what is on the shelves for the device\'s branch', async () => {
    await stockIn(para, 40);
    const s = (await cashier.get(`/sync/stock?deviceId=${dev.id}`)).body;
    expect(s.items).toEqual([{ productId: para.id, available: '40.0000' }]);
  });

  it('accepts offline sales at the price in force when they were made, and treats a repeat upload as a duplicate', async () => {
    await stockIn(para, 100);
    expect((await admin.post(`/products/${para.id}/prices`, { unitId: U.tablet, priceType: 'selling', amount: '3', reason: 'New tariff' })).status).toBeLessThan(300);
    const s = sale();
    const r1 = (await upload(cashier, [s])).body;
    expect(r1.summary).toEqual({ synced: 1, duplicate: 0, conflict: 0 });
    expect(r1.results[0].status).toBe('synced');
    const saved = (await cashier.get(`/sales/${r1.results[0].saleId}`)).body;
    expect(saved.total).toBe('10.0000'); // 5 x 2, the old price, not 3
    expect(saved.sold_at ?? saved.soldAt).toBeTruthy();
    const r2 = (await upload(cashier, [s])).body;
    expect(r2.results[0].status).toBe('duplicate');
    expect(r2.results[0].saleId).toBe(r1.results[0].saleId);
    const d = (await mgrA.get('/sync/devices')).body.items[0];
    expect(d.last_sync_at).not.toBeNull();
  });

  it('parks a sale that cannot be accepted, tells the manager, and lets the cashier retry once stock is there', async () => {
    const s = sale({}, '5');
    const r = (await upload(cashier, [s])).body;
    expect(r.results[0].status).toBe('conflict'); expect(r.results[0].code).toBe('INSUFFICIENT_STOCK');
    // uploading again does not duplicate the conflict
    await upload(cashier, [s]);
    const list = (await mgrA.get('/sync/conflicts?status=open')).body;
    expect(list.total).toBe(1); expect(list.items[0].attempts).toBe(2);
    expect((await mgrA.get('/notifications')).body.items.some((n: any) => n.type === 'sync_conflict')).toBe(true);

    await stockIn(para, 20);
    const id = list.items[0].id;
    const wrong = await mgrA.post(`/sync/conflicts/${id}/retry`);
    expect(wrong.status).toBe(403); expect(wrong.body.code).toBe('RETRY_BY_CASHIER');
    expect((await cashier.get('/sync/my-conflicts?status=open')).body.total).toBe(1);
    const ok = await cashier.post(`/sync/conflicts/${id}/retry`);
    expect(ok.status).toBe(200); expect(ok.body.status).toBe('synced');
    expect((await mgrA.get('/sync/conflicts?status=open')).body.total).toBe(0);
    expect((await mgrA.get('/sync/conflicts?status=resolved')).body.total).toBe(1);
  });

  it('refuses sales older than the offline window and lets a manager dismiss them with a reason', async () => {
    await stockIn(para, 20);
    const r = (await upload(cashier, [sale({ soldAt: ago(100) })])).body;
    expect(r.results[0]).toMatchObject({ status: 'conflict', code: 'OFFLINE_WINDOW_EXCEEDED' });
    const c = (await mgrA.get('/sync/conflicts?status=open')).body.items[0];
    expect((await mgrA.post(`/sync/conflicts/${c.id}/dismiss`, { note: 'x' })).status).toBe(400);
    const done = await mgrA.post(`/sync/conflicts/${c.id}/dismiss`, { note: 'Paper receipt checked; sale entered manually' });
    expect(done.status).toBe(200); expect(done.body.status).toBe('dismissed');
    expect((await mgrA.post(`/sync/conflicts/${c.id}/dismiss`, { note: 'again please' })).body.code).toBe('CONFLICT_CLOSED');
  });

  it('processes a batch one sale at a time: good ones go through even when another fails', async () => {
    await stockIn(para, 10);
    const r = (await upload(cashier, [sale({}, '4'), sale({}, '50'), sale({}, '3')])).body;
    expect(r.results.map((x: any) => x.status)).toEqual(['synced', 'conflict', 'synced']);
    expect(r.summary).toEqual({ synced: 2, duplicate: 0, conflict: 1 });
    const bad = await upload(cashier, [sale({ registerId: R2.id })]);
    expect(bad.body.results[0].code).toBe('REGISTER_NOT_ON_DEVICE_BRANCH');
  });
});
