import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Procurement', () => {
  let ctx: TestCtx;
  let admin: Client, buyer: Client, mgr: Client, keeper: Client, acct: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, whB: any, s1: any, s2: any, para: any, amox: any;

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
    A = (await admin.post('/branches', { code: 'MAIN', name: 'Main' })).body;
    B = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa' })).body;
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W', name: 'Main store' })).body;
    whB = (await admin.post('/warehouses', { branchId: B.id, code: 'W', name: 'Piassa store' })).body;
    s1 = (await admin.post('/suppliers', { name: 'EPSA Depot', paymentTermsDays: 30 })).body;
    s2 = (await admin.post('/suppliers', { name: 'Kilinto Pharma', paymentTermsDays: 14 })).body;
    const vat = (await admin.post('/tax-categories', { name: 'VAT standard' })).body;
    await admin.post('/tax-rules', { taxCategoryId: vat.id, taxCode: 'VAT', name: 'VAT', rate: '15', isInclusive: false, effectiveFrom: '2020-01-01' });
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, taxCategoryId: vat.id, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }] })).body;
    amox = (await admin.post('/products', { name: 'Amoxicillin', baseUnitId: U.capsule })).body;
    buyer = await userWith('buyer', 'Supply Chain Manager');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    keeper = await userWith('keeper', 'Storekeeper');
    acct = await userWith('acct', 'Accountant');
  });

  // ---- helpers ----
  const poBody = (extra: object = {}) => ({ supplierId: s1.id, warehouseId: whA.id, items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '400' }], ...extra });
  const mkPo = async (extra: object = {}, client: Client = buyer) => { const r = await client.post('/purchase-orders', poBody(extra)); expect(r.status).toBe(201); return r.body; };
  const approvePo = async (po: any) => {
    const sub = await buyer.post(`/purchase-orders/${po.id}/submit`, {});
    expect(sub.status).toBe(200);
    expect((await mgr.post(`/approvals/${sub.body.approval_id}/approve`, {})).status).toBe(200);
    return (await mgr.get(`/purchase-orders/${po.id}`)).body;
  };
  const approvedPo = async (extra: object = {}) => approvePo(await mkPo(extra));
  const receive = (po: any, qty = '2', extra: object = {}, client: Client = keeper) =>
    client.post('/goods-receipts', { purchaseOrderId: po.id, deliveryNoteNo: 'DN-1', items: [{ orderItemId: po.items[0].id, quantity: qty, batchRef: 'LOT1', expiryDate: day(300), ...extra }] });
  const stock = async (status: string, warehouseId = whA.id) =>
    Object.fromEntries((await admin.get(`/inventory/stock?warehouseId=${warehouseId}&status=${status}`)).body.items.map((i: any) => [`${i.product_name}:${i.batch_ref}`, Number(i.quantity)]));
  const reconcile = async () => (await admin.get('/inventory/reconcile')).body;
  /** Orders, receives and inspects everything in one go. */
  const delivered = async (extra: object = {}) => {
    const po = await approvedPo(extra);
    const rc = (await receive(po)).body;
    await keeper.post(`/goods-receipts/${rc.id}/inspect`, {});
    return { po: (await mgr.get(`/purchase-orders/${po.id}`)).body, rc };
  };
  const invoiceBody = (po: any, extra: object = {}) => ({ purchaseOrderId: po.id, invoiceNo: 'INV-1', invoiceDate: day(0), subtotal: '800', taxTotal: '120', total: '920', ...extra });

  describe('purchase requests and reordering', () => {
    it('turns a request into an order, with a second person approving and quantities converted exactly', async () => {
      const pr = await keeper.post('/purchase-requests', { warehouseId: whA.id, neededBy: day(10), items: [{ productId: para.id, unitId: U.box, quantity: '2' }, { productId: amox.id, quantity: '50' }] });
      expect(pr.status).toBe(201);
      expect(pr.body).toMatchObject({ status: 'pending_approval', reference_no: 'PR-000001' });
      expect(pr.body.items.map((i: any) => [i.product_name, i.base_quantity])).toEqual([['Amoxicillin', '50.0000'], ['Paracetamol', '200.0000']]);
      expect((await keeper.post(`/approvals/${pr.body.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/purchase-orders`, poBody({ purchaseRequestId: pr.body.id }))).body.code).toBe('REQUEST_NOT_APPROVED');
      expect((await mgr.post(`/approvals/${pr.body.approval_id}/approve`, {})).status).toBe(200);
      const po = await buyer.post('/purchase-orders', poBody({ purchaseRequestId: pr.body.id }));
      expect(po.status).toBe(201);
      expect((await keeper.get(`/purchase-requests/${pr.body.id}`)).body.status).toBe('converted');
      expect((await buyer.post('/purchase-orders', poBody({ purchaseRequestId: pr.body.id }))).body.code).toBe('REQUEST_NOT_APPROVED'); // cannot be used twice
    });

    it('can be withdrawn or rejected, and stays within the branch', async () => {
      const mk = async () => (await keeper.post('/purchase-requests', { warehouseId: whA.id, items: [{ productId: amox.id, quantity: '5' }] })).body;
      const a = await mk(), b = await mk();
      expect((await keeper.post(`/purchase-requests/${a.id}/cancel`, {})).body.status).toBe('cancelled');
      expect((await mgr.post(`/approvals/${b.approval_id}/reject`, { comment: 'Not needed' })).body.status).toBe('rejected');
      expect((await keeper.get(`/purchase-requests/${b.id}`)).body.status).toBe('rejected');
      const keeperB = await userWith('keeper.b', 'Storekeeper', B.id);
      expect((await keeperB.post('/purchase-requests', { warehouseId: whA.id, items: [{ productId: amox.id, quantity: '5' }] })).status).toBe(404);
      expect((await keeperB.get(`/purchase-requests/${a.id}`)).status).toBe(404);
      expect((await keeper.post('/purchase-requests', { warehouseId: whA.id, items: [{ productId: amox.id, quantity: '0' }] })).body.code).toBe('INVALID_QUANTITY');
      expect((await keeper.post('/purchase-requests', { warehouseId: whA.id, items: [{ productId: amox.id, quantity: '1' }, { productId: amox.id, quantity: '2' }] })).body.code).toBe('DUPLICATE_LINE');
    });

    it('suggests what to reorder from stock levels, with the supplier that delivered last', async () => {
      const re = (await admin.post('/products', { name: 'Reorderable', baseUnitId: U.tablet, reorderLevel: '200', maxStock: '1000' })).body;
      expect((await buyer.get(`/procurement/reorder-suggestions?branchId=${A.id}`)).body.find((r: any) => r.name === 'Reorderable')).toMatchObject({ available: '0.0000', suggested_base_quantity: '1000.0000', last_supplier_id: null });
      const po = await approvePo(await mkPo({ items: [{ productId: re.id, quantity: '50', unitPrice: '1' }] }));
      const rc = (await receive(po, '50')).body;
      await keeper.post(`/goods-receipts/${rc.id}/inspect`, {});
      const s = (await buyer.get(`/procurement/reorder-suggestions?branchId=${A.id}`)).body.find((r: any) => r.name === 'Reorderable');
      expect(s).toMatchObject({ available: '50.0000', suggested_base_quantity: '950.0000', last_supplier_id: s1.id, last_unit_cost: '1.0000' });
    });
  });

  describe('purchase orders', () => {
    it('prices lines with tax, needs a second person to approve, and snapshots the supplier\'s terms', async () => {
      const po = await mkPo({ items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '400' }, { productId: amox.id, quantity: '10', unitPrice: '2' }] });
      expect(po).toMatchObject({ status: 'draft', reference_no: 'PO-000001', subtotal: '820.0000', tax_total: '120.0000', total: '940.0000', supplier_code: 'SUP-000001' });
      const lines = Object.fromEntries(po.items.map((i: any) => [i.product_name, i]));
      expect(lines.Paracetamol).toMatchObject({ base_quantity: '200.0000', line_net: '800.0000', tax_amount: '120.0000', line_total: '920.0000', tax_rate: '15.0000' });
      expect(lines.Amoxicillin).toMatchObject({ line_total: '20.0000', tax_amount: '0.0000' });

      const sub = (await buyer.post(`/purchase-orders/${po.id}/submit`, {})).body;
      expect(sub.status).toBe('pending_approval');
      expect((await buyer.post(`/approvals/${sub.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await buyer.patch(`/purchase-orders/${po.id}`, { version: sub.version, note: 'late edit' })).body.code).toBe('ORDER_NOT_DRAFT');
      await admin.patch(`/suppliers/${s1.id}`, { version: s1.version, paymentTermsDays: 45 });
      expect((await mgr.post(`/approvals/${sub.approval_id}/approve`, {})).status).toBe(200);
      const done = (await mgr.get(`/purchase-orders/${po.id}`)).body;
      expect(done).toMatchObject({ status: 'approved', payment_terms_days: 45 });
      expect(done.approved_by).toBeTruthy();
    });

    it('lets a draft be edited with version checks and rejects bad input', async () => {
      const po = await mkPo();
      const edited = await buyer.patch(`/purchase-orders/${po.id}`, { version: po.version, expectedDate: day(7), items: [{ productId: para.id, unitId: U.strip, quantity: '5', unitPrice: '45' }] });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ subtotal: '225.0000', tax_total: '33.7500', total: '258.7500' });
      expect((await buyer.patch(`/purchase-orders/${po.id}`, { version: po.version, note: 'stale' })).body.code).toBe('VERSION_CONFLICT');
      const bad = (body: object) => buyer.post('/purchase-orders', poBody(body));
      expect((await bad({ items: [] })).status).toBe(400);
      expect((await bad({ items: [{ productId: para.id, quantity: '1', unitPrice: '-1' }] })).status).toBe(400);
      expect((await bad({ items: [{ productId: '00000000-0000-4000-8000-000000000000', quantity: '1', unitPrice: '1' }] })).body.code).toBe('PRODUCT_NOT_FOUND');
      expect((await bad({ items: [{ productId: para.id, unitId: U.vial, quantity: '1', unitPrice: '1' }] })).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await bad({ expectedDate: day(-5) })).body.code).toBe('INVALID_DATES');
      await admin.patch(`/suppliers/${s2.id}`, { version: s2.version, status: 'blocked' });
      expect((await bad({ supplierId: s2.id })).body.code).toBe('SUPPLIER_NOT_ACTIVE');
      const noPack = (await admin.post('/products', { name: 'Not for purchase', baseUnitId: U.tablet, units: [{ unitId: U.strip, factorToBase: '10', isPurchasable: false }] })).body;
      expect((await bad({ items: [{ productId: noPack.id, unitId: U.strip, quantity: '1', unitPrice: '1' }] })).body.code).toBe('UNIT_NOT_PURCHASABLE');
      const cashier = await userWith('cash', 'Cashier');
      expect((await cashier.post('/purchase-orders', poBody())).status).toBe(403);
    });

    it('stops an order that would take the supplier past its credit limit, unless that check is switched off', async () => {
      await admin.patch(`/suppliers/${s1.id}`, { version: s1.version, creditLimit: '1000' });
      await approvedPo(); // 920 committed
      const second = await mkPo();
      const blocked = await buyer.post(`/purchase-orders/${second.id}/submit`, {});
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', details: { creditLimit: '1000.0000', outstanding: '920.0000', orderTotal: '920.0000' } });
      await admin.put('/settings/procurement.enforce_credit_limit', { value: false });
      expect((await buyer.post(`/purchase-orders/${second.id}/submit`, {})).status).toBe(200);
    });

    it('is approved immediately when approval is switched off, but only by someone who may approve', async () => {
      await admin.put('/settings/procurement.po_approval_required', { value: false });
      const po = await mkPo();
      expect((await buyer.post(`/purchase-orders/${po.id}/submit`, {})).status).toBe(403);
      expect((await mgr.post(`/purchase-orders/${po.id}/submit`, {})).body.status).toBe('approved');
    });

    it('needs approval to change an approved order, and keeps what has already been delivered', async () => {
      const po = await approvedPo();
      const rev = await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Supplier raised the price', items: [{ productId: para.id, unitId: U.box, quantity: '3', unitPrice: '420' }] });
      expect(rev.status).toBe(200);
      expect(rev.body.pending_revision).toMatchObject({ revision_no: 2, reason: 'Supplier raised the price' });
      expect(rev.body.total).toBe('920.0000'); // unchanged until approved
      expect((await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'again please', items: [{ productId: para.id, unitId: U.box, quantity: '4', unitPrice: '420' }] })).body.code).toBe('REVISION_PENDING');
      const approvalId = rev.body.pending_revision.approval_id;
      expect((await buyer.post(`/approvals/${approvalId}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/approvals/${approvalId}/approve`, {})).status).toBe(200);
      const after = (await mgr.get(`/purchase-orders/${po.id}`)).body;
      expect(after).toMatchObject({ revision: 2, subtotal: '1260.0000', tax_total: '189.0000', total: '1449.0000', pending_revision: null });
      expect(after.items[0]).toMatchObject({ quantity: '3.0000', base_quantity: '300.0000', unit_price: '420.0000' });

      await receive(after, '2'); // 200 tablets arrive
      const below = await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Cut it back', items: [{ productId: para.id, unitId: U.box, quantity: '1', unitPrice: '420' }] });
      expect(below.body.code).toBe('BELOW_RECEIVED');
      expect((await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Drop the line', items: [{ productId: amox.id, quantity: '5', unitPrice: '2' }] })).body.code).toBe('LINE_ALREADY_RECEIVED');
      const add = await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Add amoxicillin', items: [{ productId: para.id, unitId: U.box, quantity: '3', unitPrice: '420' }, { productId: amox.id, quantity: '5', unitPrice: '2' }] });
      await mgr.post(`/approvals/${add.body.pending_revision.approval_id}/approve`, {});
      expect((await mgr.get(`/purchase-orders/${po.id}`)).body.items).toHaveLength(2);
    });

    it('keeps the original when a change is rejected', async () => {
      const po = await approvedPo();
      const rev = await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Try a different price', items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '300' }] });
      expect((await mgr.post(`/approvals/${rev.body.pending_revision.approval_id}/reject`, { comment: 'Not now' })).body.status).toBe('rejected');
      const after = (await mgr.get(`/purchase-orders/${po.id}`)).body;
      expect(after).toMatchObject({ total: '920.0000', revision: 1, pending_revision: null });
      expect((await buyer.post(`/purchase-orders/${po.id}/revise`, { reason: 'Second try', items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '300' }] })).status).toBe(200); // a new change can follow
    });

    it('can be cancelled before anything arrives, or closed once partly delivered', async () => {
      const draft = await mkPo();
      expect((await buyer.post(`/purchase-orders/${draft.id}/cancel`, { reason: 'Ordered by mistake' })).body.status).toBe('cancelled');
      const approved = await approvedPo();
      expect((await buyer.post(`/purchase-orders/${approved.id}/close`, { reason: 'nothing delivered' })).body.code).toBe('ORDER_NOT_CLOSABLE');
      expect((await buyer.post(`/purchase-orders/${approved.id}/cancel`, { reason: 'Supplier cannot deliver' })).body.status).toBe('cancelled');
      expect((await receive(approved, '1')).body.code).toBe('ORDER_NOT_RECEIVABLE');

      const partial = await approvedPo();
      await receive(partial, '1');
      expect((await buyer.post(`/purchase-orders/${partial.id}/cancel`, { reason: 'too late' })).body.code).toBe('ORDER_NOT_CANCELLABLE');
      expect((await buyer.post(`/purchase-orders/${partial.id}/close`, { reason: 'Supplier will not send the rest' })).body.status).toBe('closed');
      expect((await receive(partial, '1')).body.code).toBe('ORDER_NOT_RECEIVABLE');
      expect((await buyer.post(`/purchase-orders/${draft.id}/cancel`, { reason: 'x' })).status).toBe(400);
    });

    it('lists outstanding and overdue orders', async () => {
      const late = await approvedPo({ expectedDate: day(2) });
      await ctx.db.query(`update procurement.purchase_orders set expected_date = current_date - 5 where id = $1`, [late.id]);
      await approvedPo({ expectedDate: day(20) });
      await mkPo(); // draft, not outstanding
      expect((await buyer.get('/purchase-orders')).body.total).toBe(3);
      expect((await buyer.get('/purchase-orders?outstanding=true')).body.total).toBe(2);
      expect((await buyer.get('/purchase-orders?overdue=true')).body.items.map((o: any) => o.id)).toEqual([late.id]);
      expect((await buyer.get(`/purchase-orders?supplierId=${s2.id}`)).body.total).toBe(0);
    });
  });

  describe('receiving and inspection', () => {
    it('puts delivered goods into quarantine with the true cost per tablet, and nothing is sellable yet', async () => {
      const po = await approvedPo();
      const r = await receive(po, '2');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ status: 'pending_inspection', reference_no: 'GRN-000001', order_reference: po.reference_no, received_by_name: 'keeper' });
      expect(r.body.items[0]).toMatchObject({ received_base: '200.0000', unit_cost: '4.0000', batch_ref: 'LOT1' }); // 800 net / 200 tablets
      expect(await stock('quarantined')).toEqual({ 'Paracetamol:LOT1': 200 });
      expect(await stock('available')).toEqual({});
      const batch = (await ctx.db.query(`select supplier_id, goods_receipt_item_id, unit_cost from inventory.stock_batches`)).rows[0];
      expect(batch).toMatchObject({ supplier_id: s1.id, goods_receipt_item_id: r.body.items[0].id, unit_cost: '4.0000' });
      expect((await mgr.get(`/purchase-orders/${po.id}`)).body.status).toBe('received');
      expect((await admin.get(`/inventory/fefo-preview?productId=${para.id}&branchId=${A.id}&quantity=1`)).body.code).toBe('INSUFFICIENT_STOCK');
      expect(await reconcile()).toEqual([]);
    });

    it('accepts partial deliveries, and refuses more than was ordered (within a configurable tolerance)', async () => {
      const po = await approvedPo();
      expect((await receive(po, '1')).status).toBe(201);
      expect((await mgr.get(`/purchase-orders/${po.id}`)).body.status).toBe('partially_received');
      const over = await receive(po, '2', { batchRef: 'LOT2' }); // 1 already in, so 2 more is 1 over
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'OVER_RECEIPT', details: { ordered: '200.0000', alreadyReceived: '100.0000', attempted: '200.0000' } });
      await admin.put('/settings/procurement.over_receipt_tolerance_percent', { value: '60' });
      expect((await receive(po, '1.5', { batchRef: 'LOT2' })).status).toBe(201); // 250 of 200, within 160
      expect((await mgr.get(`/purchase-orders/${po.id}`)).body.items[0].received_base).toBe('250.0000');
      expect(await stock('quarantined')).toEqual({ 'Paracetamol:LOT1': 100, 'Paracetamol:LOT2': 150 });
    });

    it('refuses expired goods, foreign lines, and people without rights', async () => {
      const po = await approvedPo();
      expect((await receive(po, '1', { expiryDate: day(-2) })).body.code).toBe('EXPIRY_IN_PAST');
      const other = await approvedPo();
      expect((await keeper.post('/goods-receipts', { purchaseOrderId: po.id, items: [{ orderItemId: other.items[0].id, quantity: '1', batchRef: 'X', expiryDate: day(200) }] })).body.code).toBe('ITEM_NOT_IN_ORDER');
      expect((await receive(await mkPo(), '1')).body.code).toBe('ORDER_NOT_RECEIVABLE'); // still a draft
      const cashier = await userWith('cash', 'Cashier');
      expect((await receive(po, '1', {}, cashier)).status).toBe(403);
      const keeperB = await userWith('keeper.b', 'Storekeeper', B.id);
      expect((await receive(po, '1', {}, keeperB)).status).toBe(404);
      expect((await receive(po, '0')).body.code).toBe('INVALID_QUANTITY');
      expect((await ctx.db.query(`select count(*)::int as n from procurement.goods_receipts`)).rows[0].n).toBe(0);
    });

    it('releases accepted goods to saleable stock and sends rejected goods to damaged', async () => {
      const po = await approvedPo({ expectedDate: day(10) });
      const rc = (await receive(po, '2')).body;
      const item = rc.items[0];
      expect((await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: item.id, acceptedQuantity: '1.5' }] })).body.code).toBe('REJECTION_REASON_REQUIRED'); // 0.5 of a box rejected
      expect((await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: item.id, acceptedQuantity: '3', rejectionReason: 'x' }] })).body.code).toBe('INVALID_ACCEPTED_QUANTITY');
      const done = await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: item.id, acceptedQuantity: '1.5', rejectionReason: 'Blisters crushed in 5 strips' }] });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'completed', inspected_by_name: 'keeper' });
      expect(done.body.items[0]).toMatchObject({ accepted_base: '150.0000', rejected_base: '50.0000', rejection_reason: 'Blisters crushed in 5 strips' });
      expect(await stock('available')).toEqual({ 'Paracetamol:LOT1': 150 });
      expect(await stock('damaged')).toEqual({ 'Paracetamol:LOT1': 50 });
      expect(await stock('quarantined')).toEqual({});
      const oi = (await mgr.get(`/purchase-orders/${po.id}`)).body.items[0];
      expect(oi).toMatchObject({ accepted_base: '150.0000', rejected_base: '50.0000' });
      expect((await admin.get(`/suppliers/${s1.id}/products`)).body[0]).toMatchObject({ sku: para.sku, last_price: '4.0000' });
      expect((await keeper.post(`/goods-receipts/${rc.id}/inspect`, {})).body.code).toBe('ALREADY_INSPECTED');
      expect((await admin.get(`/inventory/fefo-preview?productId=${para.id}&branchId=${A.id}&quantity=150`)).status).toBe(200);
      expect(await reconcile()).toEqual([]);
    });

    it('can require inspection by someone other than the receiver', async () => {
      await admin.put('/settings/procurement.separate_inspector', { value: true });
      const rc = (await receive(await approvedPo(), '2')).body;
      const same = await keeper.post(`/goods-receipts/${rc.id}/inspect`, {});
      expect(same.status).toBe(403);
      expect(same.body.code).toBe('INSPECTOR_MUST_DIFFER');
      expect((await buyer.post(`/goods-receipts/${rc.id}/inspect`, {})).status).toBe(200);
    });
  });

  describe('supplier invoices, payments and credits', () => {
    it('matches an invoice against the goods accepted, and asks for approval when it asks for too much', async () => {
      const { po } = await delivered();
      const m = (await acct.get(`/purchase-orders/${po.id}/matching`)).body;
      expect(m).toMatchObject({ ordered: '920.0000', receivedValue: '920.0000', acceptedValue: '920.0000', invoiced: '0.0000', toInvoice: '920.0000' });
      const ok = await acct.post('/supplier-invoices', invoiceBody(po, { invoiceNo: 'INV-OK', subtotal: '800', taxTotal: '130', total: '930' })); // 10 over, within the 2% tolerance (18.40)
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ status: 'open', reference_no: 'SINV-000001', balance: '930.0000', variance: '10.0000' });
      expect(String(ok.body.due_date).slice(0, 10)).toBe(day(30)); // invoice date plus the 30 day terms
      expect(ok.body.warnings).toEqual([]);

      const { po: po2 } = await delivered();
      const high = await acct.post('/supplier-invoices', invoiceBody(po2, { invoiceNo: 'INV-HIGH', subtotal: '800', taxTotal: '140', total: '940' }));
      expect(high.body).toMatchObject({ status: 'pending_approval' });
      expect(high.body.warnings[0]).toMatchObject({ code: 'INVOICE_EXCEEDS_ACCEPTED_GOODS', variance: '20.0000' });
      expect((await acct.post(`/approvals/${high.body.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/payments-not-yet`, {})).status).toBe(404);
      expect((await mgr.post(`/approvals/${high.body.approval_id}/approve`, {})).status).toBe(200);
      expect((await acct.get(`/supplier-invoices/${high.body.id}`)).body.status).toBe('open');

      const { po: po3 } = await delivered();
      const rej = await acct.post('/supplier-invoices', invoiceBody(po3, { invoiceNo: 'INV-REJ', subtotal: '1000', taxTotal: '150', total: '1150' }));
      await mgr.post(`/approvals/${rej.body.approval_id}/reject`, { comment: 'Price not agreed' });
      expect((await acct.get(`/supplier-invoices/${rej.body.id}`)).body.status).toBe('rejected');
      expect((await acct.get(`/purchase-orders/${po3.id}/matching`)).body.invoiced).toBe('0.0000'); // rejected invoices do not count
    });

    it('values only what was accepted when goods were rejected', async () => {
      const po = await approvedPo();
      const rc = (await receive(po, '2')).body;
      await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: rc.items[0].id, acceptedQuantity: '1', rejectionReason: 'One box wet' }] });
      expect((await acct.get(`/purchase-orders/${po.id}/matching`)).body.acceptedValue).toBe('460.0000'); // half of 920
      const full = await acct.post('/supplier-invoices', invoiceBody(po));
      expect(full.body.status).toBe('pending_approval'); // the supplier invoiced the rejected box too
      expect(full.body.variance).toBe('460.0000');
    });

    it('validates invoices', async () => {
      const { po } = await delivered();
      const bad = (extra: object) => acct.post('/supplier-invoices', invoiceBody(po, extra));
      expect((await bad({ total: '921' })).body.code).toBe('TOTAL_MISMATCH');
      expect((await bad({ invoiceDate: day(5) })).body.code).toBe('INVOICE_DATE_IN_FUTURE');
      expect((await bad({ dueDate: day(-10) })).body.code).toBe('INVALID_DUE_DATE');
      expect((await bad({ subtotal: '0', taxTotal: '0', total: '0' })).body.code).toBe('INVALID_TOTAL');
      expect((await bad({})).status).toBe(201);
      expect((await bad({})).body.code).toBe('INVOICE_EXISTS');
      expect((await acct.post('/supplier-invoices', invoiceBody(await mkPo(), { invoiceNo: 'INV-DRAFT' }))).body.code).toBe('ORDER_NOT_INVOICEABLE');
      expect((await keeper.post('/supplier-invoices', invoiceBody(po, { invoiceNo: 'INV-K' }))).status).toBe(403);
    });

    it('records partial payments, rejects overpayment, and keeps every balance consistent', async () => {
      const { po } = await delivered();
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po))).body;
      const pay = (amount: string, extra: object = {}) => acct.post('/supplier-payments', { supplierId: s1.id, method: 'bank_transfer', externalRef: 'TT-77', allocations: [{ invoiceId: inv.id, amount }], ...extra });
      const first = await pay('500');
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ reference_no: 'SPAY-000001', amount: '500.0000', status: 'posted' });
      expect((await acct.get(`/supplier-invoices/${inv.id}`)).body).toMatchObject({ status: 'partially_paid', paid_total: '500.0000', balance: '420.0000' });
      const over = await pay('1000');
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'OVERPAYMENT', details: { balance: '420.0000' } });
      expect((await pay('420')).status).toBe(201);
      expect((await acct.get(`/supplier-invoices/${inv.id}`)).body).toMatchObject({ status: 'paid', balance: '0.0000' });
      expect((await pay('1')).body.code).toBe('INVOICE_NOT_PAYABLE');
      expect((await pay('10', { paymentDate: day(3) })).body.code).toBe('PAYMENT_DATE_IN_FUTURE');
      expect((await acct.post(`/supplier-invoices/${inv.id}/cancel`, {})).body.code).toBe('INVOICE_NOT_CANCELLABLE');
      expect((await ctx.db.query(`select count(*)::int as n from procurement.supplier_payments`)).rows[0].n).toBe(2);
    });

    it('records nothing at all if one invoice in a payment is invalid', async () => {
      const a = (await acct.post('/supplier-invoices', invoiceBody((await delivered()).po, { invoiceNo: 'A' }))).body;
      const other = (await delivered({ supplierId: s2.id })).po;
      const b = (await acct.post('/supplier-invoices', invoiceBody(other, { invoiceNo: 'B' }))).body;
      const mixed = await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: a.id, amount: '100' }, { invoiceId: b.id, amount: '100' }] });
      expect(mixed.body.code).toBe('INVOICE_SUPPLIER_MISMATCH');
      const tooMuch = await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: a.id, amount: '100' }, { invoiceId: a.id, amount: '5' }] });
      expect(tooMuch.body.code).toBe('DUPLICATE_INVOICE');
      expect((await acct.get(`/supplier-invoices/${a.id}`)).body.paid_total).toBe('0.0000');
      expect((await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', paymentDate: day(4), allocations: [{ invoiceId: a.id, amount: '10' }] })).body.code).toBe('PAYMENT_DATE_IN_FUTURE');
      expect((await acct.post('/supplier-payments', { supplierId: s1.id, method: 'barter', allocations: [{ invoiceId: a.id, amount: '10' }] })).status).toBe(400);
      expect((await buyer.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: a.id, amount: '10' }] })).status).toBe(403);
      expect((await ctx.db.query(`select count(*)::int as n from procurement.supplier_payments`)).rows[0].n).toBe(0);
    });

    it('lets only one of two simultaneous payments take the same money', async () => {
      const { po } = await delivered();
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po))).body;
      const attempt = () => acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '600' }] });
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const row = (await ctx.db.query(`select paid_total, total from procurement.supplier_invoices where id = $1`, [inv.id])).rows[0];
      expect(Number(row.paid_total)).toBe(600);
    });

    it('reverses a payment without deleting it, restoring the balance', async () => {
      const { po } = await delivered();
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po))).body;
      const p = (await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cheque', allocations: [{ invoiceId: inv.id, amount: '920' }] })).body;
      expect((await acct.get(`/supplier-invoices/${inv.id}`)).body.status).toBe('paid');
      expect((await buyer.post(`/supplier-payments/${p.id}/reverse`, { reason: 'Cheque bounced' })).status).toBe(403);
      const rev = await acct.post(`/supplier-payments/${p.id}/reverse`, { reason: 'Cheque bounced' });
      expect(rev.body).toMatchObject({ status: 'reversed', reversal_reason: 'Cheque bounced', reversed_by_name: 'acct' });
      expect((await acct.get(`/supplier-invoices/${inv.id}`)).body).toMatchObject({ status: 'open', paid_total: '0.0000', balance: '920.0000' });
      expect((await acct.post(`/supplier-payments/${p.id}/reverse`, { reason: 'again' })).body.code).toBe('PAYMENT_ALREADY_REVERSED');
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'supplier_payment.reversed'`)).rowCount).toBe(1);
      expect((await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '920' }] })).status).toBe(201); // payable again
    });

    it('returns goods to the supplier for a credit that can be applied to an invoice', async () => {
      const po = await approvedPo();
      const rc = (await receive(po, '2')).body;
      await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: rc.items[0].id, acceptedQuantity: '1.8', rejectionReason: '20 tablets crushed' }] });
      const batch = (await admin.get(`/inventory/batches?productId=${para.id}`)).body[0];
      const body = (extra: object = {}) => ({ supplierId: s1.id, warehouseId: whA.id, receiptId: rc.id, reason: 'Crushed on arrival', items: [{ batchId: batch.id, status: 'damaged', quantity: '20' }], ...extra });
      expect((await buyer.post('/purchase-returns', body({ items: [{ batchId: batch.id, status: 'damaged', quantity: '30' }] }))).body.code).toBe('INSUFFICIENT_STOCK');
      expect((await buyer.post('/purchase-returns', body({ supplierId: s2.id, receiptId: undefined }))).body.code).toBe('BATCH_SUPPLIER_MISMATCH');
      expect((await buyer.post('/purchase-returns', body({ supplierId: s2.id }))).body.code).toBe('RECEIPT_NOT_FOUND'); // that delivery was not from this supplier
      expect((await buyer.post('/purchase-returns', body({ items: [{ batchId: batch.id, status: 'quarantined', quantity: '5' }] }))).body.code).toBe('INSUFFICIENT_STOCK');
      const ret = (await buyer.post('/purchase-returns', body())).body;
      expect(ret).toMatchObject({ status: 'pending_approval', reference_no: 'PRT-000001', credit_amount: '80.0000' }); // 20 tablets at 4.00
      expect(await stock('damaged')).toEqual({ 'Paracetamol:LOT1': 20 });
      expect((await buyer.post(`/approvals/${ret.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/approvals/${ret.approval_id}/approve`, {})).status).toBe(200);
      expect(await stock('damaged')).toEqual({});
      expect((await buyer.get(`/purchase-returns/${ret.id}`)).body.status).toBe('posted');
      expect((await admin.get('/inventory/movements?movementType=purchase_return')).body.items[0]).toMatchObject({ quantity_delta: '-20.0000', reference_no: 'PRT-000001' });

      const credit = (await acct.get(`/supplier-credits?supplierId=${s1.id}`)).body[0];
      expect(credit).toMatchObject({ amount: '80.0000', remaining: '80.0000', return_reference: 'PRT-000001' });
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po, { subtotal: '400', taxTotal: '60', total: '460', invoiceNo: 'INV-C' }))).body;
      expect((await acct.post(`/supplier-credits/${credit.id}/apply`, { invoiceId: inv.id, amount: '100' })).body.code).toBe('CREDIT_EXCEEDED');
      const applied = await acct.post(`/supplier-credits/${credit.id}/apply`, { invoiceId: inv.id, amount: '80' });
      expect(applied.body).toMatchObject({ credited_total: '80.0000', balance: '380.0000', status: 'partially_paid' }); // settled in part by the credit
      expect((await acct.get(`/supplier-credits?supplierId=${s1.id}`)).body[0].remaining).toBe('0.0000');
      expect(await reconcile()).toEqual([]);
    });

    it('rejects or withdraws a return without touching stock', async () => {
      const rc = (await receive(await approvedPo(), '2')).body;
      await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: rc.items[0].id, acceptedQuantity: '1.9', rejectionReason: '10 tablets damp' }] });
      const batch = (await admin.get(`/inventory/batches?productId=${para.id}`)).body[0];
      const mk = async () => (await buyer.post('/purchase-returns', { supplierId: s1.id, warehouseId: whA.id, reason: 'Damp tablets', items: [{ batchId: batch.id, status: 'damaged', quantity: '10' }] })).body;
      const a = await mk(), b = await mk();
      expect((await mgr.post(`/approvals/${a.approval_id}/reject`, { comment: 'Keep for disposal' })).body.status).toBe('rejected');
      expect((await buyer.post(`/purchase-returns/${b.id}/cancel`, {})).body.status).toBe('cancelled');
      expect(await stock('damaged')).toEqual({ 'Paracetamol:LOT1': 10 });
      expect((await acct.get('/supplier-credits')).body).toHaveLength(0);
    });

    it('produces statements, balances and an aging report that agree with each other', async () => {
      const { po } = await delivered();
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po))).body;
      await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '500' }] });
      await ctx.db.query(`update procurement.supplier_invoices set due_date = current_date - 45 where id = $1`, [inv.id]);
      const bal = (await acct.get(`/suppliers/${s1.id}/balance`)).body;
      expect(bal).toMatchObject({ payable: '420.0000', pendingApproval: '0.0000', unappliedCredits: '0.0000', net: '420.0000' });
      const st = (await acct.get(`/suppliers/${s1.id}/statement`)).body;
      expect(st.lines.map((l: any) => [l.kind, l.debit, l.credit, l.balance])).toEqual([['invoice', '920.0000', '0.0000', '920.0000'], ['payment', '0.0000', '500.0000', '420.0000']]);
      expect(st.closingBalance).toBe('420.0000');
      expect((await acct.get(`/suppliers/${s1.id}/statement?from=${day(1)}`)).body).toMatchObject({ openingBalance: '420.0000', lines: [] });
      const aging = (await acct.get('/procurement/payables-aging')).body;
      expect(aging.suppliers).toHaveLength(1);
      expect(aging.suppliers[0]).toMatchObject({ supplier_name: 'EPSA Depot', d31_60: '420.0000', current: '0.0000', total: '420.0000' });
      expect(aging.totals.total).toBe('420.0000');
      expect((await acct.get('/supplier-invoices?overdue=true')).body.total).toBe(1);
      expect((await acct.get(`/supplier-payments?supplierId=${s1.id}`)).body.total).toBe(1);
      expect((await acct.get(`/suppliers/${s2.id}/statement`)).body.lines).toEqual([]);
    });
  });

  describe('supplier analysis', () => {
    it('compares what suppliers charge per tablet and finds the cheapest', async () => {
      await delivered(); // EPSA: 400 a box of 100 tablets
      const po2 = await approvedPo({ supplierId: s2.id, items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '350' }] });
      await keeper.post(`/goods-receipts/${(await receive(po2, '2')).body.id}/inspect`, {});
      const cmp = (await buyer.get(`/procurement/price-comparison?productId=${para.id}`)).body;
      expect(cmp.offers.map((o: any) => [o.supplier_name, o.comparable_cost])).toEqual([['Kilinto Pharma', '3.5000'], ['EPSA Depot', '4.0000']]);
      expect(cmp.cheapestSupplierId).toBe(s2.id);
      expect((await buyer.get(`/procurement/price-comparison?productId=${amox.id}`)).body.offers).toEqual([]);
    });

    it('measures a supplier\'s delivery, fill rate and rejections', async () => {
      const po = await approvedPo({ expectedDate: day(10) });
      const rc = (await receive(po, '2')).body;
      await keeper.post(`/goods-receipts/${rc.id}/inspect`, { items: [{ itemId: rc.items[0].id, acceptedQuantity: '1.6', rejectionReason: '40 tablets wet' }] });
      const late = await approvedPo({ expectedDate: day(3) });
      await ctx.db.query(`update procurement.purchase_orders set expected_date = current_date - 3 where id = $1`, [late.id]);
      await receive(late, '2');
      const perf = (await buyer.get(`/suppliers/${s1.id}/performance`)).body;
      expect(perf).toMatchObject({ supplierName: 'EPSA Depot', orders: 2, deliveriesMeasured: 2, onTimeDeliveryPercent: '50.00' });
      expect(perf.quantities).toMatchObject({ ordered: '400.0000', received: '400.0000', accepted: '160.0000', rejected: '40.0000' });
      expect(perf.rejectionRatePercent).toBe('10.00'); // 40 of 400
      expect((await buyer.get(`/suppliers/${s2.id}/performance`)).body).toMatchObject({ orders: 0, fillRatePercent: null, onTimeDeliveryPercent: null });
      expect((await buyer.get('/suppliers/00000000-0000-4000-8000-000000000000/performance')).status).toBe(404);
    });
  });

  describe('audit trail', () => {
    it('records the important steps with who did them', async () => {
      const { po, rc } = await delivered();
      const inv = (await acct.post('/supplier-invoices', invoiceBody(po))).body;
      await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: inv.id, amount: '920' }] });
      const actions = (await admin.get('/audit-logs?pageSize=100')).body.items.map((e: any) => e.action);
      for (const a of ['purchase_order.created', 'purchase_order.submitted', 'purchase_order.approved', 'goods.received', 'goods.inspected', 'supplier_invoice.recorded', 'supplier_payment.recorded', 'approval.approved']) expect(actions).toContain(a);
      const received = (await admin.get(`/audit-logs?entityType=goods_receipt&entityId=${rc.id}`)).body.items;
      expect(received.map((e: any) => e.username)).toEqual(expect.arrayContaining(['keeper']));
    });
  });
});
