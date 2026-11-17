import { randomUUID } from 'crypto';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
type Client = ReturnType<typeof authed>;

describe('Finance: ledger, expenses, registers and reports', () => {
  let ctx: TestCtx;
  let admin: Client, mgr: Client, keeper: Client, cashier: Client, accountant: Client, mgrB: Client;
  let U: Record<string, string>;
  let A: any, B: any, whA: any, R1: any, para: any, acc: Record<string, string>;

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
    R1 = (await admin.post('/cash-registers', { branchId: A.id, code: 'R1', name: 'Counter 1' })).body;
    const vat = (await admin.post('/tax-categories', { name: 'VAT' })).body;
    await admin.post('/tax-rules', { taxCategoryId: vat.id, taxCode: 'VAT', name: 'VAT', rate: '15', isInclusive: false, effectiveFrom: '2020-01-01' });
    para = (await admin.post('/products', { name: 'Paracetamol', baseUnitId: U.tablet, taxCategoryId: vat.id, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '2.6' }] })).body;
    keeper = await userWith('keeper', 'Storekeeper');
    mgr = await userWith('mgr', 'Pharmacy Manager');
    cashier = await userWith('cashier', 'Cashier', A.id);
    accountant = await userWith('acct', 'Accountant');
    mgrB = await userWith('mgrb', 'Branch Manager', B.id);
    acc = Object.fromEntries((await admin.get('/finance/accounts')).body.map((a: any) => [a.code, a.id]));
    await stockIn(100, '1.5');
  });

  async function stockIn(qty: number, cost: string) {
    const r = await keeper.post('/inventory/adjustments', { warehouseId: whA.id, reasonCode: 'opening_balance', reason: 'Opening stock', items: [{ productId: para.id, quantity: String(qty), direction: 'increase', newBatch: { batchRef: `B${Math.random()}`.slice(0, 8), expiryDate: day(400), unitCost: cost } }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
  }
  const sell = (client: Client, qty: string, payments: any[], extra: object = {}) => client.post('/sales', { registerId: R1.id, idempotencyKey: randomUUID(), items: [{ productId: para.id, quantity: qty }], payments, ...extra });
  const bal = async (code: string, q: object = {}) => {
    const tb = (await admin.get('/finance/reports/trial-balance').query(q)).body;
    return tb.lines.find((l: any) => l.code === code)?.closing ?? '0.0000';
  };
  const reconcile = async () => (await admin.get('/finance/reconcile')).body;

  it('has a chart of accounts and posting accounts ready, and lets administrators change them', async () => {
    expect(Object.keys(acc)).toEqual(expect.arrayContaining(['1010', '1200', '2100', '4000', '5000']));
    const maps = (await admin.get('/finance/account-mappings')).body;
    expect(maps.find((m: any) => m.key === 'inventory').account_code).toBe('1200');
    const created = await admin.post('/finance/accounts', { code: '1021', name: 'CBE account', type: 'asset' });
    expect(created.status).toBe(201);
    expect((await admin.post('/finance/accounts', { code: '1021', name: 'dup', type: 'asset' })).body.code).toBe('ACCOUNT_CODE_EXISTS');
    expect((await admin.put('/finance/account-mappings/payment.card', { accountId: created.body.id })).status).toBe(200);
    expect((await admin.patch(`/finance/accounts/${acc['1010']}`, { version: 1, isActive: false })).body.code).toBe('SYSTEM_ACCOUNT');
    expect((await admin.patch(`/finance/accounts/${created.body.id}`, { version: 1, isActive: false })).body.code).toBe('ACCOUNT_IN_USE');
    expect((await cashier.get('/finance/accounts')).status).toBe(403);
  });

  it('books opening stock and keeps inventory in the books equal to stock on hand', async () => {
    expect(await bal('1200')).toBe('150.0000');
    expect(await bal('3100')).toBe('150.0000');
    const r = await reconcile();
    expect(r.ok).toBe(true);
    expect(r.checks[0]).toMatchObject({ books: '150.0000', subledger: '150.0000' });
    expect((await admin.get('/finance/reports/trial-balance')).body.balanced).toBe(true);
  });

  it('books a sale as cash, revenue, tax and cost of goods, and shows it in the statements', async () => {
    const s = await sell(cashier, '15', [{ methodCode: 'cash', amount: '44.85' }]);
    expect(s.status).toBe(201);
    expect(await bal('1010')).toBe('44.8500');
    expect(await bal('4000')).toBe('39.0000');
    expect(await bal('2100')).toBe('5.8500');
    expect(await bal('5000')).toBe('22.5000');
    expect(await bal('1200')).toBe('127.5000');
    const is = (await admin.get('/finance/reports/income-statement')).body;
    expect(is).toMatchObject({ totalRevenue: '39.0000', totalCostOfGoodsSold: '22.5000', grossProfit: '16.5000', netOperatingProfit: '16.5000' });
    expect((await admin.get('/finance/reports/tax-summary')).body).toMatchObject({ collectedOnSales: '5.8500', paidOnPurchases: '0.0000', netPayable: '5.8500' });
    const bs = (await admin.get('/finance/reports/balance-sheet')).body;
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe('172.3500'); // cash 44.85 + inventory 127.50
    const entry = (await admin.get(`/finance/journal?sourceType=sale&sourceId=${s.body.id}`)).body;
    expect(entry.items.map((e: any) => e.event_code).sort()).toEqual(['sale.revenue', 'stock.sale']);
    const full = (await admin.get(`/finance/journal/${entry.items[0].id}`)).body;
    expect(full.lines.length).toBeGreaterThanOrEqual(2);
    expect((await reconcile()).ok).toBe(true);
  });

  it('puts credit sales on the receivable account and clears them with customer payments', async () => {
    const c = (await mgr.post('/customers', { name: 'Abebe', creditLimit: '500' })).body;
    expect((await sell(mgr, '10', [{ methodCode: 'credit', amount: '29.9' }], { customerId: c.id })).status).toBe(201);
    expect(await bal('1100')).toBe('29.9000');
    const pay = await mgr.post(`/customers/${c.id}/payments`, { branchId: A.id, methodCode: 'cash', amount: '20' });
    expect(pay.status).toBe(201);
    expect(await bal('1100')).toBe('9.9000');
    expect(await bal('1010')).toBe('20.0000');
    expect((await mgr.post(`/customer-payments/${pay.body.id}/reverse`, { reason: 'Wrong customer' })).status).toBe(200);
    expect(await bal('1100')).toBe('29.9000');
    expect(await bal('1010')).toBe('0.0000');
    expect((await reconcile()).ok).toBe(true);
  });

  it('reverses the books when a sale is cancelled, keeping both sets of entries', async () => {
    const s = await sell(cashier, '15', [{ methodCode: 'cash', amount: '44.85' }]);
    const c = await mgr.post(`/sales/${s.body.id}/cancel`, { reason: 'Customer changed mind' });
    expect(c.status).toBe(200);
    expect(await bal('4000')).toBe('39.0000'); // nothing changes until a second person approves
    const pending = (await admin.get('/approvals')).body.find((a: any) => a.action_code === 'sales.cancel');
    expect((await admin.post(`/approvals/${pending.id}/approve`, {})).status).toBe(200);
    for (const code of ['1010', '4000', '2100', '5000']) expect(await bal(code)).toBe('0.0000');
    expect(await bal('1200')).toBe('150.0000');
    const entries = (await admin.get(`/finance/journal?sourceType=sale&sourceId=${s.body.id}`)).body.items;
    expect(entries.map((e: any) => e.event_code).sort()).toEqual(['sale.revenue', 'sale.revenue.reversal', 'stock.sale']);
    expect(entries.filter((e: any) => e.is_reversed).length).toBe(1);
    expect((await admin.get('/finance/journal?sourceType=sale_cancellation')).body.items[0].event_code).toBe('stock.correction'); // stock put back at cost
    expect((await reconcile()).ok).toBe(true);
  });

  it('books a customer return as sales returns, tax back and stock back at cost', async () => {
    const s = (await sell(cashier, '15', [{ methodCode: 'cash', amount: '44.85' }])).body;
    const item = (await mgr.get(`/sales/${s.id}`)).body.items[0];
    const r = await cashier.post('/sales-returns', { saleId: s.id, reason: 'Wrong item', refundMethodCode: 'cash', items: [{ saleItemId: item.id, quantity: '5' }] });
    expect(r.status).toBe(201);
    expect((await mgr.post(`/approvals/${r.body.approval_id}/approve`, {})).status).toBe(200);
    // 5 of 15 tablets: 13.00 net + 1.95 tax = 14.95 back to the customer; cost 7.50 back into stock
    expect(await bal('4090')).toBe('-13.0000'); // a debit balance on a revenue account
    expect(await bal('2100')).toBe('3.9000');
    expect(await bal('1010')).toBe('29.9000');
    expect(await bal('5000')).toBe('15.0000');
    const is = (await admin.get('/finance/reports/income-statement')).body;
    expect(is).toMatchObject({ totalRevenue: '26.0000', totalCostOfGoodsSold: '15.0000', grossProfit: '11.0000' });
    expect((await reconcile()).ok).toBe(true);
  });

  it('records expenses, asks a second person to approve large ones, and reverses instead of deleting', async () => {
    const cats = (await accountant.get('/finance/expense-categories')).body;
    const rent = cats.find((c: any) => c.code === 'rent');
    const small = await accountant.post('/finance/expenses', { branchId: A.id, categoryId: rent.id, amount: '1000', methodCode: 'cash', description: 'Cleaning' });
    expect(small.status).toBe(201);
    expect(small.body.status).toBe('posted');
    expect(await bal('6010')).toBe('1000.0000');
    const big = await accountant.post('/finance/expenses', { branchId: A.id, categoryId: rent.id, amount: '25000', methodCode: 'bank_transfer', description: 'Monthly rent', payee: 'Landlord' });
    expect(big.body.status).toBe('pending_approval');
    expect(await bal('6010')).toBe('1000.0000');
    expect((await accountant.post(`/approvals/${big.body.approval_id}/approve`, {})).status).toBe(403);
    expect((await mgr.post(`/approvals/${big.body.approval_id}/approve`, {})).status).toBe(200);
    expect(await bal('6010')).toBe('26000.0000');
    expect(await bal('1020')).toBe('-25000.0000');
    expect((await accountant.get(`/finance/expenses/${big.body.id}`)).body.status).toBe('posted');
    const rev = await accountant.post(`/finance/expenses/${small.body.id}/reverse`, { reason: 'Entered twice' });
    expect(rev.status).toBe(200);
    expect(await bal('6010')).toBe('25000.0000');
    expect((await accountant.post(`/finance/expenses/${small.body.id}/reverse`, { reason: 'again' })).body.code).toBe('EXPENSE_NOT_REVERSIBLE');
    expect((await cashier.post('/finance/expenses', { branchId: A.id, categoryId: rent.id, amount: '10', methodCode: 'cash', description: 'x' })).status).toBe(403);
    expect((await accountant.post('/finance/expenses', { branchId: A.id, categoryId: rent.id, amount: '10', methodCode: 'credit', description: 'xx' })).body.code).toBe('PAYMENT_METHOD_NOT_FOUND');
    const is = (await admin.get('/finance/reports/income-statement')).body;
    expect(is.totalOperatingExpenses).toBe('25000.0000');
    const inc = await accountant.post('/finance/incomes', { branchId: A.id, categoryId: (await accountant.get('/finance/income-categories')).body[0].id, amount: '300', methodCode: 'cash', description: 'Rent of fridge' });
    expect(inc.status).toBe(201);
    expect(await bal('4100')).toBe('300.0000');
    expect((await accountant.post(`/finance/incomes/${inc.body.id}/reverse`, { reason: 'Mistake' })).status).toBe(200);
    expect(await bal('4100')).toBe('0.0000');
  });

  it('refuses to post into a closed period and needs a reason to reopen it', async () => {
    const p = await accountant.post('/finance/periods', { name: 'This month', startDate: day(-15), endDate: day(15) });
    expect(p.status).toBe(201);
    expect((await accountant.post('/finance/periods', { name: 'Clash', startDate: day(10), endDate: day(40) })).body.code).toBe('OVERLAPPING_PERIOD');
    expect((await accountant.post(`/finance/periods/${p.body.id}/close`)).status).toBe(200);
    const s = await sell(cashier, '1', [{ methodCode: 'cash', amount: '2.99' }]);
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('PERIOD_CLOSED');
    expect((await reconcile()).ok).toBe(true);
    expect((await accountant.post(`/finance/periods/${p.body.id}/reopen`, { note: 'x' })).status).toBe(400);
    expect((await accountant.post(`/finance/periods/${p.body.id}/reopen`, { note: 'Late invoice found' })).status).toBe(200);
    expect((await sell(cashier, '1', [{ methodCode: 'cash', amount: '2.99' }])).status).toBe(201);
    const year = await accountant.post('/finance/periods/generate-year', { year: 2031 });
    expect(year.body.length).toBe(12);
  });

  it('posts manual journals only after a second person approves, and only if they balance', async () => {
    const lines = (d: string, c: string) => [{ account: acc['6900'], debit: d }, { account: acc['1010'], credit: c }];
    expect((await accountant.post('/finance/manual-journals', { description: 'Bad', lines: lines('10', '9') })).body.code).toBe('NOT_BALANCED');
    const m = await accountant.post('/finance/manual-journals', { description: 'Write off petty cash shortage', lines: lines('50', '50') });
    expect(m.status).toBe(201);
    expect(m.body.status).toBe('pending_approval');
    expect(await bal('6900')).toBe('0.0000');
    expect((await accountant.post(`/approvals/${m.body.approval_id}/approve`, {})).status).toBe(403);
    expect((await mgr.post(`/approvals/${m.body.approval_id}/approve`, {})).status).toBe(200);
    expect(await bal('6900')).toBe('50.0000');
    expect((await ctx.db.query(`select 1 from finance.journal_entries where event_code = 'manual'`)).rowCount).toBe(1);
  });

  it('cannot be edited behind the back: entries are immutable and must balance', async () => {
    await sell(cashier, '1', [{ methodCode: 'cash', amount: '2.99' }]);
    await expect(ctx.db.query(`update finance.journal_lines set debit = debit + 1`)).rejects.toThrow();
    await expect(ctx.db.query(`delete from finance.journal_entries`)).rejects.toThrow();
    const e = (await ctx.db.query(`insert into finance.journal_entries (entry_no, entry_date, event_code, description) values ('X', current_date, 'test', 'x') returning id`)).rows[0];
    await expect(ctx.db.query(`insert into finance.journal_lines (entry_id, line_no, account_id, debit) values ($1, 1, $2, 5)`, [e.id, acc['1010']])).rejects.toThrow(/not balanced/);
  });

  it('runs a cashier shift: expected cash, count, difference posted, and one open session per register', async () => {
    const o = await cashier.post('/finance/register-sessions', { registerId: R1.id, openingAmount: '100' });
    expect(o.status).toBe(201);
    expect((await cashier.post('/finance/register-sessions', { registerId: R1.id, openingAmount: '5' })).body.code).toBe('SESSION_ALREADY_OPEN');
    await sell(cashier, '15', [{ methodCode: 'cash', amount: '44.85' }]);
    const rent = (await accountant.get('/finance/expense-categories')).body.find((c: any) => c.code === 'transport');
    expect((await accountant.post('/finance/expenses', { branchId: A.id, categoryId: rent.id, amount: '30', methodCode: 'cash', description: 'Taxi', registerId: R1.id })).status).toBe(201);
    const cur = (await cashier.get(`/finance/register-sessions/current/${R1.id}`)).body;
    expect(cur.expected_amount).toBe('114.8500'); // 100 + 44.85 - 30
    expect((await cashier.post(`/finance/register-sessions/${o.body.id}/close`, { countedAmount: '110.85' })).body.code).toBe('VARIANCE_NOTE_REQUIRED');
    const closed = await cashier.post(`/finance/register-sessions/${o.body.id}/close`, { countedAmount: '110.85', note: 'Change given wrongly' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', expected_amount: '114.8500', variance: '-4.0000' });
    expect(await bal('6950')).toBe('4.0000');
    expect((await cashier.post(`/finance/register-sessions/${o.body.id}/close`, { countedAmount: '1' })).body.code).toBe('SESSION_CLOSED');
    const v = (await mgr.get('/finance/register-sessions?withVariance=true')).body;
    expect(v.total).toBe(1);
    const dc = (await mgr.get(`/finance/reports/daily-closing?branchId=${A.id}&date=${(await ctx.db.query(`select business_date::text d from finance.register_sessions`)).rows[0].d}`)).body;
    expect(dc.salesByMethod[0]).toMatchObject({ method_code: 'cash', amount: '44.8500' });
    expect(dc.openSessions).toBe(0);
    expect(dc.totalVariance).toBe('-4.0000');
  });

  it('can require an open session before selling, but never blocks a synced offline sale', async () => {
    await admin.put('/settings/finance.require_open_register_session', { value: true });
    const blocked = await sell(cashier, '1', [{ methodCode: 'cash', amount: '2.99' }]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('NO_OPEN_SESSION');
    await cashier.post('/finance/register-sessions', { registerId: R1.id, openingAmount: '0' });
    expect((await sell(cashier, '1', [{ methodCode: 'cash', amount: '2.99' }])).status).toBe(201);
  });

  it('limits each branch to its own books', async () => {
    await sell(cashier, '15', [{ methodCode: 'cash', amount: '44.85' }]);
    const b = (await mgrB.get('/finance/reports/trial-balance')).body;
    expect(b.lines).toEqual([]);
    expect((await mgrB.get(`/finance/reports/income-statement?branchId=${A.id}`)).status).toBe(403);
    expect((await mgrB.get('/finance/journal')).body.total).toBe(0);
    const perf = (await admin.get('/finance/reports/branch-performance')).body;
    expect(perf.find((p: any) => p.branch_name === 'Main Dispenser')).toMatchObject({ revenue: '39.0000', cogs: '22.5000', grossProfit: '16.5000' });
    const gl = (await admin.get(`/finance/reports/general-ledger/${acc['1010']}`)).body;
    expect(gl.closing).toBe('44.8500');
    const cf = (await admin.get('/finance/reports/cash-flow')).body;
    expect(cf).toMatchObject({ totalInflow: '44.8500', closing: '44.8500' });
  });
});
