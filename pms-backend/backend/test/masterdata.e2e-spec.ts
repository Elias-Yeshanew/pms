import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

describe('Tax, facilities and suppliers', () => {
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

  async function userWith(username: string, role: string | { perms: string[] }, branchId?: string) {
    const rid = typeof role === 'string' ? await roleId(ctx, role) : (await admin.post('/roles', { name: `r-${username}`, permissions: role.perms })).body.id;
    await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: rid, branchId }] });
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  describe('tax', () => {
    async function vat() {
      const cat = (await admin.post('/tax-categories', { name: 'Standard' })).body;
      const rule = (await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'VAT', name: 'VAT', rate: '15', isInclusive: false, effectiveFrom: '2026-01-01' })).body;
      return { cat, rule };
    }

    it('creates categories and rules, and calculates tax exactly', async () => {
      const { cat, rule } = await vat();
      expect(rule.rate).toBe('15.0000');
      const calc = await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '19.99', date: '2026-06-01' });
      expect(calc.status).toBe(200);
      expect(calc.body).toMatchObject({ net: '19.9900', tax: '3.0000', gross: '22.9900' });
      expect(calc.body.rule).toMatchObject({ taxCode: 'VAT', inclusive: false });
      expect((await admin.post('/tax-categories', { name: 'standard' })).status).toBe(409); // names are case-insensitive unique
    });

    it('uses the rule default from settings for inclusive pricing, and handles inclusive amounts', async () => {
      await admin.put('/settings/tax.prices_include_tax', { value: true });
      const cat = (await admin.post('/tax-categories', { name: 'Inclusive' })).body;
      const rule = (await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'VAT', name: 'VAT', rate: '15', effectiveFrom: '2026-01-01' })).body;
      expect(rule.is_inclusive).toBe(true);
      const calc = await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '115', date: '2026-02-01' });
      expect(calc.body).toMatchObject({ net: '100.0000', tax: '15.0000', gross: '115.0000' });
    });

    it('refuses overlapping rules for the same category and bad input', async () => {
      const { cat } = await vat();
      const overlap = await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'VAT2', name: 'Other', rate: '10', effectiveFrom: '2026-06-01' });
      expect(overlap.status).toBe(409);
      expect(overlap.body.code).toBe('OVERLAPPING_PERIOD');
      expect((await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'X', name: 'x', rate: '120', effectiveFrom: '2027-01-01' })).body.code).toBe('INVALID_RATE');
      expect((await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'X', name: 'x', rate: '5', effectiveFrom: '2027-01-01', effectiveTo: '2026-01-01' })).body.code).toBe('INVALID_PERIOD');
      expect((await admin.post('/tax-rules', { taxCategoryId: cat.id, taxCode: 'x', name: 'x', rate: '5', effectiveFrom: 'not-a-date' })).status).toBe(400);
    });

    it('supersedes a rule so that old dates keep the old rate and new dates get the new one', async () => {
      const { cat, rule } = await vat();
      const next = await admin.post(`/tax-rules/${rule.id}/supersede`, { rate: '17.5', effectiveFrom: '2027-01-01' });
      expect(next.status).toBe(201);
      const rules = (await admin.get(`/tax-rules?taxCategoryId=${cat.id}`)).body;
      expect(rules).toHaveLength(2);
      const old = rules.find((r: any) => r.id === rule.id);
      expect(String(old.effective_to).slice(0, 10)).toBe('2026-12-31');
      expect((await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '100', date: '2026-12-31' })).body.tax).toBe('15.0000');
      expect((await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '100', date: '2027-01-01' })).body.tax).toBe('17.5000');
      expect((await admin.post(`/tax-rules/${rule.id}/supersede`, { rate: '5', effectiveFrom: '2025-01-01' })).body.code).toBe('SUPERSEDE_DATE_TOO_EARLY');
    });

    it('never calculates silently with no rule, and never edits a rate in place', async () => {
      const { cat, rule } = await vat();
      const none = await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '10', date: '2025-06-01' });
      expect(none.status).toBe(409);
      expect(none.body.code).toBe('NO_TAX_RULE');
      expect((await admin.post('/tax/calculate', { taxCategoryId: '00000000-0000-4000-8000-000000000000', amount: '10' })).status).toBe(404);
      const edit = await admin.patch(`/tax-rules/${rule.id}`, { version: rule.version, rate: '99' });
      expect(edit.status).toBe(400); // rate is not an editable field
      const ended = await admin.patch(`/tax-rules/${rule.id}`, { version: rule.version, effectiveTo: '2026-12-31' });
      expect(ended.status).toBe(200);
      expect((await admin.post('/tax/calculate', { taxCategoryId: cat.id, amount: '10', date: '2027-02-01' })).body.code).toBe('NO_TAX_RULE');
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action like 'tax_rule.%'`)).rowCount).toBe(2);
    });

    it('needs tax permissions', async () => {
      const cashier = await userWith('cash', 'Cashier');
      expect((await cashier.get('/tax-categories')).status).toBe(403);
      const accountant = await userWith('acct', 'Accountant');
      expect((await accountant.get('/tax-categories')).status).toBe(200);
      expect((await accountant.post('/tax-categories', { name: 'Nope' })).status).toBe(403);
    });
  });

  describe('warehouses, storage locations and cash registers', () => {
    it('manages the physical structure of a branch', async () => {
      const wh = (await admin.post('/warehouses', { branchId: branchA.id, code: 'BACK', name: 'Back store' })).body;
      expect(wh).toMatchObject({ code: 'BACK', status: 'active' });
      expect((await admin.post('/warehouses', { branchId: branchA.id, code: 'BACK', name: 'Dup' })).body.code).toBe('DUPLICATE_VALUE');
      expect((await admin.post('/warehouses', { branchId: branchB.id, code: 'BACK', name: 'Same code, other branch' })).status).toBe(201);

      const loc = (await admin.post('/storage-locations', { warehouseId: wh.id, code: 'FR-1', name: 'Fridge 1', temperatureZone: 'cold' })).body;
      expect(loc.temperature_zone).toBe('cold');
      expect((await admin.post('/storage-locations', { warehouseId: wh.id, code: 'X', name: 'x', temperatureZone: 'warm' })).status).toBe(400);
      expect((await admin.get(`/storage-locations?warehouseId=${wh.id}`)).body).toHaveLength(1);
      expect((await admin.patch(`/storage-locations/${loc.id}`, { version: loc.version, status: 'inactive' })).body.status).toBe('inactive');

      const reg = (await admin.post('/cash-registers', { branchId: branchA.id, code: 'R1', name: 'Counter 1', offlineMode: 'hybrid' })).body;
      expect(reg.offline_mode).toBe('hybrid');
      expect((await admin.patch(`/cash-registers/${reg.id}`, { version: reg.version, name: 'Front counter' })).body.name).toBe('Front counter');
      expect((await admin.patch(`/cash-registers/${reg.id}`, { version: reg.version, name: 'stale' })).body.code).toBe('VERSION_CONFLICT');
      expect((await admin.post('/cash-registers', { branchId: branchA.id, code: 'R2', name: 'x', offlineMode: 'sometimes' })).status).toBe(400);
    });

    it('keeps each branch to its own warehouses, locations and registers', async () => {
      const whA = (await admin.post('/warehouses', { branchId: branchA.id, code: 'W', name: 'A store' })).body;
      const whB = (await admin.post('/warehouses', { branchId: branchB.id, code: 'W', name: 'B store' })).body;
      const regB = (await admin.post('/cash-registers', { branchId: branchB.id, code: 'R1', name: 'B counter' })).body;
      const locB = (await admin.post('/storage-locations', { warehouseId: whB.id, code: 'S1', name: 'Shelf' })).body;

      const mgr = await userWith('mgr.a', { perms: ['warehouses.read', 'warehouses.manage', 'registers.read', 'registers.manage'] }, branchA.id);
      expect((await mgr.get('/warehouses')).body.map((w: any) => w.id)).toEqual([whA.id]);
      expect((await mgr.get('/cash-registers')).body).toHaveLength(0);
      expect((await mgr.get(`/storage-locations?warehouseId=${whB.id}`)).status).toBe(404);
      expect((await mgr.post('/warehouses', { branchId: branchB.id, code: 'Z', name: 'no' })).status).toBe(403);
      expect((await mgr.patch(`/warehouses/${whB.id}`, { version: 1, name: 'hijack' })).status).toBe(404);
      expect((await mgr.patch(`/storage-locations/${locB.id}`, { version: 1, name: 'hijack' })).status).toBe(404);
      expect((await mgr.patch(`/cash-registers/${regB.id}`, { version: 1, name: 'hijack' })).status).toBe(404);
      expect((await mgr.post('/storage-locations', { warehouseId: whB.id, code: 'Z', name: 'no' })).status).toBe(404);
      expect((await mgr.post('/warehouses', { branchId: branchA.id, code: 'OK', name: 'fine' })).status).toBe(201);
    });
  });

  describe('suppliers', () => {
    it('creates suppliers with generated or explicit codes and validates the data', async () => {
      const a = (await admin.post('/suppliers', { name: 'EPSA Depot', paymentTermsDays: 30, creditLimit: '250000.50', email: 'sales@epsa.test' })).body;
      expect(a.code).toBe('SUP-000001');
      expect(a).toMatchObject({ payment_terms_days: 30, credit_limit: '250000.5000', status: 'active' });
      const b = (await admin.post('/suppliers', { code: 'KILINTO', name: 'Kilinto Pharma' })).body;
      expect(b.code).toBe('KILINTO');
      expect((await admin.post('/suppliers', { code: 'KILINTO', name: 'Again' })).body.code).toBe('DUPLICATE_VALUE');
      expect((await admin.post('/suppliers', { name: 'Bad', creditLimit: '-5' })).status).toBe(400);
      expect((await admin.post('/suppliers', { name: 'Bad', creditLimit: '1.23456' })).status).toBe(400);
      expect((await admin.post('/suppliers', { name: 'Bad', email: 'nope' })).status).toBe(400);
      expect((await admin.post('/suppliers', { name: 'Bad', paymentTermsDays: 4000 })).status).toBe(400);
    });

    it('searches, updates with version checks and blocks suppliers', async () => {
      const a = (await admin.post('/suppliers', { name: 'Alpha Pharma' })).body;
      await admin.post('/suppliers', { name: 'Beta Medical' });
      const found = await admin.get('/suppliers?search=alpha');
      expect(found.body.total).toBe(1);
      expect((await admin.get('/suppliers?search=%25')).body.total).toBe(0); // wildcard characters are matched literally
      const upd = await admin.patch(`/suppliers/${a.id}`, { version: a.version, status: 'blocked', rating: '4.5' });
      expect(upd.body).toMatchObject({ status: 'blocked', rating: '4.50', version: 2 });
      expect((await admin.patch(`/suppliers/${a.id}`, { version: 1, name: 'stale' })).body.code).toBe('VERSION_CONFLICT');
      expect((await admin.get('/suppliers?status=blocked')).body.total).toBe(1);
      expect((await admin.get('/suppliers/not-a-uuid')).status).toBe(400);
    });

    it('is limited by permission', async () => {
      const cashier = await userWith('cash', 'Cashier');
      expect((await cashier.get('/suppliers')).status).toBe(403);
      const supply = await userWith('supply', 'Supply Chain Manager');
      expect((await supply.post('/suppliers', { name: 'By supply chain' })).status).toBe(201);
      const store = await userWith('store', 'Storekeeper');
      expect((await store.get('/suppliers')).status).toBe(200);
      expect((await store.post('/suppliers', { name: 'Nope' })).status).toBe(403);
    });
  });
});
