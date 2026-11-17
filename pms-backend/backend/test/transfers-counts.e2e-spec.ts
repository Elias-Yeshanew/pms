import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';
import { InventoryService } from '../src/modules/inventory/inventory.service';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Stock transfers and physical counts', () => {
  let ctx: TestCtx;
  let admin: Client, mgr: Client, keeper: Client;
  let U: Record<string, string>;
  let A: any, B: any, C: any, whA: any, whA2: any, whB: any, locA: any, para: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  async function userWith(username: string, role: string, branchId?: string) {
    expect((await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] })).status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
    A = (await admin.post('/branches', { code: 'MAIN', name: 'Main' })).body;
    B = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa' })).body;
    C = (await admin.post('/branches', { code: 'BOLE', name: 'Bole' })).body;
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W1', name: 'Main store' })).body;
    whA2 = (await admin.post('/warehouses', { branchId: A.id, code: 'W2', name: 'Main back store' })).body;
    whB = (await admin.post('/warehouses', { branchId: B.id, code: 'W1', name: 'Piassa store' })).body;
    locA = (await admin.post('/storage-locations', { warehouseId: whA.id, code: 'S1', name: 'Shelf 1' })).body;
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }] })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
  });

  async function stockIn(warehouseId: string, batchRef: string, expiry: number, qty: string, cost = '2', locationId?: string) {
    const res = await keeper.post('/inventory/adjustments', { warehouseId, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: para.id, quantity: qty, direction: 'increase', locationId, newBatch: { batchRef, expiryDate: day(expiry), unitCost: cost } }] });
    expect(res.status).toBe(201);
    expect((await mgr.post(`/approvals/${res.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const onHand = async (warehouseId: string, status = 'available') =>
    Object.fromEntries((await admin.get(`/inventory/stock?warehouseId=${warehouseId}&status=${status}&pageSize=100`)).body.items.map((i: any) => [i.batch_ref, Number(i.quantity)]));
  const reconcile = async () => (await admin.get('/inventory/reconcile')).body;
  const batchId = async (ref: string) => (await admin.get(`/inventory/batches?productId=${para.id}`)).body.find((b: any) => b.batch_ref === ref).id;

  describe('transfers', () => {
    let keeperA: Client, keeperB: Client, mgrA: Client, mgrB: Client;
    beforeEach(async () => {
      keeperA = await userWith('keeper.a', 'Storekeeper', A.id);
      keeperB = await userWith('keeper.b', 'Storekeeper', B.id);
      mgrA = await userWith('mgr.a', 'Branch Manager', A.id);
      mgrB = await userWith('mgr.b', 'Branch Manager', B.id);
    });
    const request = (client: Client, items: any[], extra: object = {}) => client.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whB.id, items, ...extra });

    it('moves stock from one branch to another: request, approve, dispatch, receive', async () => {
      await stockIn(whA.id, 'B1', 100, '50', '2');
      const b1 = await batchId('B1');
      const t = (await request(keeperA, [{ productId: para.id, batchId: b1, quantity: '20' }], { note: 'Restock Piassa' })).body;
      expect(t).toMatchObject({ status: 'pending_approval', reference_no: 'TRF-000001', from_branch_id: A.id, to_branch_id: B.id });
      expect(await onHand(whA.id)).toEqual({ B1: 50 }); // nothing moves on request

      expect((await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {})).body.code).toBe('TRANSFER_NOT_READY');
      expect((await keeperA.post(`/approvals/${t.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgrB.post(`/approvals/${t.approval_id}/approve`, {})).status).toBe(404); // the receiving branch cannot approve the sender's stock leaving
      expect((await mgrA.post(`/approvals/${t.approval_id}/approve`, {})).status).toBe(200);

      expect((await keeperB.post(`/inventory/transfers/${t.id}/dispatch`, {})).status).toBe(403); // only the sender dispatches
      const sent = await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {});
      expect(sent.body.status).toBe('dispatched');
      expect(await onHand(whA.id)).toEqual({ B1: 30 });
      expect(await onHand(whB.id)).toEqual({});
      const valuation = (await admin.get('/inventory/valuation')).body;
      expect(valuation.inTransit).toBe('40.0000'); // 20 tablets at 2.00 are on the road
      expect(valuation.total).toBe('60.0000'); // 30 left on the shelf at 2.00

      expect((await keeperA.post(`/inventory/transfers/${t.id}/receive`, {})).status).toBe(403); // only the receiver receives
      expect((await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {})).body.code).toBe('TRANSFER_NOT_READY');
      const got = await keeperB.post(`/inventory/transfers/${t.id}/receive`, {});
      expect(got.body.status).toBe('received');
      expect(await onHand(whB.id)).toEqual({ B1: 20 });
      expect((await admin.get(`/inventory/stock?warehouseId=${whB.id}`)).body.items[0]).toMatchObject({ batch_id: b1, expiry_date: day(100) }); // same batch and expiry date
      expect((await admin.get('/inventory/valuation')).body.inTransit).toBe('0.0000');
      const types = (await admin.get(`/inventory/movements?referenceNo=TRF-000001`)).body.items.map((m: any) => m.movement_type).sort();
      expect(types).toEqual(['transfer_in', 'transfer_out']);
      expect((await admin.get('/inventory/movements?movementType=sale')).body.total).toBe(0); // never a sale
      expect(await reconcile()).toEqual([]);
      expect((await keeperB.post(`/inventory/transfers/${t.id}/receive`, {})).body.code).toBe('TRANSFER_NOT_IN_TRANSIT');
    });

    it('shows a transfer only to the two branches involved', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const t = (await request(keeperA, [{ productId: para.id, batchId: await batchId('B1'), quantity: '5' }])).body;
      const keeperC = await userWith('keeper.c', 'Storekeeper', C.id);
      expect((await keeperC.get(`/inventory/transfers/${t.id}`)).status).toBe(404);
      expect((await keeperC.get('/inventory/transfers')).body.total).toBe(0);
      expect((await keeperB.get(`/inventory/transfers/${t.id}`)).status).toBe(200);
      expect((await keeperB.get('/inventory/transfers')).body.total).toBe(1);
      expect((await keeperC.post(`/inventory/transfers/${t.id}/dispatch`, {})).status).toBe(404);
      expect((await keeperB.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whB.id, items: [{ productId: para.id, quantity: '1' }] })).status).toBe(404); // cannot pull stock out of another branch
    });

    it('chooses batches by earliest expiry when none are named, and converts pack sizes', async () => {
      await stockIn(whA.id, 'LATE', 200, '100');
      await stockIn(whA.id, 'SOON', 30, '10');
      const t = (await request(keeperA, [{ productId: para.id, unitId: U.strip, quantity: '2.5' }])).body; // 25 tablets
      expect(t.items.map((i: any) => [i.batch_ref, i.quantity_requested])).toEqual([['SOON', '10.0000'], ['LATE', '15.0000']]); // earliest expiry first
      expect((await request(keeperA, [{ productId: para.id, quantity: '500' }])).body.code).toBe('INSUFFICIENT_STOCK');
    });

    it('records what was really sent and received, and needs a reason for anything missing', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const b1 = await batchId('B1');
      const t = (await request(keeperA, [{ productId: para.id, batchId: b1, quantity: '20' }])).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      const item = t.items[0];
      expect((await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, { items: [{ itemId: item.id, quantitySent: '25' }] })).body.code).toBe('SENT_EXCEEDS_REQUESTED');
      expect((await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, { items: [{ itemId: item.id, quantitySent: '0' }] })).body.code).toBe('NOTHING_TO_SEND');
      const sent = await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, { items: [{ itemId: item.id, quantitySent: '18' }] });
      expect(sent.body.items[0]).toMatchObject({ quantity_requested: '20.0000', quantity_sent: '18.0000' });
      expect(await onHand(whA.id)).toEqual({ B1: 32 });

      expect((await keeperB.post(`/inventory/transfers/${t.id}/receive`, { items: [{ itemId: item.id, quantityReceived: '19' }] })).body.code).toBe('RECEIVED_EXCEEDS_SENT');
      const noReason = await keeperB.post(`/inventory/transfers/${t.id}/receive`, { items: [{ itemId: item.id, quantityReceived: '15' }] });
      expect(noReason.body.code).toBe('DISCREPANCY_REASON_REQUIRED');
      expect(await onHand(whB.id)).toEqual({}); // the refused attempt changed nothing

      const short = await keeperB.post(`/inventory/transfers/${t.id}/receive`, { items: [{ itemId: item.id, quantityReceived: '15', discrepancyReason: 'Box crushed, 3 strips missing' }] });
      expect(short.body.status).toBe('received_with_discrepancy');
      expect(short.body.items[0]).toMatchObject({ quantity_sent: '18.0000', quantity_received: '15.0000', quantity_missing: '3.0000', discrepancy_reason: 'Box crushed, 3 strips missing' });
      expect(await onHand(whB.id)).toEqual({ B1: 15 });
      expect((await admin.get('/inventory/valuation')).body.inTransit).toBe('0.0000');
      expect(await reconcile()).toEqual([]);

      // reviewed and closed by someone other than the receiver
      expect((await keeperB.post(`/inventory/transfers/${t.id}/resolve`, { note: 'Reviewed' })).status).toBe(403); // needs approval permission
      const closed = await mgrB.post(`/inventory/transfers/${t.id}/resolve`, { note: 'Carrier claim filed, loss accepted' });
      expect(closed.body).toMatchObject({ status: 'closed', resolution_note: 'Carrier claim filed, loss accepted' });
      expect((await mgrB.post(`/inventory/transfers/${t.id}/resolve`, { note: 'again please' })).body.code).toBe('NO_DISCREPANCY_TO_RESOLVE');
    });

    it('does not let the receiver close their own discrepancy', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const t = (await request(keeperA, [{ productId: para.id, batchId: await batchId('B1'), quantity: '10' }])).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {});
      await mgrB.post(`/inventory/transfers/${t.id}/receive`, { items: [{ itemId: t.items[0].id, quantityReceived: '8', discrepancyReason: 'Two strips missing' }] });
      const own = await mgrB.post(`/inventory/transfers/${t.id}/resolve`, { note: 'Fine by me' });
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('CANNOT_RESOLVE_OWN_RECEIPT');
      expect((await mgrA.post(`/inventory/transfers/${t.id}/resolve`, { note: 'Sender confirms the shortage' })).body.status).toBe('closed');
    });

    it('lets goods that arrive damaged or quarantined be received into that status', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const t = (await request(keeperA, [{ productId: para.id, batchId: await batchId('B1'), quantity: '10' }])).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {});
      const got = await keeperB.post(`/inventory/transfers/${t.id}/receive`, { items: [{ itemId: t.items[0].id, quantityReceived: '10', receivedStatus: 'damaged' }] });
      expect(got.body.status).toBe('received');
      expect(await onHand(whB.id, 'damaged')).toEqual({ B1: 10 });
      expect(await onHand(whB.id, 'available')).toEqual({});
    });

    it('stops at dispatch if the stock has gone in the meantime, and leaves the transfer waiting', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const b1 = await batchId('B1');
      const t = (await request(keeperA, [{ productId: para.id, batchId: b1, quantity: '40' }])).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      await ctx.db.tx((q) => ctx.app.get(InventoryService).issueFefo(q, { productId: para.id, branchId: A.id, baseQuantity: '30', movementType: 'sale', referenceNo: 'S-1', sourceType: 'sale' }));
      const fail = await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {});
      expect(fail.status).toBe(409);
      expect(fail.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await keeperA.get(`/inventory/transfers/${t.id}`)).body.status).toBe('approved');
      expect(await onHand(whA.id)).toEqual({ B1: 20 });
      expect((await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, { items: [{ itemId: t.items[0].id, quantitySent: '20' }] })).status).toBe(200); // send what is left
    });

    it('sends only once when two people dispatch at the same moment', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const t = (await request(keeperA, [{ productId: para.id, batchId: await batchId('B1'), quantity: '20' }])).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      const results = await Promise.all([keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {}), mgrA.post(`/inventory/transfers/${t.id}/dispatch`, {})]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await onHand(whA.id)).toEqual({ B1: 30 }); // 20 left once, not twice
      expect(await reconcile()).toEqual([]);
    });

    it('can be cancelled before dispatch, by the right people, and not after', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const b1 = await batchId('B1');
      const mk = async () => (await request(keeperA, [{ productId: para.id, batchId: b1, quantity: '5' }])).body;
      const pending = await mk();
      expect((await mgrA.post(`/inventory/transfers/${pending.id}/cancel`, {})).body.code).toBe('ONLY_REQUESTER_CAN_CANCEL');
      expect((await keeperA.post(`/inventory/transfers/${pending.id}/cancel`, {})).body.status).toBe('cancelled');
      const approved = await mk();
      await mgrA.post(`/approvals/${approved.approval_id}/approve`, {});
      expect((await keeperB.post(`/inventory/transfers/${approved.id}/cancel`, {})).status).toBe(403);
      expect((await mgrA.post(`/inventory/transfers/${approved.id}/cancel`, {})).body.status).toBe('cancelled');
      const sentOne = await mk();
      await mgrA.post(`/approvals/${sentOne.approval_id}/approve`, {});
      await keeperA.post(`/inventory/transfers/${sentOne.id}/dispatch`, {});
      expect((await keeperA.post(`/inventory/transfers/${sentOne.id}/cancel`, {})).body.code).toBe('TRANSFER_NOT_CANCELLABLE');
      const rejected = await mk();
      expect((await mgrA.post(`/approvals/${rejected.approval_id}/reject`, { comment: 'Keep stock here' })).body.status).toBe('rejected');
      expect((await keeperA.get(`/inventory/transfers/${rejected.id}`)).body.status).toBe('rejected');
    });

    it('validates warehouses and approval settings', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const line = [{ productId: para.id, batchId: await batchId('B1'), quantity: '5' }];
      expect((await keeperA.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whA.id, items: line })).body.code).toBe('SAME_WAREHOUSE');
      const whOff = (await admin.post('/warehouses', { branchId: B.id, code: 'OLD', name: 'Closed' })).body;
      await admin.patch(`/warehouses/${whOff.id}`, { version: whOff.version, status: 'inactive' });
      expect((await keeperA.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whOff.id, items: line })).body.code).toBe('WAREHOUSE_INACTIVE');
      expect((await keeperA.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: '00000000-0000-4000-8000-000000000000', items: line })).body.code).toBe('WAREHOUSE_NOT_FOUND');
      expect((await keeperA.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whB.id, items: [] })).status).toBe(400);
      expect((await request(keeperA, [{ productId: para.id, batchId: await batchId('B1'), quantity: '500' }])).body.code).toBe('INSUFFICIENT_STOCK');

      await admin.put('/settings/inventory.transfer_approval_required', { value: false });
      expect((await request(keeperA, line)).status).toBe(403); // approvals are off, so only someone who may approve can create one
      expect((await request(mgrA, line)).body.status).toBe('approved');
    });

    it('also moves stock between two warehouses of the same branch', async () => {
      await stockIn(whA.id, 'B1', 100, '50');
      const t = (await keeperA.post('/inventory/transfers', { fromWarehouseId: whA.id, toWarehouseId: whA2.id, items: [{ productId: para.id, batchId: await batchId('B1'), quantity: '12' }] })).body;
      await mgrA.post(`/approvals/${t.approval_id}/approve`, {});
      await keeperA.post(`/inventory/transfers/${t.id}/dispatch`, {});
      expect((await keeperA.post(`/inventory/transfers/${t.id}/receive`, {})).body.status).toBe('received');
      expect(await onHand(whA2.id)).toEqual({ B1: 12 });
      expect(await onHand(whA.id)).toEqual({ B1: 38 });
    });
  });

  describe('physical counts', () => {
    let keeperA: Client, mgrA: Client;
    beforeEach(async () => {
      keeperA = await userWith('keeper.a', 'Storekeeper', A.id);
      mgrA = await userWith('mgr.a', 'Branch Manager', A.id);
    });
    const countOf = async (client: Client, extra: object = {}) => (await client.post('/inventory/counts', { warehouseId: whA.id, ...extra })).body;
    const enter = (client: Client, count: any, byBatch: Record<string, string>, unitId?: string) =>
      client.put(`/inventory/counts/${count.id}/items`, { items: count.items.filter((i: any) => byBatch[i.batch_ref] !== undefined).map((i: any) => ({ itemId: i.id, countedQuantity: byBatch[i.batch_ref], unitId })) });

    it('corrects stock to what was counted, after a second person approves', async () => {
      await stockIn(whA.id, 'B1', 100, '30', '2');
      await stockIn(whA.id, 'B2', 200, '10', '3');
      const c = await countOf(keeperA);
      expect(c).toMatchObject({ status: 'counting', reference_no: 'CNT-000001' });
      expect(c.items.map((i: any) => [i.batch_ref, i.system_quantity, i.counted_quantity])).toEqual([['B1', '30.0000', null], ['B2', '10.0000', null]]);
      expect((await countOf(keeperA)).code).toBe('COUNT_ALREADY_OPEN');

      await enter(keeperA, c, { B1: '28' });
      const incomplete = await keeperA.post(`/inventory/counts/${c.id}/submit`, {});
      expect(incomplete.status).toBe(400);
      expect(incomplete.body.code).toBe('COUNT_INCOMPLETE');

      await enter(keeperA, c, { B2: '13' });
      const submitted = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      expect(submitted.status).toBe('submitted');
      expect(submitted.items.map((i: any) => [i.batch_ref, i.variance, i.variance_value])).toEqual([['B1', '-2.0000', '-4.0000'], ['B2', '3.0000', '9.0000']]);
      expect(submitted.net_variance_value).toBe('5.0000');
      expect(await onHand(whA.id)).toEqual({ B1: 30, B2: 10 }); // nothing changes before approval

      expect((await keeperA.post(`/approvals/${submitted.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgrA.post(`/approvals/${submitted.approval_id}/approve`, {})).status).toBe(200);
      expect(await onHand(whA.id)).toEqual({ B1: 28, B2: 13 });
      expect((await keeperA.get(`/inventory/counts/${c.id}`)).body.status).toBe('posted');
      const moves = (await admin.get('/inventory/movements?movementType=count_adjustment')).body.items;
      expect(moves.map((m: any) => m.quantity_delta).sort()).toEqual(['-2.0000', '3.0000']);
      expect(moves[0].reference_no).toBe('CNT-000001');
      expect(await reconcile()).toEqual([]);
      expect((await countOf(keeperA)).status).toBe('counting'); // a new count can start once the last is finished
    });

    it('records a clean count without needing approval or moving any stock', async () => {
      await stockIn(whA.id, 'B1', 100, '30');
      const c = await countOf(keeperA);
      await enter(keeperA, c, { B1: '30' });
      const done = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      expect(done.status).toBe('posted');
      expect((await admin.get('/inventory/movements?movementType=count_adjustment')).body.total).toBe(0);
    });

    it('sends a rejected count back to the counters with the reviewer\'s comment', async () => {
      await stockIn(whA.id, 'B1', 100, '30');
      const c = await countOf(keeperA);
      await enter(keeperA, c, { B1: '20' });
      const sub = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      expect((await mgrA.post(`/approvals/${sub.approval_id}/reject`, { comment: 'Recount shelf 2, 10 units look missing' })).body.status).toBe('rejected');
      const back = (await keeperA.get(`/inventory/counts/${c.id}`)).body;
      expect(back).toMatchObject({ status: 'counting', review_comment: 'Recount shelf 2, 10 units look missing' });
      expect(back.items[0].counted_quantity).toBe('20.0000'); // earlier entries are kept
      await enter(keeperA, back, { B1: '29' });
      const again = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      expect((await mgrA.post(`/approvals/${again.approval_id}/approve`, {})).status).toBe(200);
      expect(await onHand(whA.id)).toEqual({ B1: 29 });
    });

    it('keeps sales made while counting: the correction is the difference found, not a reset', async () => {
      await stockIn(whA.id, 'B1', 100, '30');
      const c = await countOf(keeperA); // the system expects 30
      await ctx.db.tx((q) => ctx.app.get(InventoryService).issueFefo(q, { productId: para.id, branchId: A.id, baseQuantity: '10', movementType: 'sale', referenceNo: 'S-DURING', sourceType: 'sale' }));
      await enter(keeperA, c, { B1: '28' }); // two fewer than the 30 it started with
      const sub = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      await mgrA.post(`/approvals/${sub.approval_id}/approve`, {});
      expect(await onHand(whA.id)).toEqual({ B1: 18 }); // 30 - 10 sold - 2 found missing
      expect(await reconcile()).toEqual([]);
    });

    it('fails safely if stock has dropped below what the count assumed', async () => {
      await stockIn(whA.id, 'B1', 100, '30');
      const c = await countOf(keeperA);
      await ctx.db.tx((q) => ctx.app.get(InventoryService).issueFefo(q, { productId: para.id, branchId: A.id, baseQuantity: '29', movementType: 'sale', referenceNo: 'S-BIG', sourceType: 'sale' }));
      await enter(keeperA, c, { B1: '25' }); // 5 short of the snapshot, but only 1 is left to remove
      const sub = (await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body;
      const fail = await mgrA.post(`/approvals/${sub.approval_id}/approve`, {});
      expect(fail.status).toBe(409);
      expect(fail.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await keeperA.get(`/inventory/counts/${c.id}`)).body.status).toBe('submitted');
      expect(await onHand(whA.id)).toEqual({ B1: 1 });
    });

    it('counts a single storage location, converts pack sizes, and rejects bad entries', async () => {
      await stockIn(whA.id, 'SHELF', 100, '30', '2', locA.id);
      await stockIn(whA.id, 'LOOSE', 100, '40');
      const c = await countOf(keeperA, { locationId: locA.id });
      expect(c.items.map((i: any) => i.batch_ref)).toEqual(['SHELF']);
      expect((await keeperA.put(`/inventory/counts/${c.id}/items`, { items: [{ itemId: c.items[0].id, countedQuantity: '-1' }] })).status).toBe(400);
      expect((await keeperA.put(`/inventory/counts/${c.id}/items`, { items: [{ itemId: '00000000-0000-4000-8000-000000000000', countedQuantity: '1' }] })).body.code).toBe('ITEM_NOT_IN_COUNT');
      await enter(keeperA, c, { SHELF: '2.5' }, U.strip); // 2.5 strips = 25 tablets
      expect((await keeperA.get(`/inventory/counts/${c.id}`)).body.items[0]).toMatchObject({ counted_quantity: '25.0000' });
      expect((await keeperA.post('/inventory/counts', { warehouseId: whA.id, locationId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('LOCATION_NOT_IN_WAREHOUSE');
      expect((await keeperA.post('/inventory/counts', { warehouseId: whA.id, locationId: locA.id })).body.code).toBe('COUNT_ALREADY_OPEN');
    });

    it('keeps branches apart and honours the approval setting', async () => {
      await stockIn(whA.id, 'B1', 100, '30');
      const keeperB = await userWith('keeper.b', 'Storekeeper', B.id);
      expect((await keeperB.post('/inventory/counts', { warehouseId: whA.id })).status).toBe(404);
      const c = await countOf(keeperA);
      expect((await keeperB.get(`/inventory/counts/${c.id}`)).status).toBe(404);
      expect((await keeperB.put(`/inventory/counts/${c.id}/items`, { items: [{ itemId: c.items[0].id, countedQuantity: '1' }] })).status).toBe(404);
      expect((await keeperA.post(`/inventory/counts/${c.id}/cancel`, {})).body.status).toBe('cancelled');
      expect((await keeperA.post(`/inventory/counts/${c.id}/submit`, {})).body.code).toBe('COUNT_NOT_OPEN');

      await admin.put('/settings/inventory.count_approval_required', { value: false });
      const c2 = await countOf(keeperA);
      await enter(keeperA, c2, { B1: '27' });
      expect((await keeperA.post(`/inventory/counts/${c2.id}/submit`, {})).status).toBe(403); // posts immediately, so needs approval rights
      expect((await mgrA.put(`/inventory/counts/${c2.id}/items`, { items: [{ itemId: c2.items[0].id, countedQuantity: '27' }] })).status).toBe(200);
      expect((await mgrA.post(`/inventory/counts/${c2.id}/submit`, {})).body.status).toBe('posted');
      expect(await onHand(whA.id)).toEqual({ B1: 27 });
    });
  });
});
