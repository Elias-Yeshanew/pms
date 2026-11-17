import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';

describe('Product catalog', () => {
  let ctx: TestCtx;
  let admin: ReturnType<typeof authed>;
  let U: Record<string, string>; // unit code -> id

  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(async () => {
    await ctx.reset();
    await makeAdmin(ctx);
    admin = authed(ctx, await tokenFor(ctx, ADMIN.username, ADMIN.password));
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
  });

  async function userWith(username: string, role: string) {
    await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role) }] });
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    return authed(ctx, await tokenFor(ctx, username, GOOD_PASSWORD));
  }

  /** Paracetamol 500 mg: tablets, sold by the strip (10), box (100) or carton (1000). */
  async function paracetamol(extra: object = {}) {
    const res = await admin.post('/products', {
      name: 'Paracetamol', genericName: 'Paracetamol', brandName: 'Panadol', strength: '500 mg', baseUnitId: U.tablet,
      units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.box, factorToBase: '100' }, { unitId: U.carton, factorToBase: '1000' }],
      barcodes: [{ unitId: U.strip, barcode: '6001234500011' }, { unitId: U.box, barcode: '6001234500028' }],
      prices: [{ unitId: U.strip, priceType: 'selling', amount: '25.5' }, { unitId: U.strip, priceType: 'purchase', amount: '18' }],
      minStock: '100', reorderLevel: '200', maxStock: '5000', ...extra,
    });
    return res;
  }

  describe('reference data', () => {
    it('comes with pharmacy units and dosage forms, and lets administrators add more', async () => {
      expect(Object.keys(U)).toEqual(expect.arrayContaining(['tablet', 'strip', 'box', 'carton', 'bottle', 'vial']));
      expect((await admin.get('/dosage-forms')).body.map((f: any) => f.name)).toEqual(expect.arrayContaining(['Tablet', 'Syrup', 'Injection']));
      const unit = (await admin.post('/units', { code: 'jar', name: 'Jar' })).body;
      expect(unit.is_active).toBe(true);
      expect((await admin.post('/units', { code: 'jar', name: 'Dup' })).body.code).toBe('DUPLICATE_VALUE');
      expect((await admin.post('/units', { code: 'Bad Code', name: 'x' })).status).toBe(400);
      expect((await admin.patch(`/units/${unit.id}`, { version: unit.version, isActive: false })).body.is_active).toBe(false);
    });

    it('builds a category tree and refuses cycles', async () => {
      const a = (await admin.post('/categories', { name: 'Analgesics' })).body;
      const b = (await admin.post('/categories', { name: 'Opioids', parentId: a.id })).body;
      const c = (await admin.post('/categories', { name: 'Weak opioids', parentId: b.id })).body;
      expect((await admin.post('/categories', { name: 'Opioids', parentId: a.id })).body.code).toBe('DUPLICATE_VALUE');
      expect((await admin.post('/categories', { name: 'Opioids' })).status).toBe(201); // same name under a different parent is fine
      expect((await admin.patch(`/categories/${a.id}`, { version: a.version, parentId: c.id })).body.code).toBe('CATEGORY_CYCLE');
      expect((await admin.patch(`/categories/${a.id}`, { version: a.version, parentId: a.id })).body.code).toBe('CATEGORY_CYCLE');
      expect((await admin.post('/categories', { name: 'x', parentId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('PARENT_NOT_FOUND');
    });

    it('keeps manufacturer names unique regardless of case', async () => {
      const m = (await admin.post('/manufacturers', { name: 'Julphar', country: 'UAE' })).body;
      expect((await admin.post('/manufacturers', { name: 'JULPHAR' })).body.code).toBe('DUPLICATE_VALUE');
      expect((await admin.patch(`/manufacturers/${m.id}`, { version: m.version, status: 'inactive' })).body.status).toBe('inactive');
    });
  });

  describe('registering products', () => {
    it('registers a product with pack sizes, barcodes, prices and a generated SKU', async () => {
      const res = await paracetamol();
      expect(res.status).toBe(201);
      const p = res.body;
      expect(p.sku).toBe('PRD-000001');
      expect(p.units.map((u: any) => [u.code, u.factor_to_base])).toEqual([['tablet', '1.0000'], ['strip', '10.0000'], ['box', '100.0000'], ['carton', '1000.0000']]);
      expect(p.barcodes).toHaveLength(2);
      expect(p.barcodes.find((b: any) => b.is_primary).barcode).toBe('6001234500011'); // the first barcode becomes primary
      expect(p.prices.map((x: any) => [x.price_type, x.amount]).sort()).toEqual([['purchase', '18.0000'], ['selling', '25.5000']]);
      expect(p.base_unit_code).toBe('tablet');
      expect(p.min_stock).toBe('100.0000');
      expect((await admin.post('/products', { name: 'Amoxicillin', baseUnitId: U.capsule })).body.sku).toBe('PRD-000002');
      expect((await admin.post('/products', { sku: 'CUSTOM-1', name: 'Ibuprofen', baseUnitId: U.tablet })).body.sku).toBe('CUSTOM-1');
      expect((await admin.post('/products', { sku: 'CUSTOM-1', name: 'Other', baseUnitId: U.tablet })).body.code).toBe('DUPLICATE_VALUE');
    });

    it('warns about likely duplicates and lets the user confirm', async () => {
      const form = (await admin.get('/dosage-forms')).body.find((f: any) => f.name === 'Tablet').id;
      const first = await admin.post('/products', { name: 'Paracetamol', strength: '500 mg', dosageFormId: form, baseUnitId: U.tablet });
      expect(first.status).toBe(201);
      const dup = await admin.post('/products', { name: '  PARACETAMOL ', strength: '500 MG', dosageFormId: form, baseUnitId: U.tablet });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
      expect(dup.body.details.matches[0]).toMatchObject({ sku: first.body.sku });
      expect((await admin.post('/products', { name: 'Paracetamol', strength: '1 g', dosageFormId: form, baseUnitId: U.tablet })).status).toBe(201);
      expect((await admin.post('/products', { name: 'Paracetamol', strength: '500 mg', dosageFormId: form, baseUnitId: U.tablet, confirmDuplicate: true })).status).toBe(201);
    });

    it('rejects inconsistent pack, barcode, price and stock-level data', async () => {
      const base = { name: 'Test', baseUnitId: U.tablet };
      expect((await admin.post('/products', { ...base, units: [{ unitId: U.tablet, factorToBase: '2' }] })).body.code).toBe('BASE_UNIT_FACTOR');
      expect((await admin.post('/products', { ...base, units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.strip, factorToBase: '12' }] })).body.code).toBe('DUPLICATE_UNIT');
      expect((await admin.post('/products', { ...base, units: [{ unitId: U.strip, factorToBase: '0' }] })).body.code).toBe('INVALID_FACTOR');
      expect((await admin.post('/products', { ...base, barcodes: [{ unitId: U.box, barcode: '1234567890' }] })).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await admin.post('/products', { ...base, prices: [{ unitId: U.box, priceType: 'selling', amount: '5' }] })).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await admin.post('/products', { ...base, minStock: '500', reorderLevel: '100', maxStock: '1000' })).body.code).toBe('INVALID_STOCK_LEVELS');
      expect((await admin.post('/products', { ...base, categoryId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('CATEGORY_NOT_FOUND');
      expect((await admin.post('/products', { ...base, baseUnitId: '00000000-0000-4000-8000-000000000000' })).body.code).toBe('UNIT_NOT_FOUND');
      expect((await admin.post('/products', { ...base, minStock: '1.23456' })).status).toBe(400);
      expect((await admin.post('/products', { ...base, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '-1' }] })).status).toBe(400);
      expect((await ctx.db.query(`select count(*)::int as n from catalog.products`)).rows[0].n).toBe(0); // nothing half-created
    });

    it('is restricted by permission, and price-setting needs its own permission', async () => {
      const dispenser = await userWith('disp', 'Dispenser / Sales Staff');
      expect((await dispenser.get('/products')).status).toBe(200);
      expect((await dispenser.post('/products', { name: 'Nope', baseUnitId: U.tablet })).status).toBe(403);
      const storekeeper = await userWith('store', 'Storekeeper');
      expect((await storekeeper.post('/products', { name: 'Nope', baseUnitId: U.tablet })).status).toBe(403);
      await admin.post('/roles', { name: 'Registrar', permissions: ['products.read', 'products.create'] });
      await admin.post('/users', { username: 'registrar', password: GOOD_PASSWORD, roles: [{ roleId: (await admin.get('/roles')).body.find((r: any) => r.name === 'Registrar').id }] });
      await ctx.db.query(`update iam.users set must_change_password = false where username = 'registrar'`);
      const registrar = authed(ctx, await tokenFor(ctx, 'registrar', GOOD_PASSWORD));
      expect((await registrar.post('/products', { name: 'No prices', baseUnitId: U.tablet })).status).toBe(201);
      const withPrices = await registrar.post('/products', { name: 'With prices', baseUnitId: U.tablet, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '5' }] });
      expect(withPrices.status).toBe(403);
      expect((await ctx.db.query(`select 1 from catalog.products where name = 'With prices'`)).rowCount).toBe(0);
      const mgr = await userWith('pharm.mgr', 'Pharmacy Manager');
      expect((await mgr.post('/products', { name: 'Manager item', baseUnitId: U.tablet, prices: [{ unitId: U.tablet, priceType: 'selling', amount: '5' }] })).status).toBe(201);
    });
  });

  describe('editing products', () => {
    it('updates details with version checks and audits the change; the base unit is fixed', async () => {
      const p = (await paracetamol()).body;
      const upd = await admin.patch(`/products/${p.id}`, { version: p.version, requiresPrescription: true, registrationNo: 'EFDA/123' });
      expect(upd.status).toBe(200);
      expect(upd.body).toMatchObject({ requires_prescription: true, registration_no: 'EFDA/123', version: 2 });
      expect((await admin.patch(`/products/${p.id}`, { version: p.version, name: 'stale' })).body.code).toBe('VERSION_CONFLICT');
      expect((await admin.patch(`/products/${p.id}`, { version: 2, baseUnitId: U.capsule })).status).toBe(400);
      expect((await admin.patch(`/products/${p.id}`, { version: 2, minStock: '900' })).body.code).toBe('INVALID_STOCK_LEVELS'); // above the reorder level
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'product.updated' and entity_id = $1`, [p.id])).rowCount).toBe(1);
    });

    it('deactivates and reactivates instead of deleting', async () => {
      const p = (await paracetamol()).body;
      const off = await admin.post(`/products/${p.id}/deactivate`, { version: p.version });
      expect(off.body.is_active).toBe(false);
      expect((await admin.get('/products?isActive=true')).body.total).toBe(0);
      expect((await admin.get('/products?isActive=false')).body.total).toBe(1);
      expect((await admin.post(`/products/${p.id}/activate`, { version: off.body.version })).body.is_active).toBe(true);
    });
  });

  describe('pack sizes and conversion', () => {
    it('converts between packs exactly and refuses anything that would need rounding', async () => {
      const p = (await paracetamol()).body;
      const conv = (quantity: string, from: string, to: string) => admin.post(`/products/${p.id}/convert`, { quantity, fromUnitId: U[from], toUnitId: U[to] });
      expect((await conv('3', 'strip', 'tablet')).body.result).toBe('30.0000');
      expect((await conv('25', 'tablet', 'strip')).body.result).toBe('2.5000');
      expect((await conv('1', 'box', 'strip')).body.result).toBe('10.0000');
      expect((await conv('2', 'carton', 'box')).body.result).toBe('20.0000');
      expect((await conv('1', 'tablet', 'box')).body.result).toBe('0.0100'); // 1 tablet is 0.01 of a box
      const odd = await admin.post(`/products/${p.id}/convert`, { quantity: '1', fromUnitId: U.tablet, toUnitId: U.strip });
      expect(odd.body.result).toBe('0.1000');
      expect((await conv('1', 'tablet', 'vial')).body.code).toBe('UNIT_NOT_CONFIGURED');
      const third = (await admin.post('/products', { name: 'Odd pack', baseUnitId: U.tablet, units: [{ unitId: U.pack, factorToBase: '3' }] })).body;
      const inexact = await admin.post(`/products/${third.id}/convert`, { quantity: '1', fromUnitId: U.tablet, toUnitId: U.pack });
      expect(inexact.status).toBe(422);
      expect(inexact.body.code).toBe('NOT_EXACT');
    });

    it('changes pack sizes only while the product has no transactions', async () => {
      const p = (await paracetamol()).body;
      const removeBox = await admin.put(`/products/${p.id}/units`, { units: [{ unitId: U.strip, factorToBase: '10' }, { unitId: U.carton, factorToBase: '1000' }] });
      expect(removeBox.body.code).toBe('UNIT_HAS_BARCODES_OR_PRICES'); // the box still has a barcode
      const box = p.barcodes.find((b: any) => b.unit_id === U.box);
      await admin.del(`/products/${p.id}/barcodes/${box.id}`);
      const ok = await admin.put(`/products/${p.id}/units`, { units: [{ unitId: U.strip, factorToBase: '12' }, { unitId: U.carton, factorToBase: '1200' }] });
      expect(ok.status).toBe(200);
      expect(ok.body.units.map((u: any) => u.code)).toEqual(['tablet', 'strip', 'carton']);
      expect(ok.body.units.find((u: any) => u.code === 'strip').factor_to_base).toBe('12.0000');

      // Real stock arrives: a batch of this product now exists
      await ctx.db.query(`insert into inventory.stock_batches (product_id, batch_ref, expiry_date, unit_cost) values ($1, 'B1', current_date + 100, 1)`, [p.id]);
      try {
        const locked = await admin.put(`/products/${p.id}/units`, { units: [{ unitId: U.strip, factorToBase: '10' }] });
        expect(locked.status).toBe(409);
        expect(locked.body.code).toBe('PRODUCT_IN_USE');
      } finally {
        await ctx.db.query(`delete from inventory.stock_batches where product_id = $1`, [p.id]);
      }
    });
  });

  describe('barcodes', () => {
    it('keeps barcodes unique across all products and tracks the primary one', async () => {
      const p = (await paracetamol()).body;
      const other = (await admin.post('/products', { name: 'Other', baseUnitId: U.tablet })).body;
      const clash = await admin.post(`/products/${other.id}/barcodes`, { unitId: U.tablet, barcode: '6001234500011' });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('BARCODE_IN_USE');
      expect(clash.body.details.sku).toBe(p.sku);

      const added = (await admin.post(`/products/${p.id}/barcodes`, { unitId: U.carton, barcode: '6001234500035', isPrimary: true })).body;
      expect(added.barcodes.filter((b: any) => b.is_primary).map((b: any) => b.barcode)).toEqual(['6001234500035']);
      expect((await admin.post(`/products/${p.id}/barcodes`, { unitId: U.vial, barcode: '6001234500042' })).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await admin.post(`/products/${p.id}/barcodes`, { unitId: U.carton, barcode: 'ab' })).status).toBe(400);

      const primary = added.barcodes.find((b: any) => b.is_primary);
      const after = (await admin.del(`/products/${p.id}/barcodes/${primary.id}`)).body;
      expect(after.barcodes.filter((b: any) => b.is_primary)).toHaveLength(1); // another barcode was promoted
      expect((await admin.del(`/products/${p.id}/barcodes/${primary.id}`)).status).toBe(404);
    });

    it('looks a product up by scanned barcode, including the scanned pack and its selling price', async () => {
      await paracetamol();
      const scan = await admin.get('/products/by-barcode/6001234500011');
      expect(scan.status).toBe(200);
      expect(scan.body).toMatchObject({ name: 'Paracetamol', unit_code: 'strip', factor_to_base: '10.0000', selling_price: '25.5000', is_active: true });
      const boxScan = await admin.get('/products/by-barcode/6001234500028');
      expect(boxScan.body).toMatchObject({ unit_code: 'box', selling_price: null }); // no selling price set for the box yet
      expect((await admin.get('/products/by-barcode/0000000000')).body.code).toBe('BARCODE_NOT_FOUND');
    });
  });

  describe('prices', () => {
    it('records every price change with the old value, new value, reason and person', async () => {
      const p = (await paracetamol()).body;
      const change = await admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '28', reason: 'Supplier increase' });
      expect(change.status).toBe(201);
      expect(change.body.product.prices.find((x: any) => x.price_type === 'selling' && x.unit_id === U.strip).amount).toBe('28.0000');
      expect(change.body.warnings).toEqual([]);

      const history = (await admin.get(`/products/${p.id}/prices`)).body;
      const sell = history.filter((h: any) => h.price_type === 'selling');
      expect(sell.map((h: any) => [h.old_amount, h.new_amount, h.reason])).toEqual([['25.5000', '28.0000', 'Supplier increase'], [null, '25.5000', 'Initial price']]);
      expect(sell[0].changed_by).toBe('admin');
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'price.changed' and entity_id = $1`, [p.id])).rowCount).toBe(3); // two initial prices and one change
      // old prices are kept as closed periods, and exactly one is current
      const rows = (await ctx.db.query(`select effective_to from catalog.product_prices where product_id = $1 and unit_id = $2 and price_type = 'selling' order by effective_from`, [p.id, U.strip])).rows;
      expect(rows.map((r) => r.effective_to !== null)).toEqual([true, false]);
      await expect(ctx.db.query(`update catalog.price_change_log set reason = 'x'`)).rejects.toThrow(/append-only/);
    });

    it('rejects unchanged prices, missing reasons, and warns when selling below cost', async () => {
      const p = (await paracetamol()).body;
      expect((await admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '25.50', reason: 'same' })).body.code).toBe('PRICE_UNCHANGED');
      expect((await admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '30' })).status).toBe(400);
      expect((await admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '30', reason: 'x' })).status).toBe(400); // too short to explain anything
      expect((await admin.post(`/products/${p.id}/prices`, { unitId: U.vial, priceType: 'selling', amount: '30', reason: 'no vial pack' })).body.code).toBe('UNIT_NOT_CONFIGURED');
      const low = await admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '15', reason: 'Clearance sale' });
      expect(low.status).toBe(201);
      expect(low.body.warnings[0]).toMatch(/below the purchase price/);
    });

    it('stays consistent when several people change the same price at the same moment', async () => {
      const p = (await paracetamol()).body;
      // Many rounds, because this kind of problem only shows up some of the time
      for (let round = 0; round < 8; round++) {
        const base = 30 + round * 10;
        const results = await Promise.all([0, 1, 2, 3, 4].map((n) => admin.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: String(base + n), reason: `parallel ${round}-${n}` })));
        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      }
      const rows = (await ctx.db.query(`select effective_from, effective_to from catalog.product_prices where product_id = $1 and unit_id = $2 and price_type = 'selling' order by effective_from`, [p.id, U.strip])).rows;
      expect(rows).toHaveLength(41); // the initial price plus 40 changes
      expect(rows.filter((r) => r.effective_to === null)).toHaveLength(1);
      // every old price ended exactly when the next one began: no gaps and no overlaps
      for (let i = 0; i < rows.length - 1; i++) expect(rows[i].effective_to.getTime()).toBe(rows[i + 1].effective_from.getTime());
      expect((await admin.get(`/products/${p.id}/prices`)).body.filter((h: any) => h.price_type === 'selling')).toHaveLength(41);
    });

    it('needs the price-change permission', async () => {
      const p = (await paracetamol()).body;
      const dispenser = await userWith('disp', 'Dispenser / Sales Staff');
      expect((await dispenser.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '99', reason: 'try it' })).status).toBe(403);
      const mgr = await userWith('pharm.mgr', 'Pharmacy Manager');
      expect((await mgr.post(`/products/${p.id}/prices`, { unitId: U.strip, priceType: 'selling', amount: '27', reason: 'Manager review' })).status).toBe(201);
    });
  });

  describe('searching', () => {
    beforeEach(async () => {
      await paracetamol();
      await admin.post('/products', { name: 'Amoxicillin', genericName: 'Amoxicillin trihydrate', brandName: 'Amoxil', strength: '250 mg', baseUnitId: U.capsule, requiresPrescription: true });
      await admin.post('/products', { name: 'Vitamin C 100% natural', baseUnitId: U.tablet });
    });
    const names = (res: any) => res.body.items.map((i: any) => i.name);

    it('finds products by name, generic name, brand, SKU or exact barcode', async () => {
      expect(names(await admin.get('/products?search=parace'))).toEqual(['Paracetamol']);
      expect(names(await admin.get('/products?search=trihydrate'))).toEqual(['Amoxicillin']);
      expect(names(await admin.get('/products?search=PANADOL'))).toEqual(['Paracetamol']);
      expect(names(await admin.get('/products?search=PRD-000002'))).toEqual(['Amoxicillin']);
      expect(names(await admin.get('/products?search=6001234500028'))).toEqual(['Paracetamol']);
      expect((await admin.get('/products?search=zzzz')).body.total).toBe(0);
    });

    it('treats search text literally and supports filters and paging', async () => {
      expect(names(await admin.get('/products?search=100%25'))).toEqual(['Vitamin C 100% natural']);
      expect((await admin.get('/products?search=%25')).body.total).toBe(1); // only the product that really contains a percent sign
      expect(names(await admin.get('/products?requiresPrescription=true'))).toEqual(['Amoxicillin']);
      const page = await admin.get('/products?pageSize=2&page=2');
      expect(page.body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page.body.items).toHaveLength(1);
      expect((await admin.get('/products?pageSize=500')).status).toBe(400);
      expect((await admin.get('/products?requiresPrescription=maybe')).status).toBe(400);
    });
  });

  describe('supplier catalog', () => {
    it('links products to suppliers with their own code and last price', async () => {
      const p = (await paracetamol()).body;
      const s = (await admin.post('/suppliers', { name: 'EPSA Depot' })).body;
      const link = await admin.put(`/suppliers/${s.id}/products/${p.id}`, { supplierSku: 'EP-PARA-500', lastPrice: '17.25' });
      expect(link.status).toBe(200);
      expect(link.body[0]).toMatchObject({ sku: p.sku, supplier_sku: 'EP-PARA-500', last_price: '17.2500' });
      expect((await admin.put(`/suppliers/${s.id}/products/${p.id}`, { supplierSku: 'EP-PARA-500B' })).body[0].supplier_sku).toBe('EP-PARA-500B'); // updates, no duplicate row
      expect((await admin.put(`/suppliers/${s.id}/products/00000000-0000-4000-8000-000000000000`, {})).body.code).toBe('PRODUCT_NOT_FOUND');
      expect((await admin.del(`/suppliers/${s.id}/products/${p.id}`)).status).toBe(204);
      expect((await admin.get(`/suppliers/${s.id}/products`)).body).toHaveLength(0);
    });
  });
});
