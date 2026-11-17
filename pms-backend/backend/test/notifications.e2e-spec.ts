import { randomUUID } from 'crypto';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Notifications and scheduled checks', () => {
  let ctx: TestCtx;
  let admin: Client, mgr: Client, keeper: Client, cashier: Client, mgrA: Client, mgrB: Client, acct: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, whB: any, R1: any, para: any, vit: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  async function userWith(username: string, role: string, branchId?: string): Promise<Client> {
    expect((await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] })).status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false, email = $2 where username = $1`, [username, `${username}@pharmacy.test`]);
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
    whB = (await admin.post('/warehouses', { branchId: B.id, code: 'W', name: 'Piassa store' })).body;
    R1 = (await admin.post('/cash-registers', { branchId: A.id, code: 'R1', name: 'Counter 1' })).body;
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, reorderLevel: '50', prices: [{ unitId: U.tablet, priceType: 'selling', amount: '2' }] })).body;
    vit = (await admin.post('/products', { name: 'Vitamin C', baseUnitId: U.tablet, reorderLevel: '10', prices: [{ unitId: U.tablet, priceType: 'selling', amount: '1' }] })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    cashier = await userWith('cashier', 'Cashier', A.id);
    mgrA = await userWith('mgra', 'Branch Manager', A.id);
    mgrB = await userWith('mgrb', 'Branch Manager', B.id);
    acct = await userWith('acct', 'Accountant');
  });

  async function stockIn(product: any, qty: number, expiryDays = 400, warehouseId = whA.id, ref = `L${Math.random()}`.slice(0, 8)) {
    const r = await keeper.post('/inventory/adjustments', { warehouseId, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: product.id, quantity: String(qty), direction: 'increase', newBatch: { batchRef: ref, expiryDate: day(expiryDays), unitCost: '1' } }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const job = async (name: string) => { const r = await admin.post(`/jobs/${name}/run`); expect(r.status).toBe(200); return r.body; };
  const inbox = async (c: Client, q = '') => (await c.get(`/notifications${q}`)).body;

  it('raises low-stock and out-of-stock alerts per branch, shows them only to people who can act, and clears them when stock arrives', async () => {
    await stockIn(para, 100);
    await stockIn(vit, 5, 400, whA.id);
    await job('stock_alerts');
    let list = (await inbox(mgrA)).items;
    expect(list.map((n: any) => n.type)).toEqual(['low_stock']); // vitamin C is low at Main; Paracetamol is fine; Piassa has nothing at all
    expect(list.every((n: any) => n.branch_id === A.id)).toBe(true);
    const piassa = (await inbox(mgrB)).items;
    expect(piassa.every((n: any) => n.branch_id === B.id)).toBe(true);
    expect(piassa.map((n: any) => n.type)).toContain('out_of_stock');
    expect((await inbox(cashier)).total).toBe(0); // no inventory permission
    expect((await inbox(admin)).total).toBe(2); // low at Main, out at Piassa
    await stockIn(vit, 100);
    await job('stock_alerts');
    list = (await inbox(mgrA)).items;
    expect(list.find((n: any) => n.type === 'low_stock')).toBeUndefined();
    const again = await job('stock_alerts'); // running twice never duplicates
    expect(again.skipped).toBe(false);
    expect((await ctx.db.query(`select count(*) from platform.notifications where type = 'out_of_stock' and branch_id = $1 and resolved_at is null`, [A.id])).rows[0].count).toBe('0');
  });

  it('warns in configurable bands before batches expire and flags expired stock that is still on the shelf', async () => {
    await stockIn(para, 100, 5, whA.id, 'SOON');
    await stockIn(para, 100, 25, whA.id, 'LATER');
    await stockIn(para, 100, 400, whA.id, 'FINE');
    await stockIn(vit, 50, 400, whA.id, 'OLD');
    await ctx.db.query(`update inventory.stock_batches set expiry_date = current_date - 2 where batch_ref = 'OLD'`);
    await job('expiry_alerts');
    const items = (await inbox(mgrA)).items.filter((n: any) => ['expiry', 'expired_stock'].includes(n.type));
    expect(items.map((n: any) => [n.type, n.data.withinDays ?? null, n.severity]).sort()).toEqual([['expired_stock', null, 'critical'], ['expiry', 30, 'warning'], ['expiry', 7, 'critical']].sort());
    await admin.put('/settings/inventory.expiry_warning_days', { value: [10] });
    await job('expiry_alerts');
    const after = (await inbox(mgrA)).items.filter((n: any) => n.type === 'expiry');
    expect(after.map((n: any) => n.data.withinDays)).toEqual([10]); // the 25-day batch is outside the new band; old bands closed
  });

  it('lets each person read, filter and switch off what they see', async () => {
    await stockIn(para, 10);
    await job('stock_alerts');
    const first = await inbox(mgrA);
    expect(first.items.every((n: any) => n.is_read === false)).toBe(true);
    expect((await mgrA.get('/notifications/unread-count')).body.unread).toBe(first.total);
    expect((await mgrA.post('/notifications/read', { ids: [first.items[0].id] })).body.marked).toBe(1);
    expect((await inbox(mgrA, '?unread=true')).total).toBe(first.total - 1);
    expect((await mgrA.post('/notifications/read', { all: true })).status).toBe(200);
    expect((await mgrA.get('/notifications/unread-count')).body.unread).toBe(0);
    expect((await inbox(mgr, '?unread=true')).total).toBeGreaterThan(0); // reading is per person
    await mgrA.put('/notifications/preferences/low_stock', { inApp: false });
    expect((await inbox(mgrA)).items.find((n: any) => n.type === 'low_stock')).toBeUndefined();
    expect((await mgrA.put('/notifications/preferences/nonsense', { inApp: false })).status).toBe(400);
    expect((await mgrA.get('/notifications/preferences')).body.find((p: any) => p.type === 'low_stock')).toMatchObject({ inApp: false, email: true });
  });

  it('raises alerts for late orders, unpaid supplier invoices and requests waiting for approval', async () => {
    const s1 = (await admin.post('/suppliers', { name: 'EPSA Depot', paymentTermsDays: 30 })).body;
    const buyer = await userWith('buyer', 'Supply Chain Manager');
    const po = (await buyer.post('/purchase-orders', { supplierId: s1.id, warehouseId: whA.id, expectedDate: day(3), items: [{ productId: para.id, unitId: U.tablet, quantity: '10', unitPrice: '1' }] })).body;
    const sub = await buyer.post(`/purchase-orders/${po.id}/submit`, {});
    await mgr.post(`/approvals/${sub.body.approval_id}/approve`, {});
    await ctx.db.query(`update procurement.purchase_orders set expected_date = current_date - 4 where id = $1`, [po.id]);
    await job('procurement_alerts');
    expect((await inbox(buyer)).items.map((n: any) => n.type)).toContain('overdue_orders');
    expect((await inbox(cashier)).total).toBe(0);
    // an approval left waiting
    await stockIn(para, 100);
    const batchId = (await admin.get(`/inventory/stock?warehouseId=${whA.id}&status=available`)).body.items[0].batch_id;
    const r = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'loss', reason: 'Shrinkage', items: [{ productId: para.id, batchId, quantity: '1', direction: 'decrease' }] });
    expect(r.status).toBe(201);
    await ctx.db.query(`update platform.approval_requests set requested_at = now() - interval '2 days' where status = 'pending'`);
    await job('approval_reminders');
    expect((await inbox(mgr)).items.map((n: any) => n.type)).toContain('pending_approvals');
    await mgr.post('/approvals/' + (await mgr.get('/approvals')).body[0].id + '/approve', {});
    await job('approval_reminders');
    expect((await inbox(mgr)).items.map((n: any) => n.type)).not.toContain('pending_approvals');
  });

  it('alerts the right people to a cash difference and to a large stock adjustment', async () => {
    const o = await cashier.post('/finance/register-sessions', { registerId: R1.id, openingAmount: '100' });
    await cashier.post(`/finance/register-sessions/${o.body.id}/close`, { countedAmount: '80', note: 'Short' });
    const v = (await inbox(mgrA)).items.find((n: any) => n.type === 'cash_variance');
    expect(v).toMatchObject({ severity: 'critical', branch_id: A.id });
    expect(v.data.variance).toBe('-20.0000');
    expect((await inbox(mgrB)).items.find((n: any) => n.type === 'cash_variance')).toBeUndefined();
    await admin.put('/settings/notifications.unusual_adjustment_value', { value: '50' });
    await stockIn(para, 100);
    const adj = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'loss', reason: 'Lost in flood', items: [{ productId: para.id, quantity: '60', direction: 'decrease', batchId: (await admin.get(`/inventory/stock?warehouseId=${whA.id}&status=available`)).body.items[0].batch_id }] });
    expect(adj.status).toBe(201);
    await mgr.post(`/approvals/${adj.body.approval_id}/approve`, {});
    expect((await inbox(mgrA)).items.find((n: any) => n.type === 'unusual_adjustment').body).toContain('60.0000');
  });

  it('emails new notifications only when switched on, only to people who can see them and have not opted out', async () => {
    await stockIn(para, 10);
    await job('stock_alerts');
    ctx.messaging.outbox.length = 0;
    await job('notification_emails');
    expect(ctx.messaging.outbox.filter((m) => m.kind === 'notification')).toHaveLength(0); // off by default
    await stockIn(vit, 5);
    await admin.put('/settings/notifications.email_enabled', { value: true });
    await mgrB.put('/notifications/preferences/low_stock', { email: false });
    await job('stock_alerts');
    ctx.messaging.outbox.length = 0;
    await ctx.db.query(`update platform.notifications set email_pending = true`);
    await job('notification_emails');
    const mails = ctx.messaging.outbox.filter((m) => m.kind === 'notification');
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.some((m) => m.to === 'mgra@pharmacy.test')).toBe(true);
    expect(mails.some((m) => m.to === 'cashier@pharmacy.test')).toBe(false);
    expect(mails.filter((m) => m.to === 'mgrb@pharmacy.test').every((m) => !/low on stock/.test(m.subject ?? ''))).toBe(true);
    ctx.messaging.outbox.length = 0;
    await job('notification_emails');
    expect(ctx.messaging.outbox).toHaveLength(0); // each is sent once
  });

  it('keeps the scheduler for administrators and records every run', async () => {
    expect((await mgr.get('/jobs')).status).toBe(403);
    expect((await mgr.post('/jobs/stock_alerts/run')).status).toBe(403);
    expect((await admin.post('/jobs/nope/run')).status).toBe(404);
    await job('stock_alerts');
    const listed = (await admin.get('/jobs')).body;
    expect(listed.find((j: any) => j.name === 'stock_alerts').lastRun.status).toBe('ok');
    expect(listed.map((j: any) => j.name)).toEqual(expect.arrayContaining(['expiry_alerts', 'procurement_alerts', 'receivable_alerts', 'approval_reminders', 'notification_emails', 'notification_housekeeping']));
    await job('notification_housekeeping');
  });

  it('keeps the monthly audit tables ahead of the calendar', async () => {
    await job('audit_partitions');
    const n = await ctx.db.query(`select count(*)::int as n from pg_inherits i join pg_class c on c.oid = i.inhparent where c.relname = 'audit_logs'`);
    expect((n.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(4); // default + this month + the next three
    await job('audit_partitions'); // running it again changes nothing
  });
});
