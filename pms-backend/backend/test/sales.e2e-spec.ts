import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Sales, customers and prescriptions', () => {
  let ctx: TestCtx, uploadDir: string;
  let admin: Client, adminToken: string, mgr: Client, keeper: Client, cashier: Client, dispenser: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, whB: any, R1: any, RB: any, para: any, amox: any, vit: any, incl: any;

  beforeAll(async () => { uploadDir = mkdtempSync(join(tmpdir(), 'pms-rx-')); ctx = await createTestApp({ UPLOAD_DIR: uploadDir }); });
  afterAll(async () => { await ctx.close(); rmSync(uploadDir, { recursive: true, force: true }); });

  async function userWith(username: string, role: string, branchId?: string): Promise<Client> {
    expect((await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] })).status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  beforeEach(async () => {
    await ctx.reset();
    rmSync(join(uploadDir, 'prescriptions'), { recursive: true, force: true });
    await makeAdmin(ctx);
    adminToken = await tokenFor(ctx, ADMIN.username, ADMIN.password);
    admin = authed(ctx, adminToken);
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
    A = (await admin.post('/branches', { code: 'MAIN', name: 'Main Dispenser', address: 'Bole Road', phone: '0111' })).body;
    B = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa Dispenser' })).body;
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W', name: 'Main store' })).body;
    whB = (await admin.post('/warehouses', { branchId: B.id, code: 'W', name: 'Piassa store' })).body;
    R1 = (await admin.post('/cash-registers', { branchId: A.id, code: 'R1', name: 'Counter 1' })).body;
    RB = (await admin.post('/cash-registers', { branchId: B.id, code: 'R1', name: 'Counter 1' })).body;
    const vat = (await admin.post('/tax-categories', { name: 'VAT' })).body;
    await admin.post('/tax-rules', { taxCategoryId: vat.id, taxCode: 'VAT', name: 'VAT', rate: '15', isInclusive: false, effectiveFrom: '2020-01-01' });
    const vatIn = (await admin.post('/tax-categories', { name: 'VAT inclusive' })).body;
    await admin.post('/tax-rules', { taxCategoryId: vatIn.id, taxCode: 'VATI', name: 'VAT incl', rate: '15', isInclusive: true, effectiveFrom: '2020-01-01' });
    const price = (unitId: string, amount: string) => ({ unitId, priceType: 'selling', amount });
    para = (await admin.post('/products', { name: 'Paracetamol', strength: '500 mg', baseUnitId: U.tablet, taxCategoryId: vat.id, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }], prices: [price(U.tablet, '2.6'), price(U.strip, '25.5'), price(U.box, '240')] })).body;
    amox = (await admin.post('/products', { name: 'Amoxicillin', strength: '250 mg', baseUnitId: U.capsule, requiresPrescription: true, prices: [price(U.capsule, '3')] })).body;
    vit = (await admin.post('/products', { name: 'Vitamin C', baseUnitId: U.tablet, prices: [price(U.tablet, '1')] })).body;
    incl = (await admin.post('/products', { name: 'Inclusive item', baseUnitId: U.piece, taxCategoryId: vatIn.id, prices: [price(U.piece, '115')] })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    cashier = await userWith('cashier', 'Cashier', A.id);
    dispenser = await userWith('dispenser', 'Dispenser / Sales Staff', A.id);
  });

  // ---- helpers ----
  async function stockIn(product: any, ref: string, expiry: number, qty: string, cost = '1.5', warehouseId = whA.id) {
    const r = await keeper.post('/inventory/adjustments', { warehouseId, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: product.id, quantity: qty, direction: 'increase', newBatch: { batchRef: ref, expiryDate: day(expiry), unitCost: cost } }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const line = (product: any, quantity: string, unit?: string, extra: object = {}) => ({ productId: product.id, unitId: unit, quantity, ...extra });
  const cash = (amount: string, tendered?: string) => ({ methodCode: 'cash', amount, ...(tendered ? { tendered } : {}) });
  const body = (items: any[], payments: any[], extra: object = {}) => ({ registerId: R1.id, idempotencyKey: randomUUID(), items, payments, ...extra });
  const sell = (client: Client, items: any[], payments: any[], extra: object = {}) => client.post('/sales', body(items, payments, extra));
  const qtyOf = async (product: any, status = 'available', warehouseId = whA.id) =>
    (await admin.get(`/inventory/stock?productId=${product.id}&status=${status}&warehouseId=${warehouseId}`)).body.items.reduce((s: number, i: any) => s + Number(i.quantity), 0);
  const reconcile = async () => (await admin.get('/inventory/reconcile')).body;
  const customerOf = async (id: string) => (await mgr.get(`/customers/${id}`)).body;

  describe('making a sale', () => {
    it('prices, taxes, takes stock by earliest expiry, records cost and gives change', async () => {
      await stockIn(para, 'SOON', 30, '10', '1.5');
      await stockIn(para, 'LATE', 90, '100', '1.8');
      const res = await sell(cashier, [line(para, '15', U.tablet)], [cash('44.85', '50')]);
      expect(res.status).toBe(201);
      const s = res.body;
      expect(s).toMatchObject({ reference_no: 'S-000001', status: 'completed', subtotal: '39.0000', tax_total: '5.8500', total: '44.8500', paid_total: '44.8500', credit_total: '0.0000', change_given: '5.1500', cashier_name: 'cashier', branch_code: 'MAIN' });
      expect(s.items[0]).toMatchObject({ unit_price: '2.6000', line_gross: '39.0000', tax_rate: '15.0000', tax_amount: '5.8500', line_total: '44.8500', base_quantity: '15.0000' });
      expect(s.items[0].allocations.map((a: any) => [a.batch_ref, a.base_quantity])).toEqual([['SOON', '10.0000'], ['LATE', '5.0000']]);
      expect(s.items[0].cost_total).toBeUndefined(); // a cashier never sees what the goods cost
      expect(s.cogs_total).toBeUndefined();
      expect(s.items[0].allocations[0].unit_cost).toBeUndefined();
      const full = (await mgr.get(`/sales/${s.id}`)).body; // a manager does
      expect(full.items[0].cost_total).toBe('24.0000'); // 10 x 1.50 + 5 x 1.80
      expect(full.cogs_total).toBe('24.0000');
      expect((await cashier.get('/sales/summary')).body.cogs).toBeUndefined();
      expect(await qtyOf(para)).toBe(95);
      const moves = (await admin.get('/inventory/movements?movementType=sale')).body.items;
      expect(moves).toHaveLength(2);
      expect(moves.every((m: any) => m.reference_no === 'S-000001' && Number(m.quantity_delta) < 0)).toBe(true);
      expect(await reconcile()).toEqual([]);
    });

    it('works out discounts and both kinds of tax exactly', async () => {
      await stockIn(para, 'L', 90, '100'); await stockIn(vit, 'V', 90, '50'); await stockIn(incl, 'I', 90, '10');
      const pct = (await sell(cashier, [line(para, '2', U.strip, { discountPercent: '10' })], [cash('52.79')])).body;
      expect(pct.items[0]).toMatchObject({ line_gross: '51.0000', discount_amount: '5.1000', discount_percent: '10.0000', line_net: '45.9000', tax_amount: '6.8900', line_total: '52.7900' }); // 6.885 rounds to 6.89
      expect(pct).toMatchObject({ discount_total: '5.1000', total: '52.7900' });
      const amt = (await sell(cashier, [line(para, '2', U.strip, { discountAmount: '3' })], [cash('55.2')])).body;
      expect(amt.items[0].discount_percent).toBe('5.8824'); // 3 of 51
      expect(amt.items[0]).toMatchObject({ discount_amount: '3.0000', line_net: '48.0000', tax_amount: '7.2000', line_total: '55.2000' });
      const mixed = (await sell(cashier, [line(para, '1', U.strip), line(vit, '4')], [cash('33.33')])).body;
      expect(mixed.total).toBe('33.3300'); // 25.50 + 3.83 tax + 4.00
      const inclusive = (await sell(cashier, [line(incl, '1')], [cash('115')])).body;
      expect(inclusive.items[0]).toMatchObject({ line_net: '100.0000', tax_amount: '15.0000', line_total: '115.0000' }); // the price already contains the tax
    });

    it('sells in boxes and strips with exact conversion', async () => {
      await stockIn(para, 'L', 90, '500');
      const s = (await sell(cashier, [line(para, '1', U.box), line(para, '0.5', U.strip)], [cash('290.66')])).body; // 240 + 12.75 = 252.75 net, tax 37.9125 -> 37.91
      expect(s.items.map((i: any) => i.base_quantity)).toEqual(['100.0000', '5.0000']);
      expect(await qtyOf(para)).toBe(395);
    });

    it('refuses what cannot be sold, leaving no trace', async () => {
      await stockIn(para, 'GOOD', 60, '10'); await stockIn(para, 'OLD', -3, '50');
      const soon = (await admin.get(`/inventory/batches?productId=${para.id}`)).body.find((b: any) => b.batch_ref === 'GOOD');
      await keeper.post('/inventory/status-changes', { warehouseId: whA.id, batchId: soon.id, quantity: '4', from: 'available', to: 'quarantined', reason: 'Awaiting inspection' });
      const short = await sell(cashier, [line(para, '7', U.tablet)], [cash('20.93')]); // only 6 saleable: expired and quarantined units do not count
      expect(short.status).toBe(409);
      expect(short.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { requested: '7.0000', available: '6.0000', product: 'Paracetamol 500 mg' } });
      expect(await qtyOf(para)).toBe(56); // 6 saleable + 50 expired-but-still-available
      expect((await sell(cashier, [line(para, '6', U.tablet)], [cash('17.94')])).body.reference_no).toBe('S-000001'); // the failed attempt did not use up a number
      const inactive = (await admin.post('/products', { name: 'Gone', baseUnitId: U.tablet, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '1' }] })).body;
      await admin.post(`/products/${inactive.id}/deactivate`, { version: inactive.version });
      expect((await sell(cashier, [line(inactive, '1')], [cash('1')])).body.code).toBe('PRODUCT_INACTIVE');
      const noPrice = (await admin.post('/products', { name: 'No price', baseUnitId: U.tablet })).body;
      expect((await sell(cashier, [line(noPrice, '1')], [cash('1')])).body.code).toBe('NO_PRICE');
      const unsellable = (await admin.post('/products', { name: 'Bulk only', baseUnitId: U.tablet, units: [{ unitId: U.strip, factorToBase: '10', isSellable: false }] })).body;
      expect((await sell(cashier, [line(unsellable, '1', U.strip)], [cash('1')])).body.code).toBe('UNIT_NOT_SELLABLE');
    });

    it('checks the payments carefully', async () => {
      await stockIn(vit, 'V', 90, '50');
      const s = (items: any[], payments: any[], extra: object = {}) => sell(cashier, items, payments, extra);
      const one = [line(vit, '10')]; // total 10.00
      expect((await s(one, [cash('9')])).body).toMatchObject({ code: 'PAYMENT_MISMATCH', details: { total: '10.0000', paid: '9.0000' } });
      expect((await s(one, [cash('11')])).body.code).toBe('PAYMENT_MISMATCH');
      expect((await s(one, [])).body.code).toBe('PAYMENT_MISMATCH');
      expect((await s(one, [{ methodCode: 'mobile_money', amount: '10' }])).body.code).toBe('REFERENCE_REQUIRED');
      expect((await s(one, [{ methodCode: 'barter', amount: '10' }])).body.code).toBe('PAYMENT_METHOD_NOT_FOUND');
      expect((await s(one, [cash('10', '5')])).body.code).toBe('TENDERED_TOO_LOW');
      expect((await s(one, [{ methodCode: 'card', amount: '10', tendered: '20', reference: 'X' }])).body.code).toBe('TENDERED_CASH_ONLY');
      expect((await s(one, [cash('0')])).body.code).toBe('INVALID_AMOUNT');
      expect((await s(one, [cash('4'), { methodCode: 'mobile_money', amount: '6', reference: 'TX-42' }])).status).toBe(201); // split payment
      await admin.patch(`/payment-methods/${(await admin.get('/payment-methods')).body.find((m: any) => m.code === 'card').id}`, { version: 1, isActive: false });
      expect((await s(one, [{ methodCode: 'card', amount: '10', reference: 'X' }])).body.code).toBe('PAYMENT_METHOD_NOT_FOUND');
      expect(await qtyOf(vit)).toBe(40);
    });

    it('validates the request itself', async () => {
      await stockIn(vit, 'V', 90, '50');
      expect((await sell(cashier, [], [])).status).toBe(400);
      expect((await cashier.post('/sales', { ...body([line(vit, '1')], [cash('1')]), idempotencyKey: 'short' })).status).toBe(400);
      expect((await sell(cashier, [line(vit, '1', undefined, { discountPercent: '5', discountAmount: '0.05' })], [cash('1')])).body.code).toBe('DISCOUNT_AMBIGUOUS');
      expect((await sell(cashier, [line(vit, '1', undefined, { discountAmount: '5' })], [cash('1')])).body.code).toBe('INVALID_DISCOUNT');
      expect((await sell(cashier, [line(vit, '0')], [cash('0')])).status).toBe(400);
      // Offline-only fields are refused on the online route: a backdated soldAt would price the sale at an older price
      // and skip the open-register check. Offline sales go through POST /sync/sales (covered in sync.e2e-spec.ts).
      const backdated = { deviceId: randomUUID(), offlineRef: 'OFF-17', soldAt: new Date(Date.now() - 600e3).toISOString() };
      for (const extra of [{ soldAt: backdated.soldAt }, { offlineRef: backdated.offlineRef }, { deviceId: backdated.deviceId }, backdated]) {
        expect((await sell(cashier, [line(vit, '1')], [cash('1')], extra)).status).toBe(400);
      }
    });
  });

  describe('retries and simultaneous sales', () => {
    it('returns the same sale when the same request is sent twice', async () => {
      await stockIn(vit, 'V', 90, '50');
      const b = body([line(vit, '5')], [cash('5')]);
      const first = await cashier.post('/sales', b);
      const again = await cashier.post('/sales', b);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      expect(await qtyOf(vit)).toBe(45); // sold once
      expect((await ctx.db.query(`select count(*)::int as n from sales.sales`)).rows[0].n).toBe(1);
      const changed = await cashier.post('/sales', { ...b, items: [line(vit, '6')], payments: [cash('6')] });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await mgr.post('/sales', b)).body.code).toBe('IDEMPOTENCY_KEY_REUSED'); // another cashier cannot take over the key
    });

    it('creates only one sale when two identical requests arrive at once', async () => {
      await stockIn(vit, 'V', 90, '50');
      const b = body([line(vit, '5')], [cash('5')]);
      const results = await Promise.all([cashier.post('/sales', b), cashier.post('/sales', b), cashier.post('/sales', b)]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(await qtyOf(vit)).toBe(45);
      expect(await reconcile()).toEqual([]);
    });

    it('sells exactly what exists when many tills sell at once', async () => {
      await stockIn(vit, 'V', 90, '10');
      const results = await Promise.all(Array.from({ length: 14 }, () => sell(cashier, [line(vit, '1')], [cash('1')])));
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'INSUFFICIENT_STOCK')).toBe(true);
      expect(await qtyOf(vit)).toBe(0);
      const refs = results.filter((r) => r.status === 201).map((r) => r.body.reference_no);
      expect(new Set(refs).size).toBe(10);
      expect(await reconcile()).toEqual([]);
    });
  });

  describe('discounts above the limit', () => {
    beforeEach(async () => { await stockIn(vit, 'V', 90, '200'); });
    const big = (pct: string, extra: object = {}) => sell(cashier, [line(vit, '20', undefined, { discountPercent: pct })], [cash(String(20 - (20 * Number(pct)) / 100))], extra);

    it('needs an approval obtained first, which pays for exactly one sale', async () => {
      const blocked = await big('15');
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ code: 'DISCOUNT_APPROVAL_REQUIRED', details: { limit: '10', requested: '15.0000' } });
      expect((await cashier.post('/discount-requests', { branchId: A.id, percent: '8', reason: 'Loyal customer' })).body.code).toBe('NO_APPROVAL_NEEDED');
      const req = (await cashier.post('/discount-requests', { branchId: A.id, registerId: R1.id, percent: '15', reason: 'Regular customer, large basket' })).body;
      expect(req).toMatchObject({ status: 'pending', reference_no: 'DSC-000001', percent: '15.0000' });
      expect((await big('15', { discountRequestId: req.id })).body.code).toBe('DISCOUNT_NOT_APPROVED'); // not approved yet
      expect((await cashier.post(`/approvals/${req.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/approvals/${req.approval_id}/approve`, {})).status).toBe(200);
      expect((await big('20', { discountRequestId: req.id })).body.code).toBe('DISCOUNT_EXCEEDS_APPROVAL'); // approved for 15, not 20
      const ok = await big('15', { discountRequestId: req.id });
      expect(ok.status).toBe(201);
      expect(ok.body.discount_total).toBe('3.0000');
      expect((await cashier.get(`/discount-requests/${req.id}`)).body).toMatchObject({ status: 'used', sale_id: ok.body.id });
      expect((await big('15', { discountRequestId: req.id })).body.code).toBe('DISCOUNT_NOT_APPROVED'); // already used
    });

    it('expires, can be withdrawn, and is checked against the branch', async () => {
      const mk = async () => (await cashier.post('/discount-requests', { branchId: A.id, percent: '15', reason: 'Special case' })).body;
      const old = await mk();
      await mgr.post(`/approvals/${old.approval_id}/approve`, {});
      await ctx.db.query(`update sales.discount_requests set approved_at = now() - interval '2 hours' where id = $1`, [old.id]);
      expect((await big('15', { discountRequestId: old.id })).body.code).toBe('DISCOUNT_APPROVAL_EXPIRED');
      const withdrawn = await mk();
      expect((await cashier.post(`/discount-requests/${withdrawn.id}/cancel`, {})).body.status).toBe('cancelled');
      const rejected = await mk();
      await mgr.post(`/approvals/${rejected.approval_id}/reject`, { comment: 'Too generous' });
      expect((await big('15', { discountRequestId: rejected.id })).body.code).toBe('DISCOUNT_NOT_APPROVED');
      expect((await cashier.post('/discount-requests', { branchId: B.id, percent: '15', reason: 'Other branch' })).status).toBe(403);
      const lower = await sell(cashier, [line(vit, '20', undefined, { discountPercent: '10' })], [cash('18')]); // at the limit needs nothing
      expect(lower.status).toBe(201);
    });
  });

  describe('selling on account', () => {
    let cust: any;
    beforeEach(async () => {
      await stockIn(vit, 'V', 90, '500');
      cust = (await cashier.post('/customers', { name: 'Hana Bekele', phone: '0911000111' })).body;
    });
    const account = (client: Client, amount: string, customerId: string | undefined, extra: object = {}) => sell(client, [line(vit, amount)], [{ methodCode: 'credit', amount }], customerId ? { customerId, ...extra } : extra);

    it('keeps an account balance, enforces the credit limit and the permission', async () => {
      expect(cust).toMatchObject({ code: 'CUS-000001', credit_limit: '0.0000', balance: '0.0000' });
      expect((await cashier.post('/customers', { name: 'X', creditLimit: '500' })).status).toBe(403); // setting credit needs its own permission
      expect((await account(mgr, '10', cust.id)).body.code).toBe('NO_CREDIT_ALLOWED');
      expect((await account(mgr, '10', undefined)).body.code).toBe('CUSTOMER_REQUIRED');
      expect((await cashier.patch(`/customers/${cust.id}`, { version: cust.version, creditLimit: '100' })).status).toBe(403);
      const limited = (await mgr.patch(`/customers/${cust.id}`, { version: cust.version, creditLimit: '100' })).body;
      expect((await account(cashier, '10', cust.id)).body.code).toBe('PERMISSION_DENIED'); // the cashier may not sell on account
      const sale = (await account(mgr, '60', cust.id)).body;
      expect(sale).toMatchObject({ credit_total: '60.0000', paid_total: '0.0000', customer_name: 'Hana Bekele' });
      expect((await customerOf(cust.id)).balance).toBe('60.0000');
      const over = await account(mgr, '50', cust.id);
      expect(over.body).toMatchObject({ code: 'CREDIT_LIMIT_EXCEEDED', details: { creditLimit: '100.0000', balance: '60.0000', attempted: '50.0000' } });
      expect(await qtyOf(vit)).toBe(440); // the refused sale took no stock
      const split = await sell(mgr, [line(vit, '30')], [cash('10'), { methodCode: 'credit', amount: '20' }], { customerId: cust.id });
      expect(split.body).toMatchObject({ paid_total: '10.0000', credit_total: '20.0000' });
      expect((await customerOf(cust.id)).balance).toBe('80.0000');
      await mgr.patch(`/customers/${cust.id}`, { version: limited.version, status: 'inactive' });
      expect((await account(mgr, '5', cust.id)).body.code).toBe('CUSTOMER_INACTIVE');
    });

    it('takes payments on account, reverses them, and always agrees with its ledger', async () => {
      const c = (await mgr.patch(`/customers/${cust.id}`, { version: cust.version, creditLimit: '500' })).body;
      await account(mgr, '120', c.id);
      const pay = await cashier.post(`/customers/${c.id}/payments`, { branchId: A.id, registerId: R1.id, methodCode: 'cash', amount: '50' });
      expect(pay.status).toBe(201);
      expect(pay.body).toMatchObject({ reference_no: 'CPAY-000001', amount: '50.0000', status: 'posted' });
      expect((await customerOf(c.id)).balance).toBe('70.0000');
      expect((await cashier.post(`/customers/${c.id}/payments`, { branchId: A.id, methodCode: 'credit', amount: '5' })).body.code).toBe('INVALID_PAYMENT_METHOD');
      expect((await cashier.post(`/customers/${c.id}/payments`, { branchId: A.id, methodCode: 'bank_transfer', amount: '5' })).body.code).toBe('REFERENCE_REQUIRED');
      expect((await cashier.post(`/customers/${c.id}/payments`, { branchId: B.id, methodCode: 'cash', amount: '5' })).status).toBe(403);
      expect((await cashier.post(`/customer-payments/${pay.body.id}/reverse`, { reason: 'Entered twice' })).status).toBe(403);
      const rev = await mgr.post(`/customer-payments/${pay.body.id}/reverse`, { reason: 'Entered twice' });
      expect(rev.body.status).toBe('reversed');
      expect((await customerOf(c.id)).balance).toBe('120.0000');
      expect((await mgr.post(`/customer-payments/${pay.body.id}/reverse`, { reason: 'again' })).body.code).toBe('PAYMENT_ALREADY_REVERSED');
      const st = (await cashier.get(`/customers/${c.id}/statement`)).body;
      expect(st.lines.map((l: any) => [l.type, l.charge, l.payment, l.balance])).toEqual([['credit_sale', '120.0000', '0.0000', '120.0000'], ['payment', '0.0000', '50.0000', '70.0000'], ['payment_reversal', '50.0000', '0.0000', '120.0000']]);
      expect(st.closingBalance).toBe('120.0000');
      expect((await mgr.get('/customers/reconcile')).body).toEqual([]);
      await expect(ctx.db.query(`update sales.customer_ledger set amount = 1`)).rejects.toThrow(/append-only/);
      expect((await cashier.get('/customers?search=0911')).body.total).toBe(1);
      expect((await cashier.get('/customers?owing=true')).body.total).toBe(1);
    });
  });

  describe('prescriptions', () => {
    let rx: any;
    const rxBody = (extra: object = {}) => ({ branchId: A.id, patientName: 'Selam Girma', prescriberName: 'Dr. Tadesse', prescriberLicenseNo: 'MD-1234', facility: 'City Clinic', prescribedDate: day(-2), items: [{ productId: amox.id, quantity: '30', dosage: '1 capsule', frequency: 'three times a day', duration: '10 days' }], ...extra });
    const sellRx = (qty: string, prescriptionId?: string, client: Client = dispenser) => sell(client, [line(amox, qty)], [cash(String(Number(qty) * 3))], prescriptionId ? { prescriptionId } : {});
    beforeEach(async () => { await stockIn(amox, 'A1', 120, '100'); await stockIn(vit, 'V', 90, '50'); });

    it('is required for prescription medicines, and only a validated one can be dispensed', async () => {
      expect((await sellRx('10')).body).toMatchObject({ code: 'PRESCRIPTION_REQUIRED', details: { productIds: [amox.id] } });
      rx = (await dispenser.post('/prescriptions', rxBody())).body;
      expect(rx).toMatchObject({ status: 'pending_validation', reference_no: 'RX-000001' });
      expect(rx.items[0]).toMatchObject({ quantity_prescribed: '30.0000', quantity_dispensed: '0.0000', quantity_remaining: '30.0000' });
      expect((await sellRx('10', rx.id)).body.code).toBe('PRESCRIPTION_NOT_VALID');
      expect((await dispenser.post(`/prescriptions/${rx.id}/validate`, {})).status).toBe(403); // a pharmacist validates
      expect((await mgr.post(`/prescriptions/${rx.id}/validate`, {})).body.status).toBe('valid');
      expect((await mgr.post(`/prescriptions/${rx.id}/validate`, {})).body.code).toBe('PRESCRIPTION_NOT_PENDING');
    });

    it('tracks what has been dispensed and stops at the prescribed amount', async () => {
      rx = (await dispenser.post('/prescriptions', rxBody())).body;
      await mgr.post(`/prescriptions/${rx.id}/validate`, {});
      const over = await sellRx('40', rx.id);
      expect(over.body).toMatchObject({ code: 'EXCEEDS_PRESCRIPTION', details: { prescribed: '30.0000', alreadyDispensed: '0.0000' } });
      const first = await sellRx('20', rx.id);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ prescription_id: rx.id, prescription_reference: 'RX-000001' });
      let cur = (await dispenser.get(`/prescriptions/${rx.id}`)).body;
      expect(cur.items[0]).toMatchObject({ quantity_dispensed: '20.0000', quantity_remaining: '10.0000' });
      expect(cur.dispensing.map((d: any) => d.reference_no)).toEqual([first.body.reference_no]);
      expect((await sellRx('15', rx.id)).body.code).toBe('EXCEEDS_PRESCRIPTION');
      expect(await qtyOf(amox)).toBe(80); // the refused sale took nothing
      expect((await sellRx('10', rx.id)).status).toBe(201);
      cur = (await dispenser.get(`/prescriptions/${rx.id}`)).body;
      expect(cur.status).toBe('fulfilled');
      expect((await sellRx('1', rx.id)).body.code).toBe('PRESCRIPTION_NOT_VALID'); // fully dispensed
      expect((await dispenser.post(`/prescriptions/${rx.id}/cancel`, {})).body.code).toBe('PRESCRIPTION_NOT_CANCELLABLE');
    });

    it('rejects a medicine that is not on the prescription and unusable prescriptions', async () => {
      const other = (await admin.post('/products', { name: 'Ciprofloxacin', baseUnitId: U.tablet, requiresPrescription: true, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '5' }] })).body;
      await stockIn(other, 'C1', 120, '20');
      rx = (await dispenser.post('/prescriptions', rxBody())).body;
      await mgr.post(`/prescriptions/${rx.id}/validate`, {});
      const wrong = await sell(dispenser, [line(other, '2')], [cash('10')], { prescriptionId: rx.id });
      expect(wrong.body.code).toBe('NOT_ON_PRESCRIPTION');
      // a medicine without a prescription requirement can ride along on the same sale
      expect((await sell(dispenser, [line(amox, '5'), line(vit, '3')], [cash('18')], { prescriptionId: rx.id })).status).toBe(201);
      const rejected = (await dispenser.post('/prescriptions', rxBody({ patientName: 'Dawit' }))).body;
      expect((await mgr.post(`/prescriptions/${rejected.id}/reject`, { reason: 'Signature missing' })).body).toMatchObject({ status: 'rejected', rejection_reason: 'Signature missing' });
      expect((await sellRx('5', rejected.id)).body.code).toBe('PRESCRIPTION_NOT_VALID');
      expect((await sellRx('5', '00000000-0000-4000-8000-000000000000')).body.code).toBe('PRESCRIPTION_NOT_FOUND');
    });

    it('can expire, and requires the details the pharmacy configured', async () => {
      await admin.put('/settings/prescriptions.validity_days', { value: 30 });
      const old = (await dispenser.post('/prescriptions', rxBody({ prescribedDate: day(-60) }))).body;
      await mgr.post(`/prescriptions/${old.id}/validate`, {});
      expect((await sellRx('5', old.id)).body.code).toBe('PRESCRIPTION_EXPIRED');
      expect((await dispenser.post('/prescriptions', rxBody({ prescriberName: undefined }))).body).toMatchObject({ code: 'REQUIRED_FIELDS_MISSING', details: { missing: ['prescriberName'] } });
      await admin.put('/settings/prescriptions.required_fields', { value: ['patientName', 'prescriberName', 'prescribedDate', 'prescriberLicenseNo'] });
      expect((await dispenser.post('/prescriptions', rxBody({ prescriberLicenseNo: undefined }))).body.details.missing).toEqual(['prescriberLicenseNo']);
      expect((await dispenser.post('/prescriptions', rxBody({ prescribedDate: day(3) }))).body.code).toBe('PRESCRIBED_DATE_IN_FUTURE');
      expect((await dispenser.post('/prescriptions', rxBody({ items: [{ productId: amox.id, quantity: '1' }, { productId: amox.id, quantity: '2' }] }))).body.code).toBe('DUPLICATE_LINE');
    });

    it('keeps health information restricted, logged and inside the branch', async () => {
      rx = (await dispenser.post('/prescriptions', rxBody())).body;
      expect((await cashier.get(`/prescriptions/${rx.id}`)).status).toBe(403); // cashiers have no access
      expect((await cashier.get('/prescriptions')).status).toBe(403);
      expect((await dispenser.post('/prescriptions', rxBody({ branchId: B.id }))).status).toBe(403);
      const mgrB = await userWith('mgr.b', 'Branch Manager', B.id);
      expect((await mgrB.get(`/prescriptions/${rx.id}`)).status).toBe(404);
      await dispenser.get(`/prescriptions/${rx.id}`);
      const viewed = (await admin.get(`/audit-logs?entityType=prescription&entityId=${rx.id}&action=prescription.viewed`)).body;
      expect(viewed.total).toBe(1);
      expect(viewed.items[0].username).toBe('dispenser');
      const registered = (await admin.get(`/audit-logs?entityType=prescription&entityId=${rx.id}&action=prescription.registered`)).body.items[0];
      expect(JSON.stringify(registered)).not.toContain('Selam'); // the patient's name is not copied into the audit log
      expect((await dispenser.get('/prescriptions?search=selam')).body.total).toBe(1);
    });

    it('accepts scans by their real content and records who opened them', async () => {
      rx = (await dispenser.post('/prescriptions', rxBody())).body;
      const up = (content: Buffer | string, name = 'scan.pdf') => (ctx.http() as any).put(`/api/v1/prescriptions/${rx.id}/attachment`).set('Authorization', `Bearer ${adminToken}`).attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
      expect((await up('<html><script>alert(1)</script></html>')).body.code).toBe('UNSUPPORTED_FILE');
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 7)]);
      expect((await up(pdf)).body).toMatchObject({ type: 'application/pdf' });
      const dl = await (ctx.http() as any).get(`/api/v1/prescriptions/${rx.id}/attachment`).set('Authorization', `Bearer ${adminToken}`).buffer(true).parse((r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(dl.body, pdf)).toBe(0);
      expect((await admin.get(`/audit-logs?action=prescription.attachment_viewed`)).body.total).toBe(1);
      expect((await dispenser.get(`/prescriptions/${rx.id}`)).body.has_attachment).toBe(true);
    });
  });

  describe('cancelling a sale', () => {
    beforeEach(async () => { await stockIn(para, 'L', 90, '100'); await stockIn(amox, 'A1', 120, '50'); });

    it('puts everything back once a second person approves', async () => {
      const sale = (await sell(cashier, [line(para, '2', U.strip)], [cash('58.65')])).body;
      expect(await qtyOf(para)).toBe(80);
      const req = await dispenser.post(`/sales/${sale.id}/cancel`, { reason: 'Customer changed their mind at the counter' });
      expect(req.status).toBe(200);
      expect(req.body.status).toBe('completed'); // nothing changes until approved
      const approval = (await mgr.get('/approvals')).body.find((a: any) => a.action_code === 'sales.cancel');
      expect(approval.summary).toMatchObject({ reference: sale.reference_no, total: '58.6500' });
      expect((await dispenser.post(`/approvals/${approval.id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await dispenser.post(`/sales/${sale.id}/cancel`, { reason: 'second request' })).status).toBe(409); // already waiting
      expect((await mgr.post(`/approvals/${approval.id}/approve`, {})).status).toBe(200);
      const done = (await mgr.get(`/sales/${sale.id}`)).body;
      expect(done).toMatchObject({ status: 'cancelled', cancel_reason: 'Customer changed their mind at the counter' });
      expect(done.refunds).toHaveLength(1);
      expect(done.refunds[0]).toMatchObject({ kind: 'cancellation', amount: '58.6500', method_code: 'cash' });
      expect(await qtyOf(para)).toBe(100);
      expect((await admin.get('/inventory/movements?movementType=correction')).body.total).toBe(1);
      expect(await reconcile()).toEqual([]);
      expect((await dispenser.post(`/sales/${sale.id}/cancel`, { reason: 'again please' })).body.code).toBe('SALE_NOT_CANCELLABLE');
      const receipt = (await mgr.get(`/sales/${sale.id}/receipt`)).body;
      expect(receipt.text).toContain('*** CANCELLED ***');
    });

    it('restores the customer account and the prescription', async () => {
      const cust = (await mgr.post('/customers', { name: 'Credit customer', creditLimit: '500' })).body;
      const rx = (await dispenser.post('/prescriptions', { branchId: A.id, patientName: 'P', prescriberName: 'Dr', prescribedDate: day(-1), items: [{ productId: amox.id, quantity: '30' }] })).body;
      await mgr.post(`/prescriptions/${rx.id}/validate`, {});
      const sale = (await sell(mgr, [line(amox, '30')], [{ methodCode: 'credit', amount: '90' }], { customerId: cust.id, prescriptionId: rx.id })).body;
      expect((await customerOf(cust.id)).balance).toBe('90.0000');
      expect((await mgr.get(`/prescriptions/${rx.id}`)).body.status).toBe('fulfilled');
      await dispenser.post(`/sales/${sale.id}/cancel`, { reason: 'Wrong customer' });
      await mgr.post(`/approvals/${(await mgr.get('/approvals')).body.find((a: any) => a.action_code === 'sales.cancel').id}/approve`, {});
      expect((await customerOf(cust.id)).balance).toBe('0.0000');
      const back = (await mgr.get(`/prescriptions/${rx.id}`)).body;
      expect(back.status).toBe('valid');
      expect(back.items[0].quantity_dispensed).toBe('0.0000');
      expect((await mgr.get(`/sales/${sale.id}`)).body.refunds).toEqual([]); // nothing was paid, so nothing is paid back
      expect((await mgr.get('/customers/reconcile')).body).toEqual([]);
    });

    it('is limited by time, by returns, and by the approval setting', async () => {
      const old = (await sell(cashier, [line(para, '1', U.strip)], [cash('29.33')])).body;
      await ctx.db.query(`update sales.sales set sold_at = now() - interval '2 days' where id = $1`, [old.id]);
      expect((await dispenser.post(`/sales/${old.id}/cancel`, { reason: 'too late' })).body.code).toBe('CANCEL_WINDOW_PASSED');
      const sale = (await sell(cashier, [line(para, '2', U.strip)], [cash('58.65')])).body;
      const ret = (await cashier.post('/sales-returns', { saleId: sale.id, reason: 'Wrong item', refundMethodCode: 'cash', items: [{ saleItemId: sale.items[0].id, quantity: '1' }] })).body;
      await mgr.post(`/approvals/${ret.approval_id}/approve`, {});
      expect((await dispenser.post(`/sales/${sale.id}/cancel`, { reason: 'has a return' })).body.code).toBe('SALE_NOT_CANCELLABLE');
      const plain = (await sell(cashier, [line(para, '1', U.strip)], [cash('29.33')])).body;
      await admin.put('/settings/sales.cancel_approval_required', { value: false });
      expect((await dispenser.post(`/sales/${plain.id}/cancel`, { reason: 'Mistake' })).status).toBe(403); // cancelled at once, so it needs the approval permission
      expect((await mgr.post(`/sales/${plain.id}/cancel`, { reason: 'Mistake' })).body.status).toBe('cancelled');
      expect((await cashier.post(`/sales/${plain.id}/cancel`, { reason: 'Mistake' })).status).toBe(403);
    });
  });

  describe('returns', () => {
    let sale: any;
    beforeEach(async () => { await stockIn(para, 'L', 90, '100'); sale = (await sell(cashier, [line(para, '2', U.strip)], [cash('58.65')])).body; });
    const returnBody = (qty: string, extra: object = {}) => ({ saleId: sale.id, reason: 'Packaging damaged', refundMethodCode: 'cash', items: [{ saleItemId: sale.items[0].id, quantity: qty, unitId: U.strip }], ...extra });

    it('refunds exactly what was paid, puts goods into quarantine, and tracks the sale status', async () => {
      const r1 = (await cashier.post('/sales-returns', returnBody('1'))).body;
      expect(r1).toMatchObject({ status: 'pending_approval', reference_no: 'SR-000001', refund_total: '29.3300' });
      expect(await qtyOf(para, 'quarantined')).toBe(0);
      expect((await cashier.post(`/approvals/${r1.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await mgr.post(`/approvals/${r1.approval_id}/approve`, {})).status).toBe(200);
      expect(await qtyOf(para, 'quarantined')).toBe(10);
      expect(await qtyOf(para)).toBe(80); // not back on the shelf yet
      let s = (await mgr.get(`/sales/${sale.id}`)).body;
      expect(s.status).toBe('partially_returned');
      expect(s.items[0].returned_base).toBe('10.0000');
      expect(s.refunds[0]).toMatchObject({ kind: 'return', amount: '29.3300', method_code: 'cash' });
      const r2 = (await cashier.post('/sales-returns', returnBody('1'))).body;
      expect(r2.refund_total).toBe('29.3200'); // the two halves add up to exactly 58.65
      await mgr.post(`/approvals/${r2.approval_id}/approve`, {});
      s = (await mgr.get(`/sales/${sale.id}`)).body;
      expect(s.status).toBe('returned');
      expect(s.refunds.reduce((t: number, f: any) => t + Number(f.amount), 0).toFixed(2)).toBe('58.65');
      expect((await cashier.post('/sales-returns', returnBody('1'))).body.code).toBe('SALE_NOT_RETURNABLE');
      expect(await reconcile()).toEqual([]);
    });

    it('counts waiting returns against what can still be returned, and checks the request', async () => {
      const first = await cashier.post('/sales-returns', returnBody('1.5'));
      expect(first.status).toBe(201);
      const second = await cashier.post('/sales-returns', returnBody('1'));
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'RETURN_EXCEEDS_SALE', details: { remaining: '5.0000', attempted: '10.0000' } });
      expect((await cashier.post('/sales-returns', returnBody('0.5'))).status).toBe(201);
      expect((await cashier.post('/sales-returns', returnBody('1', { refundMethodCode: undefined }))).body.code).toBe('REFUND_METHOD_REQUIRED');
      expect((await cashier.post('/sales-returns', returnBody('1', { refundMethodCode: 'credit' }))).body.code).toBe('PAYMENT_METHOD_NOT_FOUND');
      expect((await cashier.post('/sales-returns', returnBody('1', { refundMethodCode: 'mobile_money' }))).body.code).toBe('REFERENCE_REQUIRED');
      expect((await cashier.post('/sales-returns', { ...returnBody('1'), items: [{ saleItemId: '00000000-0000-4000-8000-000000000000', quantity: '1' }] })).body.code).toBe('ITEM_NOT_IN_SALE');
      await ctx.db.query(`update sales.sales set sold_at = now() - interval '40 days' where id = $1`, [sale.id]);
      expect((await cashier.post('/sales-returns', returnBody('0.5'))).body.code).toBe('RETURN_WINDOW_PASSED');
    });

    it('needs an inspector to decide whether returned goods can be sold again', async () => {
      const r = (await cashier.post('/sales-returns', returnBody('2'))).body;
      await admin.post(`/approvals/${r.approval_id}/approve`, {});
      const item = (await mgr.get(`/sales-returns/${r.id}`)).body.items[0];
      expect(item.disposition).toBe('pending');
      expect((await cashier.post(`/sales-returns/${r.id}/inspect`, { items: [{ itemId: item.id, disposition: 'resale' }] })).status).toBe(403);
      const done = await mgr.post(`/sales-returns/${r.id}/inspect`, { items: [{ itemId: item.id, disposition: 'resale', note: 'Box intact' }] });
      expect(done.body.items[0]).toMatchObject({ disposition: 'resale', note: 'Box intact' });
      expect(await qtyOf(para, 'quarantined')).toBe(0);
      expect(await qtyOf(para)).toBe(100); // back on sale
      expect((await mgr.post(`/sales-returns/${r.id}/inspect`, { items: [{ itemId: item.id, disposition: 'damaged' }] })).body.code).toBe('ALREADY_INSPECTED');
      expect(await reconcile()).toEqual([]);
    });

    it('can send returned goods to damaged, and does not let the person who took them back inspect them', async () => {
      const r = (await mgr.post('/sales-returns', returnBody('1'))).body; // a manager takes it back...
      await admin.post(`/approvals/${r.approval_id}/approve`, {});
      const item = (await mgr.get(`/sales-returns/${r.id}`)).body.items[0];
      const own = await mgr.post(`/sales-returns/${r.id}/inspect`, { items: [{ itemId: item.id, disposition: 'resale' }] });
      expect(own.status).toBe(403);
      expect(own.body.code).toBe('INSPECTOR_MUST_DIFFER');
      expect((await admin.post(`/sales-returns/${r.id}/inspect`, { items: [{ itemId: item.id, disposition: 'damaged' }] })).status).toBe(200);
      expect(await qtyOf(para, 'damaged')).toBe(10);
    });

    it('credits the customer\'s account instead of paying out for a sale on account', async () => {
      const cust = (await mgr.post('/customers', { name: 'Account customer', creditLimit: '500' })).body;
      const acc = (await sell(mgr, [line(para, '1', U.strip)], [{ methodCode: 'credit', amount: '29.33' }], { customerId: cust.id })).body;
      expect((await customerOf(cust.id)).balance).toBe('29.3300');
      const r = (await cashier.post('/sales-returns', { saleId: acc.id, reason: 'Not needed', items: [{ saleItemId: acc.items[0].id, quantity: '1' }] })).body; // no refund method needed
      await mgr.post(`/approvals/${r.approval_id}/approve`, {});
      expect((await customerOf(cust.id)).balance).toBe('0.0000');
      expect((await mgr.get(`/sales-returns/${r.id}`)).body.refunds).toEqual([expect.objectContaining({ amount: '29.3300', to_account: true })]);
      expect((await mgr.get('/customers/reconcile')).body).toEqual([]);
    });

    it('can be rejected or withdrawn without touching stock', async () => {
      const a = (await cashier.post('/sales-returns', returnBody('1'))).body;
      const b = (await cashier.post('/sales-returns', returnBody('1'))).body;
      expect((await mgr.post(`/approvals/${a.approval_id}/reject`, { comment: 'Outside policy' })).body.status).toBe('rejected');
      expect((await cashier.post(`/sales-returns/${b.id}/cancel`, {})).body.status).toBe('cancelled');
      expect(await qtyOf(para, 'quarantined')).toBe(0);
      expect((await cashier.post(`/sales-returns`, returnBody('2'))).status).toBe(201); // the rejected and withdrawn ones no longer hold the quantity
      expect((await cashier.get(`/sales-returns?saleId=${sale.id}`)).body.total).toBe(3);
    });
  });

  describe('receipts, history and reports', () => {
    beforeEach(async () => { await stockIn(para, 'L', 90, '200'); await stockIn(vit, 'V', 90, '100'); });

    it('prints receipts that fit the paper, and records reprints', async () => {
      await admin.put('/settings/business.name', { value: 'Hayat Pharmacy' });
      await admin.put('/settings/sales.receipt_footer', { value: 'Thank you\nGet well soon' });
      const sale = (await sell(cashier, [line(para, '2', U.strip, { discountPercent: '10' }), line(vit, '4')], [cash('56.79', '60')])).body;
      const r = (await cashier.get(`/sales/${sale.id}/receipt`)).body;
      expect(r).toMatchObject({ reference: sale.reference_no, paperWidthMm: 80, columns: 48, reprint: false });
      expect(r.text.split('\n').every((l: string) => l.length <= 48)).toBe(true);
      expect(r.text).toContain('Hayat Pharmacy');
      expect(r.text).toContain('Main Dispenser');
      expect(r.text).toMatch(/TOTAL ETB\s+56\.79/);
      expect(r.text).toMatch(/Change\s+3\.21/);
      expect(r.text).toContain('Get well soon');
      expect(r.text).not.toContain('REPRINT');
      await admin.put('/settings/sales.receipt_paper_width', { value: 58, branchId: A.id });
      const narrow = (await cashier.get(`/sales/${sale.id}/receipt?reprint=true`)).body;
      expect(narrow).toMatchObject({ paperWidthMm: 58, columns: 32, reprint: true });
      expect(narrow.text.split('\n').every((l: string) => l.length <= 32)).toBe(true);
      expect(narrow.text).toContain('*** REPRINT ***');
      expect((await admin.get('/audit-logs?action=sale.receipt_reprinted')).body.total).toBe(1);
    });

    it('lists sales with filters and summarises revenue, tax, cost and profit', async () => {
      const s1 = (await sell(cashier, [line(para, '2', U.strip)], [cash('58.65')])).body; // net 51.00, tax 7.65, cost 20 x 1.5 = 30.00
      await sell(mgr, [line(vit, '10')], [{ methodCode: 'mobile_money', amount: '10', reference: 'TX1' }]); // net 10, cost 15.00
      const gone = (await sell(cashier, [line(vit, '5')], [cash('5')])).body;
      await mgr.post(`/approvals/${(await (async () => { await dispenser.post(`/sales/${gone.id}/cancel`, { reason: 'Mistake' }); return (await mgr.get('/approvals')).body.find((a: any) => a.action_code === 'sales.cancel'); })()).id}/approve`, {});
      const sum = (await mgr.get('/sales/summary')).body;
      expect(sum).toMatchObject({ sales: 2, subtotal: '61.0000', tax: '7.6500', total: '68.6500', cogs: '45.0000', grossProfit: '16.0000' }); // the cancelled sale is left out
      expect(sum.byPaymentMethod.map((m: any) => [m.method_code, m.amount])).toEqual([['cash', '58.6500'], ['mobile_money', '10.0000']]);
      expect(sum.byCashier.map((c: any) => [c.cashier, c.sales])).toEqual([['cashier', 1], ['mgr', 1]]);
      expect((await cashier.get('/sales')).body.total).toBe(3);
      expect((await cashier.get('/sales?status=cancelled')).body.items.map((s: any) => s.id)).toEqual([gone.id]);
      expect((await cashier.get(`/sales?search=${s1.reference_no}`)).body.total).toBe(1);
      expect((await cashier.get('/sales?cashierId=' + s1.cashier_id)).body.total).toBe(2);
    });

    it('keeps each branch to its own registers and sales', async () => {
      await stockIn(vit, 'VB', 90, '20', '1', whB.id);
      const mgrB = await userWith('mgr.b', 'Branch Manager', B.id);
      const sale = (await sell(cashier, [line(vit, '3')], [cash('3')])).body;
      expect((await sell(cashier, [line(vit, '1')], [cash('1')], { registerId: RB.id })).status).toBe(404); // cannot even see the other branch's register
      expect((await cashier.get(`/sales/${sale.id}`)).status).toBe(200);
      expect((await mgrB.get(`/sales/${sale.id}`)).status).toBe(404);
      expect((await mgrB.get('/sales')).body.total).toBe(0);
      expect((await mgrB.get('/sales/summary')).body.sales).toBe(0);
      const noSell = await userWith('reader', 'Sales Manager', A.id);
      expect((await sell(noSell, [line(vit, '1')], [cash('1')])).status).toBe(403);
      expect((await cashier.post('/payment-methods', { code: 'voucher', name: 'Voucher' })).status).toBe(403);
      const m = await admin.post('/payment-methods', { code: 'voucher', name: 'Voucher', requiresReference: true });
      expect(m.status).toBe(201);
      expect((await cashier.get('/payment-methods')).body.map((x: any) => x.code)).toEqual(expect.arrayContaining(['cash', 'credit', 'voucher']));
      expect((await admin.post('/payment-methods', { code: 'voucher', name: 'Dup' })).body.code).toBe('DUPLICATE_VALUE');
    });

    it('records the sale in the audit log', async () => {
      const sale = (await sell(cashier, [line(vit, '2')], [cash('2')])).body;
      const log = (await admin.get(`/audit-logs?entityType=sale&entityId=${sale.id}`)).body.items;
      expect(log.map((e: any) => e.action)).toContain('sale.completed');
      expect(log.find((e: any) => e.action === 'sale.completed').username).toBe('cashier');
    });
  });
});
