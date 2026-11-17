import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';
import { InventoryService } from '../src/modules/inventory/inventory.service';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe('Inventory', () => {
  let ctx: TestCtx;
  let admin: ReturnType<typeof authed>;
  let U: Record<string, string>;
  let branchA: any, branchB: any, whA: any, whB: any, locA: any;
  let para: any, other: any;
  let keeper: ReturnType<typeof authed>, mgr: ReturnType<typeof authed>;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  async function userWith(username: string, role: string, branchId?: string) {
    const res = await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] });
    expect(res.status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
    branchA = (await admin.post('/branches', { code: 'MAIN', name: 'Main' })).body;
    branchB = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa' })).body;
    whA = (await admin.post('/warehouses', { branchId: branchA.id, code: 'W', name: 'Main store' })).body;
    whB = (await admin.post('/warehouses', { branchId: branchB.id, code: 'W', name: 'Piassa store' })).body;
    locA = (await admin.post('/storage-locations', { warehouseId: whA.id, code: 'S1', name: 'Shelf 1' })).body;
    para = (await admin.post('/products', { name: 'Paracetamol', strength: '500 mg', baseUnitId: U.tablet, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }], minStock: '100', reorderLevel: '200', maxStock: '5000' })).body;
    other = (await admin.post('/products', { name: 'Amoxicillin', baseUnitId: U.capsule, reorderLevel: '50' })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
  });

  /** Requests an opening-balance adjustment as the storekeeper and has the manager approve it. */
  async function stockIn(opts: { warehouseId?: string; product?: any; batchRef: string; expiry: string; qty: string; cost?: string; unitId?: string; locationId?: string }) {
    const res = await keeper.post('/inventory/adjustments', {
      warehouseId: opts.warehouseId ?? whA.id, reasonCode: 'opening_balance', reason: 'Opening stock',
      items: [{ productId: (opts.product ?? para).id, unitId: opts.unitId, quantity: opts.qty, direction: 'increase', locationId: opts.locationId, newBatch: { batchRef: opts.batchRef, expiryDate: opts.expiry, unitCost: opts.cost ?? '1' } }],
    });
    expect(res.status).toBe(201);
    const approved = await mgr.post(`/approvals/${res.body.approval_id}/approve`, {});
    expect(approved.status).toBe(200);
    return res.body.id as string;
  }
  const available = async (product = para, branch = branchA) =>
    Number((await admin.get(`/inventory/stock?productId=${product.id}&branchId=${branch.id}&status=available`)).body.items.reduce((s: number, i: any) => s + Number(i.quantity), 0));
  const reconcile = async () => (await admin.get('/inventory/reconcile')).body;

  describe('adjustments and approvals', () => {
    it('adds opening stock only after a second person approves, and records the movement', async () => {
      const res = await keeper.post('/inventory/adjustments', {
        warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'Opening stock',
        items: [{ productId: para.id, unitId: U.strip, quantity: '3', direction: 'increase', locationId: locA.id, newBatch: { batchRef: 'B1', expiryDate: day(200), unitCost: '1.5' } }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'pending', reference_no: 'ADJ-000001' });
      expect(await available()).toBe(0); // nothing moves before approval

      // nobody can approve their own request
      const own = await keeper.post(`/approvals/${res.body.approval_id}/approve`, {});
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');

      const pending = (await mgr.get('/approvals')).body;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ can_decide: true, action_code: 'inventory.adjustment' });
      expect((await keeper.get('/approvals')).body[0]).toMatchObject({ can_decide: false, is_mine: true });

      expect((await mgr.post(`/approvals/${res.body.approval_id}/approve`, { comment: 'Checked against the count sheet' })).status).toBe(200);
      expect(await available()).toBe(30); // 3 strips x 10 tablets
      const adj = (await mgr.get(`/inventory/adjustments/${res.body.id}`)).body;
      expect(adj).toMatchObject({ status: 'posted', requested_by_name: 'keeper', decided_by_name: 'mgr' });
      const moves = (await admin.get('/inventory/movements')).body.items;
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ movement_type: 'opening_balance', quantity_delta: '30.0000', balance_after: '30.0000', reference_no: 'ADJ-000001', status: 'available', created_by: 'keeper' });
      expect(moves[0].unit_cost).toBe('1.5000'); // cost per tablet
      expect(await reconcile()).toEqual([]);
      expect((await mgr.post(`/approvals/${res.body.approval_id}/approve`, {})).body.code).toBe('APPROVAL_ALREADY_DECIDED');
    });

    it('enforces the four-eyes rule in the database as well, not only in code', async () => {
      const res = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'x opening', items: [{ productId: para.id, quantity: '5', direction: 'increase', newBatch: { batchRef: 'B1', expiryDate: day(100), unitCost: '1' } }] });
      await expect(ctx.db.query(`update platform.approval_requests set status = 'approved', decided_by = requested_by where id = $1`, [res.body.approval_id])).rejects.toThrow(/check constraint/);
    });

    it('can be rejected or withdrawn without touching stock', async () => {
      const mk = () => keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'found', reason: 'Found behind shelf', items: [{ productId: para.id, quantity: '5', direction: 'increase', newBatch: { batchRef: 'F1', expiryDate: day(100), unitCost: '1' } }] });
      const a = (await mk()).body, b = (await mk()).body;
      expect((await mgr.post(`/approvals/${a.approval_id}/reject`, {})).status).toBe(400); // a reason is required
      const rej = await mgr.post(`/approvals/${a.approval_id}/reject`, { comment: 'Not verified' });
      expect(rej.body).toMatchObject({ status: 'rejected', comment: 'Not verified' });
      expect((await mgr.get(`/inventory/adjustments/${a.id}`)).body.status).toBe('rejected');
      const notYours = await mgr.post(`/inventory/adjustments/${b.id}/cancel`, {});
      expect(notYours.status).toBe(403); // only the requester can withdraw
      expect(notYours.body.code).toBe('ONLY_REQUESTER_CAN_CANCEL');
      expect((await keeper.post(`/inventory/adjustments/${b.id}/cancel`, {})).body.status).toBe('cancelled');
      expect(await available()).toBe(0);
      expect((await ctx.db.query(`select count(*)::int as n from inventory.stock_movements`)).rows[0].n).toBe(0);
    });

    it('posts immediately when approval is switched off, but only for people who may approve', async () => {
      await admin.put('/settings/inventory.adjustment_approval_required', { value: false });
      const body = { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: para.id, quantity: '40', direction: 'increase', newBatch: { batchRef: 'B1', expiryDate: day(100), unitCost: '1' } }] };
      const denied = await keeper.post('/inventory/adjustments', body);
      expect(denied.status).toBe(403);
      const ok = await mgr.post('/inventory/adjustments', body);
      expect(ok.body.status).toBe('posted');
      expect(await available()).toBe(40);
    });

    it('only accepts valid adjustment requests', async () => {
      const base = { warehouseId: whA.id, reasonCode: 'loss', reason: 'Shrinkage' };
      const nb = { batchRef: 'B1', expiryDate: day(100), unitCost: '1' };
      const post = (items: any[], extra: object = {}) => keeper.post('/inventory/adjustments', { ...base, items, ...extra });
      expect((await post([{ productId: para.id, quantity: '5', direction: 'increase' }])).body.code).toBe('BATCH_REQUIRED');
      expect((await post([{ productId: para.id, quantity: '5', direction: 'decrease', newBatch: nb }])).body.code).toBe('NEW_BATCH_INCREASE_ONLY');
      expect((await post([{ productId: para.id, quantity: '0', direction: 'increase', newBatch: nb }])).body.code).toBe('INVALID_QUANTITY');
      expect((await post([{ productId: para.id, quantity: '5', direction: 'increase', newBatch: nb }], { reasonCode: 'opening_balance', items: [{ productId: para.id, quantity: '5', direction: 'decrease', batchId: '00000000-0000-4000-8000-000000000000' }] })).body.code).toBe('OPENING_BALANCE_INCREASE_ONLY');
      expect((await post([{ productId: para.id, quantity: '5', direction: 'decrease', batchId: '00000000-0000-4000-8000-000000000000' }])).body.code).toBe('BATCH_NOT_FOUND');
      expect((await post([])).status).toBe(400);
      expect((await post([{ productId: para.id, quantity: '5', direction: 'increase', newBatch: nb }], { reason: 'x' })).status).toBe(400);
      expect((await post([{ productId: para.id, quantity: '0.00005', direction: 'increase', newBatch: nb }])).status).toBe(400);
      expect((await post([{ productId: para.id, unitId: U.vial, quantity: '1', direction: 'increase', newBatch: nb }])).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await ctx.db.query(`select count(*)::int as n from inventory.stock_adjustments`)).rows[0].n).toBe(0); // nothing half-created
    });

    it('converts pack sizes exactly: boxes and half a strip', async () => {
      await stockIn({ batchRef: 'BX', expiry: day(100), qty: '2', unitId: U.box });
      expect(await available()).toBe(200);
      await stockIn({ batchRef: 'BY', expiry: day(100), qty: '0.5', unitId: U.strip });
      expect(await available()).toBe(205);
    });

    it('treats the same lot received twice as one batch, and refuses a conflicting expiry date', async () => {
      await stockIn({ batchRef: 'LOT1', expiry: day(100), qty: '10', cost: '2' });
      await stockIn({ batchRef: 'LOT1', expiry: day(100), qty: '5', cost: '2' });
      expect((await ctx.db.query(`select count(*)::int as n from inventory.stock_batches`)).rows[0].n).toBe(1);
      expect(await available()).toBe(15);
      await stockIn({ batchRef: 'LOT1', expiry: day(100), qty: '5', cost: '3' }); // another cost is a separate batch of the same lot
      expect((await ctx.db.query(`select count(*)::int as n from inventory.stock_batches`)).rows[0].n).toBe(2);

      const bad = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'wrong date', items: [{ productId: para.id, quantity: '5', direction: 'increase', newBatch: { batchRef: 'LOT1', expiryDate: day(300), unitCost: '2' } }] });
      const fail = await mgr.post(`/approvals/${bad.body.approval_id}/approve`, {});
      expect(fail.status).toBe(409);
      expect(fail.body.code).toBe('BATCH_EXPIRY_MISMATCH');
      expect((await mgr.get(`/approvals/${bad.body.approval_id}`)).body.status).toBe('pending'); // the failed decision was rolled back
      expect(await available()).toBe(20);
    });

    it('refuses a storage location from another warehouse, and warehouses outside the user\'s branch', async () => {
      const locB = (await admin.post('/storage-locations', { warehouseId: whB.id, code: 'S1', name: 'B shelf' })).body;
      const res = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'wrong shelf', items: [{ productId: para.id, quantity: '5', direction: 'increase', locationId: locB.id, newBatch: { batchRef: 'B1', expiryDate: day(100), unitCost: '1' } }] });
      expect((await mgr.post(`/approvals/${res.body.approval_id}/approve`, {})).body.code).toBe('LOCATION_NOT_IN_WAREHOUSE');
      const keeperA = await userWith('keeper.a', 'Storekeeper', branchA.id);
      const cross = await keeperA.post('/inventory/adjustments', { warehouseId: whB.id, reasonCode: 'found', reason: 'not my branch', items: [{ productId: para.id, quantity: '5', direction: 'increase', newBatch: { batchRef: 'B1', expiryDate: day(100), unitCost: '1' } }] });
      expect(cross.status).toBe(404);
    });
  });

  describe('the ledger', () => {
    it('blocks direct changes to balances and movements, and detects tampering through reconciliation', async () => {
      await stockIn({ batchRef: 'B1', expiry: day(100), qty: '30' });
      await expect(ctx.db.query(`update inventory.stock_balances set quantity = 999`)).rejects.toThrow(/only change through a stock movement/);
      await expect(ctx.db.query(`delete from inventory.stock_balances`)).rejects.toThrow(/only change through a stock movement/);
      await expect(ctx.db.query(`update inventory.stock_movements set quantity_delta = 1`)).rejects.toThrow(/append-only/);
      await expect(ctx.db.query(`delete from inventory.stock_movements`)).rejects.toThrow(/append-only/);
      expect(await reconcile()).toEqual([]);
      // someone with raw database access who bypasses the guard is caught by the reconciliation check
      await ctx.db.tx(async (q) => { await q.query(`select set_config('pms.ledger_post', 'on', true)`); await q.query(`update inventory.stock_balances set quantity = quantity + 5`); });
      const mismatch = await reconcile();
      expect(mismatch).toHaveLength(1);
      expect(Number(mismatch[0].balance) - Number(mismatch[0].movements_total)).toBe(5);
      expect((await keeper.get('/inventory/reconcile')).status).toBe(403);
    });

    it('never lets stock go negative, unless the administrator explicitly allows it', async () => {
      await stockIn({ batchRef: 'B1', expiry: day(100), qty: '30' });
      const batch = (await admin.get(`/inventory/batches?productId=${para.id}`)).body[0];
      const dec = (qty: string) => keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'loss', reason: 'Shrinkage', items: [{ productId: para.id, quantity: qty, direction: 'decrease', batchId: batch.id }] });
      const tooMuch = await dec('40');
      expect(tooMuch.status).toBe(409);
      expect(tooMuch.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: '30.0000', requested: '40.0000' } });

      const a = (await dec('20')).body, b = (await dec('15')).body; // each fine on its own at request time
      expect((await mgr.post(`/approvals/${a.approval_id}/approve`, {})).status).toBe(200);
      expect(await available()).toBe(10);
      const second = await mgr.post(`/approvals/${b.approval_id}/approve`, {});
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await mgr.get(`/approvals/${b.approval_id}`)).body.status).toBe('pending');
      expect(await available()).toBe(10);

      await admin.put('/settings/inventory.allow_negative_stock', { value: true });
      expect((await mgr.post(`/approvals/${b.approval_id}/approve`, {})).status).toBe(200);
      expect(await available()).toBe(-5);
      expect(await reconcile()).toEqual([]);
    });
  });

  describe('first expired, first out', () => {
    async function threeBatches() {
      await stockIn({ batchRef: 'LATE', expiry: day(90), qty: '10', cost: '3' });
      await stockIn({ batchRef: 'SOON', expiry: day(30), qty: '10', cost: '2' });
      await stockIn({ batchRef: 'MID', expiry: day(60), qty: '10', cost: '2.5' });
    }
    const preview = (qty: string, product = para, branch = branchA, client = admin) => client.get(`/inventory/fefo-preview?productId=${product.id}&branchId=${branch.id}&quantity=${qty}`);

    it('takes the earliest expiry first and spills over into the next batch', async () => {
      await threeBatches();
      const p = await preview('15');
      expect(p.status).toBe(200);
      expect(p.body.allocations.map((a: any) => [a.batchRef, a.quantity])).toEqual([['SOON', '10.0000'], ['MID', '5.0000']]);
      expect(p.body.allocations[0].unitCost).toBe('2.0000'); // the real cost of the batch sold, for profit calculation
      expect((await preview('25')).body.allocations.map((a: any) => a.batchRef)).toEqual(['SOON', 'MID', 'LATE']);
      expect((await admin.get(`/inventory/fefo-preview?productId=${para.id}&branchId=${branchA.id}&quantity=2&unitId=${U.strip}`)).body.baseQuantity).toBe('20.0000');
    });

    it('issues stock through the ledger in that order and keeps the books balanced', async () => {
      await threeBatches();
      const inv = ctx.app.get(InventoryService);
      const alloc = await ctx.db.tx((q) => inv.issueFefo(q, { productId: para.id, branchId: branchA.id, baseQuantity: '15', movementType: 'sale', referenceNo: 'S-TEST-1', sourceType: 'sale' }));
      expect(alloc.map((a) => [a.batchRef, a.quantity])).toEqual([['SOON', '10.0000'], ['MID', '5.0000']]);
      const stock = (await admin.get(`/inventory/stock?productId=${para.id}&includeZero=true`)).body.items;
      const bal = Object.fromEntries(stock.map((s: any) => [s.batch_ref, s.quantity]));
      expect(bal).toEqual({ SOON: '0.0000', MID: '5.0000', LATE: '10.0000' });
      const sales = (await admin.get('/inventory/movements?movementType=sale')).body.items;
      expect(sales).toHaveLength(2);
      expect(sales.every((m: any) => m.reference_no === 'S-TEST-1' && Number(m.quantity_delta) < 0)).toBe(true);
      expect(await reconcile()).toEqual([]);
    });

    it('never offers expired, quarantined or damaged stock, and reports the shortfall', async () => {
      await threeBatches();
      await stockIn({ batchRef: 'OLD', expiry: day(-3), qty: '50', cost: '1' });
      const soon = (await admin.get(`/inventory/batches?productId=${para.id}`)).body.find((b: any) => b.batch_ref === 'SOON');
      expect((await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: soon.id, quantity: '4', from: 'available', to: 'quarantined', reason: 'Packaging damaged, awaiting inspection' })).status).toBe(201);
      // saleable: 6 SOON (10 minus 4 quarantined) + 10 MID + 10 LATE = 26. The 50 expired and the 4 quarantined are never offered.
      const ok = await preview('26');
      expect(ok.status).toBe(200);
      expect(ok.body.allocations.map((a: any) => a.batchRef)).toEqual(['SOON', 'MID', 'LATE']);
      expect(ok.body.allocations.some((a: any) => a.batchRef === 'OLD')).toBe(false);
      const short = await preview('27');
      expect(short.status).toBe(409);
      expect(short.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { requested: '27.0000', available: '26.0000' } });
    });

    it('lets only the right branch see its own stock allocation', async () => {
      await threeBatches();
      const mgrB = await userWith('mgr.b', 'Branch Manager', branchB.id);
      expect((await preview('5', para, branchA, mgrB)).status).toBe(404);
      expect((await preview('5', para, branchB, mgrB)).body.code).toBe('INSUFFICIENT_STOCK'); // branch B has no stock
    });

    it('hands the last units to only one of two simultaneous sales', async () => {
      await stockIn({ batchRef: 'B1', expiry: day(100), qty: '10' });
      const inv = ctx.app.get(InventoryService);
      const sell = (n: number, qty: string) => ctx.db.tx((q) => inv.issueFefo(q, { productId: para.id, branchId: branchA.id, baseQuantity: qty, movementType: 'sale', referenceNo: `S-RACE-${n}`, sourceType: 'sale' }));
      const results = await Promise.allSettled([sell(1, '8'), sell(2, '8')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason.code).toBe('INSUFFICIENT_STOCK');
      expect(await available()).toBe(2);
      expect(await reconcile()).toEqual([]);
    });

    it('sells exactly what exists when many sales arrive at once', async () => {
      await stockIn({ batchRef: 'B1', expiry: day(100), qty: '10' });
      await stockIn({ batchRef: 'B2', expiry: day(120), qty: '5' });
      const inv = ctx.app.get(InventoryService);
      const sell = (n: number) => ctx.db.tx((q) => inv.issueFefo(q, { productId: para.id, branchId: branchA.id, baseQuantity: '1', movementType: 'sale', referenceNo: `S-MANY-${n}`, sourceType: 'sale' }));
      const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => sell(i)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(15);
      expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'INSUFFICIENT_STOCK')).toBe(true);
      expect(await available()).toBe(0);
      const refs = (await ctx.db.query(`select reference_no from inventory.stock_movements where movement_type = 'sale'`)).rows.map((r) => r.reference_no);
      expect(new Set(refs).size).toBe(15); // every successful sale produced its own movement, none twice
      expect(await reconcile()).toEqual([]);
    });
  });

  describe('expiry', () => {
    it('moves out-of-date stock to the expired status and is safe to repeat', async () => {
      await stockIn({ batchRef: 'OLD', expiry: day(-3), qty: '50' });
      await stockIn({ batchRef: 'FRESH', expiry: day(100), qty: '20' });
      const sweep = await keeper.post('/inventory/expiry-sweep', {});
      expect(sweep.body.moved).toBe(1);
      expect(sweep.body.reference).toBe('STS-000001');
      const bal = (await admin.get(`/inventory/stock?productId=${para.id}`)).body.items.map((i: any) => `${i.batch_ref}:${i.status}:${Number(i.quantity)}`).sort();
      expect(bal).toEqual(['FRESH:available:20', 'OLD:expired:50']);
      expect((await keeper.post('/inventory/expiry-sweep', {})).body.moved).toBe(0);
      expect((await admin.get('/inventory/movements?movementType=expiry')).body.total).toBe(2);
      expect(await reconcile()).toEqual([]);
    });

    it('sweeps only the branches the user is responsible for', async () => {
      await stockIn({ batchRef: 'A-OLD', expiry: day(-3), qty: '5' });
      await stockIn({ warehouseId: whB.id, batchRef: 'B-OLD', expiry: day(-3), qty: '7' });
      const keeperA = await userWith('keeper.a', 'Storekeeper', branchA.id);
      expect((await keeperA.post('/inventory/expiry-sweep', {})).body.moved).toBe(1);
      expect((await keeperA.post('/inventory/expiry-sweep', { branchId: branchB.id })).status).toBe(404);
      const b = (await admin.get(`/inventory/stock?branchId=${branchB.id}&status=available`)).body.items;
      expect(b).toHaveLength(1); // branch B still has it as available until its own sweep
    });
  });

  describe('quarantine, release and damage', () => {
    let batch: any;
    beforeEach(async () => { await stockIn({ batchRef: 'B1', expiry: day(100), qty: '100' }); batch = (await admin.get(`/inventory/batches?productId=${para.id}`)).body[0]; });
    const change = (client: any, body: object) => client.post('/inventory/status-changes', { warehouseId: whA.id, batchId: batch.id, quantity: '10', reason: 'Inspection needed', ...body });

    it('moves stock between statuses with two linked movements', async () => {
      const q = await change(keeper, { from: 'available', to: 'quarantined' });
      expect(q.status).toBe(201);
      expect(q.body.movements.map((m: any) => [m.status, m.quantity_delta])).toEqual([['available', '-10.0000'], ['quarantined', '10.0000']]);
      expect(q.body.movements[0].reference_no).toBe(q.body.movements[1].reference_no);
      expect(await available()).toBe(90);
      expect((await change(keeper, { from: 'available', to: 'damaged', quantity: '5', reason: 'Broken in transit' })).status).toBe(201);
      expect(await available()).toBe(85);
      expect(await reconcile()).toEqual([]);
    });

    it('requires a separate permission and an inspection decision to release quarantined stock', async () => {
      await change(keeper, { from: 'available', to: 'quarantined' });
      const denied = await change(keeper, { from: 'quarantined', to: 'available', reason: 'Inspection passed' });
      expect(denied.status).toBe(403);
      expect((await change(mgr, { from: 'quarantined', to: 'available', reason: 'Inspection passed' })).status).toBe(201);
      expect(await available()).toBe(100);
    });

    it('refuses impossible moves, too much stock, missing reasons and expired batches', async () => {
      expect((await change(keeper, { from: 'damaged', to: 'available' })).body.code).toBe('INVALID_TRANSITION');
      expect((await change(keeper, { from: 'available', to: 'available' })).body.code).toBe('INVALID_TRANSITION');
      expect((await change(keeper, { from: 'available', to: 'expired' })).body.code).toBe('INVALID_TRANSITION');
      expect((await change(keeper, { from: 'available', to: 'quarantined', quantity: '500' })).body.code).toBe('INSUFFICIENT_STOCK');
      expect((await change(keeper, { from: 'available', to: 'quarantined', reason: 'x' })).status).toBe(400);
      expect((await change(keeper, { from: 'available', to: 'quarantined', quantity: '0' })).body.code).toBe('INVALID_QUANTITY');
      await stockIn({ batchRef: 'OLD', expiry: day(-5), qty: '10' });
      const old = (await admin.get(`/inventory/batches?productId=${para.id}`)).body.find((b: any) => b.batch_ref === 'OLD');
      await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: old.id, quantity: '10', from: 'available', to: 'quarantined', reason: 'Past expiry date' });
      const release = await mgr.post('/inventory/status-changes', { warehouseId: whA.id, batchId: old.id, quantity: '10', from: 'quarantined', to: 'available', reason: 'Trying to release' });
      expect(release.body.code).toBe('BATCH_EXPIRED');
    });

    it('keeps branches apart', async () => {
      const keeperB = await userWith('keeper.b', 'Storekeeper', branchB.id);
      expect((await change(keeperB, { from: 'available', to: 'quarantined' })).status).toBe(404);
    });
  });

  describe('disposals', () => {
    let batch: any;
    beforeEach(async () => {
      await stockIn({ batchRef: 'B1', expiry: day(100), qty: '100' });
      batch = (await admin.get(`/inventory/batches?productId=${para.id}`)).body[0];
      await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: batch.id, quantity: '20', from: 'available', to: 'damaged', reason: 'Water damage' });
    });
    const dispose = (client: any, qty = '15', status = 'damaged') => client.post('/inventory/disposals', { warehouseId: whA.id, reason: 'damaged', note: 'Water damage', items: [{ batchId: batch.id, status, quantity: qty }] });

    it('writes off damaged stock only after approval by someone else', async () => {
      const d = await dispose(keeper);
      expect(d.status).toBe(201);
      expect(d.body).toMatchObject({ status: 'pending', reference_no: 'DSP-000001' });
      expect((await keeper.post(`/approvals/${d.body.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/approvals/${d.body.approval_id}/approve`, {})).status).toBe(200);
      const damaged = (await admin.get(`/inventory/stock?status=damaged`)).body.items[0];
      expect(damaged.quantity).toBe('5.0000');
      const m = (await admin.get('/inventory/movements?movementType=disposal')).body.items[0];
      expect(m).toMatchObject({ quantity_delta: '-15.0000', status: 'damaged', reference_no: 'DSP-000001' });
      expect((await mgr.get(`/inventory/disposals/${d.body.id}`)).body.status).toBe('posted');
      expect(await reconcile()).toEqual([]);
    });

    it('refuses to dispose more than is in that status, or stock that is not damaged, expired or quarantined', async () => {
      expect((await dispose(keeper, '25')).body.code).toBe('INSUFFICIENT_STOCK');
      expect((await dispose(keeper, '5', 'quarantined')).body.code).toBe('INSUFFICIENT_STOCK'); // none quarantined
      expect((await dispose(keeper, '5', 'available')).status).toBe(400); // available stock cannot be written off this way
    });

    it('can be rejected, and posts at once only when approval is switched off and the user may approve', async () => {
      const d = (await dispose(keeper)).body;
      expect((await mgr.post(`/approvals/${d.approval_id}/reject`, { comment: 'Still needs checking' })).body.status).toBe('rejected');
      expect((await admin.get('/inventory/stock?status=damaged')).body.items[0].quantity).toBe('20.0000');
      await admin.put('/settings/inventory.disposal_approval_required', { value: false });
      expect((await dispose(keeper)).status).toBe(403);
      expect((await dispose(mgr, '20')).body.status).toBe('posted');
      expect((await admin.get('/inventory/stock?status=damaged')).body.items).toHaveLength(0);
    });
  });

  describe('reports', () => {
    it('lists stock by branch and respects branch scope', async () => {
      await stockIn({ batchRef: 'A1', expiry: day(100), qty: '10' });
      await stockIn({ warehouseId: whB.id, batchRef: 'B1', expiry: day(100), qty: '20' });
      const mgrA = await userWith('mgr.a', 'Pharmacy Manager', branchA.id);
      const all = await admin.get('/inventory/stock');
      expect(all.body.total).toBe(2);
      const scoped = await mgrA.get('/inventory/stock');
      expect(scoped.body.items.map((i: any) => i.branch_id)).toEqual([branchA.id]);
      expect((await mgrA.get(`/inventory/stock?branchId=${branchB.id}`)).body.total).toBe(0);
      const summary = (await admin.get(`/inventory/stock/summary?branchId=${branchB.id}`)).body;
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({ sku: para.sku, available: '20.0000' });
      expect((await admin.get('/inventory/movements?pageSize=1')).body).toMatchObject({ total: 2, pageSize: 1 });
      const dispenser = await userWith('disp', 'Dispenser / Sales Staff');
      expect((await dispenser.get('/inventory/stock')).status).toBe(200);
      expect((await dispenser.post('/inventory/adjustments', {})).status).toBe(403);
      const cashier = await userWith('cash', 'Cashier');
      expect((await cashier.get('/inventory/stock')).status).toBe(403);
    });

    it('reports low and missing stock against reorder levels, including never-stocked products', async () => {
      await stockIn({ batchRef: 'A1', expiry: day(100), qty: '150' }); // reorder level is 200, so low
      const low = (await admin.get(`/inventory/low-stock?branchId=${branchA.id}`)).body;
      expect(low.map((r: any) => [r.name, r.available])).toEqual([['Amoxicillin', '0.0000'], ['Paracetamol', '150.0000']]);
      await stockIn({ batchRef: 'A2', expiry: day(100), qty: '100' });
      expect((await admin.get(`/inventory/low-stock?branchId=${branchA.id}`)).body.map((r: any) => r.name)).toEqual(['Amoxicillin']);
    });

    it('groups expiring stock into the configured warning periods', async () => {
      await stockIn({ batchRef: 'D5', expiry: day(5), qty: '1' });
      await stockIn({ batchRef: 'D20', expiry: day(20), qty: '2' });
      await stockIn({ batchRef: 'D100', expiry: day(100), qty: '3' });
      await stockIn({ batchRef: 'D400', expiry: day(400), qty: '4' });
      await stockIn({ batchRef: 'GONE', expiry: day(-4), qty: '5' });
      const rows = (await admin.get('/inventory/expiring')).body;
      expect(rows.map((r: any) => [r.batch_ref, r.bucket])).toEqual([['GONE', 'expired'], ['D5', 7], ['D20', 30], ['D100', 180]]);
      expect((await admin.get('/inventory/expiring?withinDays=30')).body.map((r: any) => r.batch_ref)).toEqual(['GONE', 'D5', 'D20']);
      await admin.put('/settings/inventory.expiry_warning_days', { value: [60, 14] });
      expect((await admin.get('/inventory/expiring')).body.map((r: any) => [r.batch_ref, r.bucket])).toEqual([['GONE', 'expired'], ['D5', 14], ['D20', 60]]);
    });

    it('values stock at the real cost of each batch', async () => {
      await stockIn({ batchRef: 'X', expiry: day(100), qty: '10', cost: '2' });
      await stockIn({ batchRef: 'Y', expiry: day(100), qty: '5', cost: '3.5' });
      const v = (await admin.get(`/inventory/valuation?branchId=${branchA.id}`)).body;
      expect(v.total).toBe('37.5000'); // 10 x 2 + 5 x 3.5
      expect(v.rows).toHaveLength(1);
    });

    it('locks a product\'s pack sizes once it has stock', async () => {
      await stockIn({ batchRef: 'X', expiry: day(100), qty: '10' });
      const res = await admin.put(`/products/${para.id}/units`, { units: [{ unitId: U.strip, factorToBase: '12' }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRODUCT_IN_USE');
    });
  });

  describe('approvals visibility', () => {
    it('shows a request only to its requester and to people entitled to decide it', async () => {
      const res = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'found', reason: 'Found stock', items: [{ productId: para.id, quantity: '5', direction: 'increase', newBatch: { batchRef: 'F1', expiryDate: day(100), unitCost: '1' } }] });
      const mgrB = await userWith('mgr.b', 'Branch Manager', branchB.id);
      const cashier = await userWith('cash', 'Cashier');
      expect((await mgrB.get('/approvals')).body).toHaveLength(0);
      expect((await mgrB.get(`/approvals/${res.body.approval_id}`)).status).toBe(404);
      expect((await mgrB.post(`/approvals/${res.body.approval_id}/approve`, {})).status).toBe(404);
      expect((await cashier.get('/approvals')).body).toHaveLength(0);
      const mgrA = await userWith('mgr.a', 'Branch Manager', branchA.id);
      expect((await mgrA.get('/approvals')).body).toHaveLength(1);
      expect((await mgrA.post(`/approvals/${res.body.approval_id}/approve`, {})).status).toBe(200);
    });
  });
});
