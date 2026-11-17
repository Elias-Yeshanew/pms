import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Finance: purchases, supplier payments and stock write-offs in the books', () => {
  let ctx: TestCtx;
  let admin: Client, buyer: Client, mgr: Client, keeper: Client, acct: Client;
  let U: Record<string, string>;
  let A: any, whA: any, s1: any, para: any;

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
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W', name: 'Main store' })).body;
    s1 = (await admin.post('/suppliers', { name: 'EPSA Depot', paymentTermsDays: 30 })).body;
    const vat = (await admin.post('/tax-categories', { name: 'VAT standard' })).body;
    await admin.post('/tax-rules', { taxCategoryId: vat.id, taxCode: 'VAT', name: 'VAT', rate: '15', isInclusive: false, effectiveFrom: '2020-01-01' });
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, taxCategoryId: vat.id, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }] })).body;
    buyer = await userWith('buyer', 'Supply Chain Manager');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    keeper = await userWith('keeper', 'Storekeeper');
    acct = await userWith('acct', 'Accountant');
  });

  const bal = async (code: string) => ((await admin.get('/finance/reports/trial-balance')).body.lines.find((l: any) => l.code === code)?.closing ?? '0.0000');
  const reconcile = async () => (await admin.get('/finance/reconcile')).body;

  async function delivered() {
    const po = (await buyer.post('/purchase-orders', { supplierId: s1.id, warehouseId: whA.id, items: [{ productId: para.id, unitId: U.box, quantity: '2', unitPrice: '400' }] })).body;
    const sub = await buyer.post(`/purchase-orders/${po.id}/submit`, {});
    await mgr.post(`/approvals/${sub.body.approval_id}/approve`, {});
    const approved = (await mgr.get(`/purchase-orders/${po.id}`)).body;
    const rc = (await keeper.post('/goods-receipts', { purchaseOrderId: po.id, deliveryNoteNo: 'DN-1', items: [{ orderItemId: approved.items[0].id, quantity: '2', batchRef: 'LOT1', expiryDate: day(300) }] })).body;
    await keeper.post(`/goods-receipts/${rc.id}/inspect`, {});
    return approved;
  }

  it('books received goods against "goods received not invoiced", then the supplier invoice against what we owe', async () => {
    const po = await delivered();
    expect(await bal('1200')).toBe('800.0000');
    expect(await bal('2020')).toBe('800.0000');
    expect(await bal('2010')).toBe('0.0000');
    const inv = await acct.post('/supplier-invoices', { purchaseOrderId: po.id, invoiceNo: 'INV-1', invoiceDate: day(0), subtotal: '800', taxTotal: '120', total: '920' });
    expect(inv.status).toBe(201);
    expect(await bal('2020')).toBe('0.0000');
    expect(await bal('1300')).toBe('120.0000');
    expect(await bal('2010')).toBe('920.0000');
    expect((await reconcile()).ok).toBe(true);
    // pay part, reverse, pay again
    const pay = await acct.post('/supplier-payments', { supplierId: s1.id, method: 'bank_transfer', externalRef: 'TT-1', allocations: [{ invoiceId: inv.body.id, amount: '400' }] });
    expect(pay.status).toBe(201);
    expect(await bal('2010')).toBe('520.0000');
    expect(await bal('1020')).toBe('-400.0000');
    expect((await reconcile()).ok).toBe(true);
    expect((await mgr.post(`/supplier-payments/${pay.body.id}/reverse`, { reason: 'Bounced' })).status).toBe(200);
    expect(await bal('2010')).toBe('920.0000');
    expect(await bal('1020')).toBe('0.0000');
    expect((await acct.post('/supplier-payments', { supplierId: s1.id, method: 'cash', allocations: [{ invoiceId: inv.body.id, amount: '100' }] })).status).toBe(201);
    expect(await bal('1010')).toBe('-100.0000');
    expect((await reconcile()).ok).toBe(true);
    const tax = (await admin.get('/finance/reports/tax-summary')).body;
    expect(tax).toMatchObject({ paidOnPurchases: '120.0000', collectedOnSales: '0.0000', netPayable: '-120.0000' });
  });

  it('keeps payables right when an invoice is cancelled, and applies credits for returned goods', async () => {
    const po = await delivered();
    const inv = (await acct.post('/supplier-invoices', { purchaseOrderId: po.id, invoiceNo: 'INV-1', invoiceDate: day(0), subtotal: '800', taxTotal: '120', total: '920' })).body;
    expect((await acct.post(`/supplier-invoices/${inv.id}/cancel`, {})).status).toBe(200);
    expect(await bal('2010')).toBe('0.0000');
    expect(await bal('2020')).toBe('800.0000');
    const inv2 = (await acct.post('/supplier-invoices', { purchaseOrderId: po.id, invoiceNo: 'INV-2', invoiceDate: day(0), subtotal: '800', taxTotal: '120', total: '920' })).body;
    expect(await bal('2010')).toBe('920.0000');
    const batch = (await admin.get(`/inventory/stock?warehouseId=${whA.id}&status=available`)).body.items[0];
    expect((await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: batch.batch_id, quantity: '10', from: 'available', to: 'damaged', reason: 'Crushed in delivery' })).status).toBe(201);
    expect(await bal('1200')).toBe('800.0000'); // damaged stock is still owned, so it stays in inventory until it leaves
    // 10 tablets at 4.00 go back to the supplier, who owes a credit
    const ret = await buyer.post('/purchase-returns', { supplierId: s1.id, warehouseId: whA.id, reason: 'Damaged on arrival', items: [{ batchId: batch.batch_id, status: 'damaged', quantity: '10' }] });
    expect(ret.status).toBe(201);
    expect((await mgr.post(`/approvals/${ret.body.approval_id}/approve`, {})).status).toBe(200);
    expect(await bal('1200')).toBe('760.0000');
    expect(await bal('1400')).toBe('40.0000');
    const credits = (await acct.get('/supplier-credits')).body;
    const c = (Array.isArray(credits) ? credits : credits.items)[0];
    expect(c.amount).toBe('40.0000');
    expect((await acct.post(`/supplier-credits/${c.id}/apply`, { invoiceId: inv2.id, amount: '40' })).status).toBe(200);
    expect(await bal('1400')).toBe('0.0000');
    expect(await bal('2010')).toBe('880.0000');
    expect((await reconcile()).ok).toBe(true);
  });

  it('writes off destroyed stock as a loss at its cost, and books stock found or lost on counts and adjustments', async () => {
    await delivered();
    const batch = (await admin.get(`/inventory/stock?warehouseId=${whA.id}&status=available`)).body.items[0];
    await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: batch.batch_id, quantity: '20', from: 'available', to: 'damaged', reason: 'Flood damage' });
    expect(await bal('5110')).toBe('0.0000');
    const d = await keeper.post('/inventory/disposals', { warehouseId: whA.id, reason: 'damaged', note: 'Flood', items: [{ batchId: batch.batch_id, status: 'damaged', quantity: '20' }] });
    expect(d.status).toBe(201);
    expect((await mgr.post(`/approvals/${d.body.approval_id}/approve`, {})).status).toBe(200);
    expect(await bal('5110')).toBe('80.0000'); // 20 x 4.00
    expect(await bal('1200')).toBe('720.0000');
    const adj = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'loss', reason: 'Shelf loss found on spot check', items: [{ productId: para.id, batchId: batch.batch_id, quantity: '5', direction: 'decrease' }] });
    expect(adj.status).toBe(201);
    expect((await mgr.post(`/approvals/${adj.body.approval_id}/approve`, {})).status).toBe(200);
    expect(await bal('5100')).toBe('20.0000');
    expect(await bal('1200')).toBe('700.0000');
    const is = (await admin.get('/finance/reports/income-statement')).body;
    expect(is.totalStockLosses).toBe('100.0000');
    expect(is.netOperatingProfit).toBe('-100.0000');
    expect((await reconcile()).ok).toBe(true);
  });
});
