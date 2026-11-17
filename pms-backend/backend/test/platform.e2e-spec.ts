import { ADMIN, authed, createTestApp, GOOD_PASSWORD, login, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';
import { SequenceService } from '../src/modules/platform/sequence.service';

describe('Settings and document numbering', () => {
  let ctx: TestCtx;
  let admin: ReturnType<typeof authed>;
  let branchA: any, branchB: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    branchA = (await admin.post('/branches', { code: 'MAIN', name: 'Main' })).body;
    branchB = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa' })).body;
  });

  async function scopedUser(username: string, perms: string[], branchId: string | null) {
    const role = (await admin.post('/roles', { name: `role-${username}`, permissions: perms })).body;
    await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: role.id, branchId: branchId ?? undefined }] });
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  describe('settings', () => {
    it('lists every setting with its default and source', async () => {
      const res = await admin.get('/settings');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.map((s: any) => [s.key, s]));
      expect(byKey['business.currency']).toMatchObject({ value: 'ETB', source: 'default' });
      expect(byKey['inventory.expiry_warning_days'].value).toEqual([180, 90, 30, 7]);
      expect(byKey['inventory.allow_negative_stock'].value).toBe(false);
      expect(byKey['business.timezone'].value).toBe('Africa/Addis_Ababa');
    });

    it('changes a value, records history and audit, and supports reset', async () => {
      const set = await admin.put('/settings/business.name', { value: 'Hayat Pharmacy', reason: 'initial setup' });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ value: 'Hayat Pharmacy', source: 'company', version: 1 });
      const again = await admin.put('/settings/business.name', { value: 'Hayat Pharmacy PLC', version: 1 });
      expect(again.body.version).toBe(2);
      const hist = await admin.get('/settings/business.name/history');
      expect(hist.body.map((h: any) => h.new_value)).toEqual(['Hayat Pharmacy PLC', 'Hayat Pharmacy']);
      expect(hist.body[1].reason).toBe('initial setup');
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'setting.changed'`)).rowCount).toBe(2);

      const reset = await admin.del('/settings/business.name');
      expect(reset.body).toMatchObject({ value: '', source: 'default' });
      await expect(ctx.db.query(`update platform.settings_history set reason = 'x'`)).rejects.toThrow(/append-only/);
    });

    it('rejects invalid values, unknown keys and stale versions', async () => {
      const bad = await admin.put('/settings/security.password_min_length', { value: 3 });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_SETTING_VALUE');
      expect((await admin.put('/settings/business.currency', { value: 'birr' })).status).toBe(400);
      expect((await admin.put('/settings/business.timezone', { value: 'Mars/Olympus' })).status).toBe(400);
      expect((await admin.put('/settings/inventory.expiry_warning_days', { value: [30, 30] })).status).toBe(400);
      expect((await admin.put('/settings/no.such_key', { value: 1 })).status).toBe(404);
      expect((await admin.put('/settings/business.name', { value: 'A' })).status).toBe(200);
      const stale = await admin.put('/settings/business.name', { value: 'B', version: 7 });
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect((await admin.put('/settings/business.name', {})).status).toBe(400);
    });

    it('lets a branch override only the settings that allow it, and only with branch access', async () => {
      const res = await admin.put('/settings/sales.receipt_paper_width', { value: 58, branchId: branchA.id });
      expect(res.body).toMatchObject({ value: 58, source: 'branch' });
      expect((await admin.get(`/settings?branchId=${branchA.id}`)).body.find((s: any) => s.key === 'sales.receipt_paper_width').value).toBe(58);
      expect((await admin.get(`/settings?branchId=${branchB.id}`)).body.find((s: any) => s.key === 'sales.receipt_paper_width').value).toBe(80);
      expect((await admin.get('/settings')).body.find((s: any) => s.key === 'sales.receipt_paper_width').value).toBe(80);
      const notAllowed = await admin.put('/settings/business.currency', { value: 'USD', branchId: branchA.id });
      expect(notAllowed.body.code).toBe('NOT_BRANCH_OVERRIDABLE');

      const mgr = await scopedUser('mgr.a', ['settings.read', 'settings.manage'], branchA.id);
      expect((await mgr.put('/settings/sales.receipt_footer', { value: 'Thank you', branchId: branchA.id })).status).toBe(200);
      expect((await mgr.put('/settings/sales.receipt_footer', { value: 'Hi', branchId: branchB.id })).status).toBe(403);
      expect((await mgr.put('/settings/sales.receipt_footer', { value: 'Hi' })).status).toBe(403);
      expect((await mgr.get(`/settings?branchId=${branchB.id}`)).status).toBe(404);
    });

    it('refuses settings access without permission', async () => {
      const nobody = await scopedUser('nobody', ['branches.read'], null);
      expect((await nobody.get('/settings')).status).toBe(403);
      expect((await nobody.put('/settings/business.name', { value: 'x' })).status).toBe(403);
      const reader = await scopedUser('reader', ['settings.read'], null);
      expect((await reader.get('/settings')).status).toBe(200);
      expect((await reader.put('/settings/business.name', { value: 'x' })).status).toBe(403);
    });

    it('applies security settings to authentication immediately', async () => {
      await admin.put('/settings/security.password_min_length', { value: 14 });
      const weak = await admin.post('/users', { username: 'weak.pw', password: GOOD_PASSWORD }); // 16 chars still passes
      expect(weak.status).toBe(201);
      const short = await admin.post('/users', { username: 'short.pw', password: 'Abcdef123456' }); // 12 chars
      expect(short.body.code).toBe('WEAK_PASSWORD');

      await admin.put('/settings/security.max_failed_logins', { value: 1 });
      expect((await login(ctx, 'weak.pw', 'Wrong-Passw0rd!')).status).toBe(401);
      expect((await login(ctx, 'weak.pw', GOOD_PASSWORD)).status).toBe(423);
      await admin.put('/settings/security.lockout_minutes', { value: 1 });
      await ctx.db.query(`update iam.users set locked_until = null, failed_login_count = 0`);
      expect((await login(ctx, 'weak.pw', 'Wrong-Passw0rd!')).status).toBe(401);
      const locked = await login(ctx, 'weak.pw', GOOD_PASSWORD);
      expect(locked.body.details.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it('locks the costing method once stock transactions exist', async () => {
      expect((await admin.put('/settings/inventory.costing_method', { value: 'weighted_average' })).status).toBe(200);
      // Receive real stock through the normal approval flow, so a genuine stock movement exists
      const U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
      const product = (await admin.post('/products', { name: 'Costing test', baseUnitId: U.tablet })).body;
      const wh = (await admin.post('/warehouses', { branchId: branchA.id, code: 'W', name: 'Store' })).body;
      const second = await scopedUser('approver', ['inventory.read', 'inventory.adjust_approve'], null);
      const adj = await admin.post('/inventory/adjustments', { warehouseId: wh.id, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: product.id, quantity: '10', direction: 'increase', newBatch: { batchRef: 'B1', expiryDate: '2099-01-01', unitCost: '1' } }] });
      expect((await second.post(`/approvals/${adj.body.approval_id}/approve`, {})).status).toBe(200);
      const locked = await admin.put('/settings/inventory.costing_method', { value: 'fifo' });
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('SETTING_LOCKED');
      expect((await admin.del('/settings/inventory.costing_method')).status).toBe(409);
      // once the stock history is gone (test cleanup only) the setting is open again
      await ctx.db.query(`truncate inventory.stock_movements, inventory.stock_balances cascade`);
      expect((await admin.put('/settings/inventory.costing_method', { value: 'fifo' })).status).toBe(200);
    });
  });

  describe('document numbering', () => {
    const seq = () => ctx.app.get(SequenceService);
    const next = (type: any, branch: string | null = null, now?: Date) => ctx.db.tx((q) => seq().next(q, type, branch, now));

    it('issues sequential, formatted reference numbers', async () => {
      expect(await next('purchase_order')).toBe('PO-000001');
      expect(await next('purchase_order')).toBe('PO-000002');
      expect(await next('sale')).toBe('S-000001'); // independent counters per document type
    });

    it('does not leave a gap when the surrounding transaction rolls back', async () => {
      expect(await next('goods_receipt')).toBe('GRN-000001');
      await expect(ctx.db.tx(async (q) => { await seq().next(q, 'goods_receipt'); throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await next('goods_receipt')).toBe('GRN-000002');
    });

    it('never repeats or skips a number under heavy concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 40 }, () => next('sale')));
      expect(new Set(results).size).toBe(40);
      const numbers = results.map((r) => Number(r.split('-')[1])).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it('can be reconfigured, but never moved backwards', async () => {
      await next('stock_transfer');
      const cfg = await admin.put('/document-sequences/stock_transfer', { prefix: 'TR', padding: 4, resetRule: 'never', nextValue: 100 });
      expect(cfg.status).toBe(200);
      expect(await next('stock_transfer')).toBe('TR-0100');
      const back = await admin.put('/document-sequences/stock_transfer', { prefix: 'TR', padding: 4, resetRule: 'never', nextValue: 50 });
      expect(back.body.code).toBe('SEQUENCE_CANNOT_GO_BACK');
      expect(await next('stock_transfer')).toBe('TR-0101');
      expect((await admin.put('/document-sequences/nonsense', { prefix: 'X', padding: 4, resetRule: 'never' })).status).toBe(404);
      expect((await admin.put('/document-sequences/sale', { prefix: 'bad prefix', padding: 4, resetRule: 'never' })).status).toBe(400);
    });

    it('restarts each year when configured to', async () => {
      await admin.put('/document-sequences/sales_return', { prefix: 'SR', padding: 3, resetRule: 'yearly' });
      expect(await next('sales_return', null, new Date('2026-12-31T10:00:00Z'))).toBe('SR-2026-001');
      expect(await next('sales_return', null, new Date('2026-12-31T11:00:00Z'))).toBe('SR-2026-002');
      expect(await next('sales_return', null, new Date('2027-01-01T08:00:00Z'))).toBe('SR-2027-001');
    });

    it('supports a separate sequence per branch, which must have its own prefix', async () => {
      await next('sale');
      expect((await admin.put('/document-sequences/sale', { branchId: branchA.id, prefix: 'S', padding: 6, resetRule: 'never' })).status).toBe(409); // same prefix would collide
      expect((await admin.put('/document-sequences/sale', { branchId: branchA.id, prefix: 'MAIN-S', padding: 6, resetRule: 'never' })).status).toBe(200);
      expect(await next('sale', branchA.id)).toBe('MAIN-S-000001');
      expect(await next('sale', branchB.id)).toBe('S-000002'); // no branch sequence: falls back to the company one
    });

    it('lists all document types, even ones not used yet, and needs the right permission', async () => {
      const list = await admin.get('/document-sequences');
      expect(list.body.map((s: any) => s.doc_type)).toEqual(expect.arrayContaining(['sale', 'purchase_order', 'product_sku']));
      const mgr = await scopedUser('mgr', ['settings.read', 'settings.manage'], branchA.id);
      expect((await mgr.put('/document-sequences/sale', { prefix: 'X', padding: 4, resetRule: 'never' })).status).toBe(403); // company-wide change
      expect((await mgr.put('/document-sequences/sale', { branchId: branchA.id, prefix: 'A-S', padding: 4, resetRule: 'never' })).status).toBe(200);
      expect((await mgr.put('/document-sequences/sale', { branchId: branchB.id, prefix: 'B-S', padding: 4, resetRule: 'never' })).status).toBe(403);
    });
  });
});
