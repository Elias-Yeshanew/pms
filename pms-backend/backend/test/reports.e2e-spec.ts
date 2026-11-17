import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

type Client = ReturnType<typeof authed>;
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe('Reports, dashboards and exports', () => {
  let ctx: TestCtx;
  let admin: Client, mgr: Client, keeper: Client, cashier: Client, disp: Client, salesMgr: Client, mgrA: Client, mgrB: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, R1: any, para: any, vit: any, zinc: any;

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  async function userWith(username: string, role: string, branchId?: string): Promise<Client> {
    expect((await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role), branchId }] })).status).toBe(201);
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }
  async function stockIn(product: any, qty: number, expiryDays = 400) {
    const r = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: product.id, quantity: String(qty), direction: 'increase', newBatch: { batchRef: `L${Math.random()}`.slice(0, 8), expiryDate: day(expiryDays), unitCost: '1' } }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const sell = (c: Client, product: any, qty: string, amount: string, discountPercent?: string) =>
    c.post('/sales', { registerId: R1.id, idempotencyKey: `K-${randomUUID()}`, items: [{ productId: product.id, quantity: qty, ...(discountPercent ? { discountPercent } : {}) }], payments: [{ methodCode: 'cash', amount }] });

  beforeAll(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
    A = (await admin.post('/branches', { code: 'MAIN', name: 'Main Dispenser' })).body;
    B = (await admin.post('/branches', { code: 'PIASSA', name: 'Piassa Dispenser' })).body;
    whA = (await admin.post('/warehouses', { branchId: A.id, code: 'W', name: 'Main store' })).body;
    R1 = (await admin.post('/cash-registers', { branchId: A.id, code: 'R1', name: 'Counter 1' })).body;
    const price = (amount: string) => [{ unitId: U.tablet, priceType: 'selling', amount }];
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, prices: price('2') })).body;
    vit = (await admin.post('/products', { name: 'Vitamin C', baseUnitId: U.tablet, prices: price('1') })).body;
    zinc = (await admin.post('/products', { name: 'Zinc', baseUnitId: U.tablet, prices: price('3') })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    cashier = await userWith('cashier', 'Cashier', A.id);
    disp = await userWith('disp', 'Dispenser / Sales Staff', A.id);
    salesMgr = await userWith('salesmgr', 'Sales Manager');
    mgrA = await userWith('mgra', 'Branch Manager', A.id);
    mgrB = await userWith('mgrb', 'Branch Manager', B.id);
    await stockIn(para, 100); await stockIn(vit, 30); await stockIn(vit, 10, 20); await stockIn(zinc, 8, 20);
    expect((await sell(cashier, para, '10', '20')).status).toBe(201);
    expect((await sell(cashier, para, '5', '9.5', '5')).status).toBe(201);
    expect((await sell(disp, vit, '20', '20')).status).toBe(201);
  });

  it('adds up sales by day, product, payment method and employee', async () => {
    const d = (await admin.get('/reports/sales_by_day?period=today')).body;
    expect(d.rows).toHaveLength(1);
    expect(d.totals).toMatchObject({ sales: 3, net: '49.5000', discounts: '0.5000', total: '49.5000' });
    expect(d.period.days).toBe(1);
    const top = (await admin.get('/reports/top_products?period=today')).body.rows;
    expect(top.map((r: any) => r.product)).toEqual(['Paracetamol', 'Vitamin C']);
    expect(top[0]).toMatchObject({ rank: 1, sold: '15.0000', revenue: '29.5000' });
    const pm = (await admin.get('/reports/payment_methods?period=today')).body.rows;
    expect(pm).toHaveLength(1); expect(pm[0]).toMatchObject({ payments: 3, amount: '49.5000', share: '100.00' });
    const emp = (await admin.get('/reports/cashier_performance?period=today')).body.rows;
    expect(emp.map((r: any) => [r.employee, r.sales])).toEqual(expect.arrayContaining([['cashier', 2], ['disp', 1]]));
    const disc = (await admin.get('/reports/discount_analysis?period=today')).body.rows;
    expect(disc.find((r: any) => r.employee === 'cashier')).toMatchObject({ sales: 2, discounted: 1, discounts: '0.5000' });
    const by = (await admin.get('/reports/branch_comparison?period=today')).body.rows;
    expect(by).toEqual([expect.objectContaining({ branch: 'Main Dispenser', sales: 3, total: '49.5000' })]);
    // yesterday has nothing; a custom range that includes today has everything
    expect((await admin.get('/reports/sales_by_day?period=yesterday')).body.rows).toHaveLength(0);
    const to = day(1);
    expect((await admin.get(`/reports/sales_by_day?from=${day(-3)}&to=${to}`)).body.totals.sales).toBe(3);
  });

  it('shows profit only to people who may see costs', async () => {
    const p = (await admin.get('/reports/product_profitability?period=today')).body;
    expect(p.totals).toMatchObject({ revenue: '49.5000', cost: '35.0000', profit: '14.5000' });
    expect(p.rows[0].margin).toBeDefined();
    expect((await salesMgr.get('/reports/product_profitability?period=today')).status).toBe(403);
    const v = (await salesMgr.get('/reports/stock_valuation')).body;
    expect(v.columns.map((c: any) => c.key)).not.toContain('value'); // salesMgr has no finance.read
    expect(v.rows[0].value).toBeUndefined();
    const full = (await admin.get('/reports/stock_valuation')).body;
    expect(full.totals).toMatchObject({ quantity: '113.0000', value: '113.0000' });
  });

  it('reports stock health: expiry buckets, slow movers and cover', async () => {
    const ex = (await admin.get('/reports/expiry_exposure')).body.rows;
    expect(ex.find((r: any) => r.bucket === 'Within 30 days')).toMatchObject({ batches: 1, quantity: '8.0000', value: '8.0000' });
    expect(ex.find((r: any) => r.bucket === 'More than 180 days')).toMatchObject({ batches: 2, quantity: '105.0000' });
    const slow = (await admin.get('/reports/slow_movers?period=today')).body.rows;
    expect(slow[0]).toMatchObject({ product: 'Zinc', sold: '0.0000', on_hand: '8.0000' });
    const to = (await admin.get('/reports/stock_turnover?period=today')).body.rows;
    const p = to.find((r: any) => r.product === 'Paracetamol');
    expect(p).toMatchObject({ sold: '15.0000', on_hand: '85.0000', days_of_cover: '5.7' });
    expect((await admin.get('/reports/supplier_performance?period=this_year')).body.rows).toEqual([]);
  });

  it('keeps each manager to their own branches and the right permissions', async () => {
    expect((await mgrA.get('/reports/sales_by_day?period=today')).body.totals.sales).toBe(3);
    expect((await mgrB.get('/reports/sales_by_day?period=today')).body.rows).toEqual([]);
    expect((await mgrB.get(`/reports/sales_by_day?period=today&branchId=${A.id}`)).status).toBe(403);
    expect((await cashier.get('/reports/sales_by_day?period=today')).status).toBe(200); // cashiers have sales.read
    expect((await cashier.get('/reports/expiry_exposure')).status).toBe(403);
    expect((await cashier.get('/reports').then((r) => r.body.map((x: any) => x.code)))).not.toContain('expiry_exposure');
    expect((await admin.get('/reports/nothing')).status).toBe(404);
    expect((await admin.get('/reports/sales_by_day?period=sometime')).status).toBe(400);
    expect((await admin.get('/reports/sales_by_day?period=custom')).body.code).toBe('PERIOD_REQUIRED');
  });

  it('exports Excel, PDF and CSV', async () => {
    const bin = (c: Client, url: string) => (c as any).raw ? (c as any).raw(url) : null;
    void bin;
    const x = await admin.get('/reports/sales_by_day/export?period=today&format=xlsx').buffer(true).parse((res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(x.status).toBe(200); expect(x.headers['content-disposition']).toContain('sales_by_day_');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(4).getCell(1).value).toBe('Date');
    expect(ws.getRow(5).getCell(2).value).toBe(3);
    expect(ws.getRow(5).getCell(6).value).toBe(49.5);
    expect(ws.getRow(6).getCell(1).value).toBe('Total');
    const pdf = await admin.get('/reports/top_products/export?period=today&format=pdf').buffer(true).parse((res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(pdf.status).toBe(200); expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const csv = await admin.get('/reports/payment_methods/export?period=today&format=csv');
    expect(csv.status).toBe(200); expect(csv.text).toContain('Method,Payments,Amount,Share');
    expect((await cashier.get('/reports/expiry_exposure/export?format=pdf')).status).toBe(403);
    expect((await admin.get('/reports/sales_by_day/export?period=today&format=docx')).status).toBe(400);
  });

  it('builds a dashboard for each role and refuses the ones a person may not open', async () => {
    const ceo = (await admin.get('/dashboards/ceo?period=today')).body;
    const tile = (d: any, k: string) => d.tiles.find((t: any) => t.key === k)?.value;
    expect(tile(ceo, 'net_sales')).toBe('49.5000'); expect(tile(ceo, 'sales')).toBe(3); expect(tile(ceo, 'gross_profit')).toBe('14.5000'); expect(tile(ceo, 'margin')).toBe(29.29);
    expect(tile(ceo, 'expiry_risk')).toBe('8.0000');
    expect(ceo.tables.map((t: any) => t.code)).toEqual(['branch_comparison', 'top_products', 'payment_methods']);
    const pm = (await mgr.get('/dashboards/pharmacy_manager?period=today')).body;
    expect(pm.tiles.map((t: any) => t.key)).toEqual(expect.arrayContaining(['net_sales', 'low_stock', 'pending_approvals', 'sync_conflicts']));
    const sc = (await admin.get('/dashboards/supply_chain')).body;
    expect(tile(sc, 'open_orders')).toBe(0);
    const me = (await cashier.get('/dashboards/dispenser')).body;
    expect(tile(me, 'my_sales_today')).toBe(2); expect(tile(me, 'my_total_today')).toBe('29.5000');
    expect((await cashier.get('/dashboards/ceo')).status).toBe(403);
    expect((await admin.get('/dashboards/nobody')).status).toBe(404);
    expect((await cashier.get('/dashboards')).body.map((x: any) => x.role)).toEqual(['dispenser']);
    expect((await salesMgr.get('/dashboards/sales_manager?period=this_month')).body.tables.map((t: any) => t.code)).toEqual(['sales_by_day', 'top_products', 'cashier_performance', 'discount_analysis']);
  });
});
