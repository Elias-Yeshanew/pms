import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ADMIN, authed, createTestApp, GOOD_PASSWORD, makeAdmin, roleId, TestCtx, tokenFor } from './helpers';
import { IMPORT_COLUMNS } from '../src/modules/catalog/import.service';
import { isValidEan13 } from '../src/domain/barcode';
import { parseCsv, toCsv } from '../src/domain/csv';

type Client = ReturnType<typeof authed>;

describe('Bulk import, bulk prices, labels and images', () => {
  let ctx: TestCtx, admin: Client, token: string, uploadDir: string;
  let U: Record<string, string>;

  beforeAll(async () => { uploadDir = mkdtempSync(join(tmpdir(), 'pms-uploads-')); ctx = await createTestApp({ UPLOAD_DIR: uploadDir }); });
  afterAll(async () => { await ctx.close(); rmSync(uploadDir, { recursive: true, force: true }); });
  beforeEach(async () => {
    await ctx.reset();
    rmSync(join(uploadDir, 'products'), { recursive: true, force: true }); // each test starts with an empty image folder
    await makeAdmin(ctx);
    token = await tokenFor(ctx, ADMIN.username, ADMIN.password);
    admin = authed(ctx, token);
    U = Object.fromEntries((await admin.get('/units')).body.map((u: any) => [u.code, u.id]));
  });

  async function userWith(username: string, role: string) {
    await admin.post('/users', { username, password: GOOD_PASSWORD, roles: [{ roleId: await roleId(ctx, role) }] });
    await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [username]);
    const t = await tokenFor(ctx, username, GOOD_PASSWORD);
    return { api: authed(ctx, t), token: t };
  }
  const upload = (tok: string, path: string, content: Buffer | string, filename = 'products.csv', method: 'post' | 'put' = 'post') =>
    (ctx.http() as any)[method](`/api/v1${path}`).set('Authorization', `Bearer ${tok}`).attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), filename);
  /** GET that returns the body as text even for image/svg+xml, which the test client would otherwise hand back as bytes. */
  const getText = (path: string, tok = token) => ctx.http().get(`/api/v1${path}`).set('Authorization', `Bearer ${tok}`).buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c: string) => (d += c)); res.on('end', () => cb(null, d)); });
  const csv = (header: string[], rows: string[][]) => toCsv([header, ...rows]);
  const productCount = async () => (await ctx.db.query(`select count(*)::int as n from catalog.products`)).rows[0].n;

  describe('product import', () => {
    const H = ['name', 'base_unit', 'pack_units', 'barcode', 'barcode_unit', 'selling_price', 'purchase_price', 'price_unit', 'category', 'manufacturer', 'requires_prescription'];

    it('offers a template whose columns match what the importer accepts', async () => {
      const res = await ctx.http().get('/api/v1/products/import/template').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      const grid = parseCsv(res.text);
      expect(grid[0]).toEqual(IMPORT_COLUMNS);
      expect(grid[1]).toHaveLength(IMPORT_COLUMNS.length);
    });

    it('checks the whole file first without creating anything, then creates it when committed', async () => {
      const file = csv(H, [
        ['Paracetamol 500 mg', 'tablet', 'strip=10;box=100', '6001234500011', 'strip', '25.5', '18', 'strip', '', '', 'no'],
        ['Amoxicillin 250 mg', 'capsule', '', '', '', '', '', '', '', '', 'yes'],
        ['Cough syrup, 100 ml\nadult', 'bottle', '', '', '', '', '', '', '', '', ''],
      ]);
      const pre = await upload(token, '/products/import/preview', '\uFEFF' + file);
      expect(pre.status).toBe(200);
      expect(pre.body).toMatchObject({ total: 3, ok: 3, duplicates: 0, errors: 0 });
      expect(await productCount()).toBe(0); // a preview never writes
      expect((await ctx.db.query(`select count(*)::int as n from platform.document_sequences where doc_type = 'product_sku'`)).rows[0].n).toBe(0); // and never uses up numbers

      const done = await admin.post(`/products/import/${pre.body.jobId}/commit`, {});
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ created: 3, skipped: 0 });
      expect(done.body.results.map((r: any) => r.sku)).toEqual(['PRD-000001', 'PRD-000002', 'PRD-000003']);
      const p = (await admin.get('/products?search=Paracetamol')).body.items[0];
      const full = (await admin.get(`/products/${p.id}`)).body;
      expect(full.units.map((u: any) => [u.code, u.factor_to_base])).toEqual([['tablet', '1.0000'], ['strip', '10.0000'], ['box', '100.0000']]);
      expect(full.barcodes[0]).toMatchObject({ barcode: '6001234500011', is_primary: true, unit_id: U.strip });
      expect(full.prices.map((x: any) => [x.price_type, x.amount, x.unit_id]).sort()).toEqual([['purchase', '18.0000', U.strip], ['selling', '25.5000', U.strip]]);
      expect((await admin.get('/products?search=Cough')).body.items[0].name).toBe('Cough syrup, 100 ml\nadult');
      expect((await admin.post(`/products/import/${pre.body.jobId}/commit`, {})).body.code).toBe('IMPORT_ALREADY_DONE');
    });

    it('reports every problem in every row at once and lets the user skip the bad rows', async () => {
      const file = csv(H, [
        ['', 'tablet', '', '', '', '', '', '', '', '', ''],
        ['No such unit', 'zorg', '', '', '', '', '', '', '', '', ''],
        ['Bad flag', 'tablet', '', '', '', '', '', '', '', '', 'maybe'],
        ['Bad price', 'tablet', 'strip=ten', '', '', 'abc', '', '', '', '', ''],
        ['Unknown parts', 'tablet', '', '', '', '', '', '', 'Nonexistent > Child', 'Acme', ''],
        ['Good one', 'tablet', '', '', '', '', '', '', '', '', ''],
        ['good ONE', 'tablet', '', '', '', '', '', '', '', '', ''],
      ]);
      const pre = (await upload(token, '/products/import/preview', file)).body;
      expect(pre).toMatchObject({ total: 7, ok: 1, duplicates: 1, errors: 5 });
      const by = (line: number) => pre.results.find((r: any) => r.line === line);
      expect(by(2)).toMatchObject({ status: 'error' });
      expect(by(2).messages.join(' ')).toMatch(/name is required/);
      expect(by(3).messages.join(' ')).toMatch(/unit "zorg" does not exist/);
      expect(by(4).messages.join(' ')).toMatch(/maybe.*not yes or no/);
      expect(by(5).messages.join(' ')).toMatch(/pack_units.*strip=10/);
      expect(by(5).messages.join(' ')).toMatch(/selling_price.*not a valid/);
      expect(by(6).messages.join(' ')).toMatch(/category "Nonexistent" does not exist/);
      expect(by(6).messages.join(' ')).toMatch(/manufacturer "Acme" does not exist/);
      expect(by(7)).toMatchObject({ status: 'ok', sku: 'PRD-000001' });
      expect(by(8)).toMatchObject({ status: 'duplicate' });

      const blocked = await admin.post(`/products/import/${pre.jobId}/commit`, {});
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('IMPORT_HAS_PROBLEMS');
      expect(await productCount()).toBe(0); // nothing created while problems remain
      const skip = await admin.post(`/products/import/${pre.jobId}/commit`, { skipInvalid: true });
      expect(skip.body).toMatchObject({ created: 1, skipped: 6 });
      expect(await productCount()).toBe(1);
    });

    it('can include rows that look like duplicates when the user confirms them', async () => {
      const file = csv(['name', 'base_unit'], [['Twin', 'tablet'], ['twin', 'tablet']]);
      const pre = (await upload(token, '/products/import/preview', file)).body;
      const res = await admin.post(`/products/import/${pre.jobId}/commit`, { confirmDuplicates: true });
      expect(res.body).toMatchObject({ created: 2, skipped: 0 });
      // and a row that matches an existing product is flagged against the real catalogue
      const again = (await upload(token, '/products/import/preview', csv(['name', 'base_unit'], [['TWIN', 'tablet']]))).body;
      expect(again.results[0]).toMatchObject({ status: 'duplicate' });
    });

    it('creates missing categories and manufacturers only when asked, and only when committed', async () => {
      const file = csv(['name', 'base_unit', 'category', 'manufacturer'], [['Ibuprofen', 'tablet', 'Analgesics > Anti-inflammatory', 'Julphar']]);
      const without = (await upload(token, '/products/import/preview', file)).body;
      expect(without.errors).toBe(1);
      const pre = (await upload(token, '/products/import/preview?autoCreate=true', file)).body;
      expect(pre.ok).toBe(1);
      expect((await admin.get('/categories')).body).toHaveLength(0); // the dry run was rolled back, including the new categories
      expect((await admin.get('/manufacturers')).body).toHaveLength(0);
      await admin.post(`/products/import/${pre.jobId}/commit`, {});
      const cats = (await admin.get('/categories')).body;
      expect(cats.map((c: any) => c.name).sort()).toEqual(['Analgesics', 'Anti-inflammatory']);
      expect(cats.find((c: any) => c.name === 'Anti-inflammatory').parent_id).toBe(cats.find((c: any) => c.name === 'Analgesics').id);
      expect((await admin.get('/manufacturers')).body.map((m: any) => m.name)).toEqual(['Julphar']);
    });

    it('refuses files that are not valid import files', async () => {
      const bad = async (content: Buffer | string, name = 'x.csv') => (await upload(token, '/products/import/preview', content, name)).body;
      const unknown = await bad(csv(['name', 'base_unit', 'colour'], [['A', 'tablet', 'red']]));
      expect(unknown).toMatchObject({ code: 'INVALID_IMPORT_FILE', details: { unknownColumns: ['colour'] } });
      expect((await bad(csv(['name'], [['A']]))).details.missingColumns).toEqual(['base_unit']);
      expect((await bad(csv(['name', 'name', 'base_unit'], [['A', 'B', 'tablet']]))).details.duplicateColumns).toEqual(['name']);
      expect((await bad('name,base_unit\n')).code).toBe('INVALID_IMPORT_FILE');
      expect((await bad(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'sheet.xlsx')).code).toBe('INVALID_IMPORT_FILE');
      expect((await bad('name,base_unit\n"unclosed,tablet')).message).toMatch(/unclosed quote/);
      const many = csv(['name', 'base_unit'], Array.from({ length: 5001 }, (_, i) => [`P${i}`, 'tablet']));
      expect((await bad(many)).code).toBe('TOO_MANY_ROWS');
      expect((await upload(token, '/products/import/preview', Buffer.alloc(2 * 1024 * 1024 + 10, 97))).status).toBe(413);
      expect((await ctx.http().post('/api/v1/products/import/preview').set('Authorization', `Bearer ${token}`)).status).toBe(400);
    });

    it('applies the same permissions as manual entry, and keeps a preview private to the person who made it', async () => {
      const cashier = await userWith('cash', 'Cashier');
      expect((await upload(cashier.token, '/products/import/preview', csv(['name', 'base_unit'], [['A', 'tablet']]))).status).toBe(403);
      await admin.post('/roles', { name: 'Registrar', permissions: ['products.read', 'products.create'] });
      const rid = (await admin.get('/roles')).body.find((r: any) => r.name === 'Registrar').id;
      await admin.post('/users', { username: 'registrar', password: GOOD_PASSWORD, roles: [{ roleId: rid }] });
      await ctx.db.query(`update iam.users set must_change_password = false where username = 'registrar'`);
      const reg = await tokenFor(ctx, 'registrar', GOOD_PASSWORD);
      const pre = (await upload(reg, '/products/import/preview', csv(['name', 'base_unit', 'selling_price'], [['Priced', 'tablet', '5'], ['Unpriced', 'tablet', '']]))).body;
      expect(pre.results.find((r: any) => r.name === 'Priced')).toMatchObject({ status: 'error' }); // no price-change permission
      expect(pre.results.find((r: any) => r.name === 'Unpriced')).toMatchObject({ status: 'ok' });
      expect((await admin.get(`/products/import/${pre.jobId}`)).status).toBe(404);
      expect((await admin.post(`/products/import/${pre.jobId}/commit`, {})).status).toBe(404);
    });
  });

  describe('bulk price updates', () => {
    let approver: { api: Client };
    let cat: any, items: any[];
    beforeEach(async () => {
      approver = await userWith('approver', 'Pharmacy Manager');
      cat = (await admin.post('/categories', { name: 'Analgesics' })).body;
      const mk = async (name: string, selling?: string, purchase?: string, extra: object = {}) => (await admin.post('/products', { name, baseUnitId: U.tablet, categoryId: cat.id, units: [{ unitId: U.strip, factorToBase: '10' }],
        prices: [...(selling ? [{ unitId: U.tablet, priceType: 'selling', amount: selling }] : []), ...(purchase ? [{ unitId: U.tablet, priceType: 'purchase', amount: purchase }] : [])], ...extra })).body;
      items = [await mk('Alpha', '2.00', '1.50'), await mk('Beta', '3.33', '2.00'), await mk('Gamma'), await mk('Delta', '1.00', '0.95')];
      await mk('Elsewhere', '9.00', undefined, { categoryId: undefined }); // not in the category
    });
    const preview = (body: object, client: Client = admin) => client.post('/prices/bulk/preview', { priceType: 'selling', reason: 'Annual price review', ...body });
    const sellingOf = async (p: any) => (await admin.get(`/products/${p.id}`)).body.prices.find((x: any) => x.price_type === 'selling')?.amount;

    it('works out percentage changes exactly, skips what cannot change, and flags prices below cost', async () => {
      const pv = await preview({ mode: 'percent', value: '-30', categoryId: cat.id });
      expect(pv.status).toBe(200);
      expect(pv.body).toMatchObject({ status: 'draft', reference_no: 'PUP-000001', item_count: 3 });
      expect(pv.body.items.map((i: any) => [i.name, i.old_amount, i.new_amount, i.warning])).toEqual([
        ['Alpha', '2.0000', '1.4000', 'Below the purchase price'], // 1.40 is below its 1.50 cost
        ['Beta', '3.3300', '2.3300', null],                        // 3.33 - 0.999 = 2.331 -> 2.33
        ['Delta', '1.0000', '0.7000', 'Below the purchase price'],
      ]);
      expect(pv.body.skipped).toEqual([{ sku: items[2].sku, name: 'Gamma', reason: 'No current price to adjust' }]);
      expect(await sellingOf(items[0])).toBe('2.0000'); // nothing is changed by a preview
      const up = await preview({ mode: 'percent', value: '10', productIds: [items[0].id, items[1].id] });
      expect(up.body.items.map((i: any) => i.new_amount)).toEqual(['2.2000', '3.6600']); // 3.33 + 0.333 = 3.663 -> 3.66
      const amt = await preview({ mode: 'amount', value: '0.50', productIds: [items[0].id] });
      expect(amt.body.items[0].new_amount).toBe('2.5000');
    });

    it('sets a price for everything selected, including products that have none yet', async () => {
      const pv = await preview({ mode: 'set', value: '4.25', categoryId: cat.id });
      expect(pv.body.items.map((i: any) => [i.name, i.old_amount, i.new_amount])).toEqual([['Alpha', '2.0000', '4.2500'], ['Beta', '3.3300', '4.2500'], ['Delta', '1.0000', '4.2500'], ['Gamma', null, '4.2500']]);
      const strip = await preview({ mode: 'set', value: '40', productIds: [items[0].id], unitId: U.strip });
      expect(strip.body.items[0]).toMatchObject({ unit_code: 'strip', old_amount: null, new_amount: '40.0000' });
    });

    it('validates the request', async () => {
      expect((await preview({ mode: 'percent', value: '5' })).body.code).toBe('SELECTION_REQUIRED');
      expect((await preview({ mode: 'set', value: '-1', categoryId: cat.id })).body.code).toBe('INVALID_VALUE');
      expect((await preview({ mode: 'percent', value: '0', categoryId: cat.id })).body.code).toBe('NOTHING_TO_UPDATE');
      expect((await preview({ mode: 'amount', value: '-10', categoryId: cat.id })).body.code).toBe('NOTHING_TO_UPDATE'); // everything would go negative
      expect((await preview({ mode: 'percent', value: 'abc', categoryId: cat.id })).status).toBe(400);
      expect((await preview({ mode: 'percent', value: '5', categoryId: cat.id, reason: 'x' })).status).toBe(400);
      expect((await preview({ mode: 'percent', value: '5', unitId: U.vial, categoryId: cat.id })).body.code).toBe('NOTHING_TO_UPDATE'); // no product has a vial pack
      const cashier = await userWith('cash', 'Cashier');
      expect((await preview({ mode: 'percent', value: '5', categoryId: cat.id }, cashier.api)).status).toBe(403);
    });

    it('takes effect only after a second person approves, and records every change', async () => {
      const pv = (await preview({ mode: 'percent', value: '10', categoryId: cat.id })).body;
      const sub = (await admin.post(`/prices/bulk/${pv.id}/submit`, {})).body;
      expect(sub.status).toBe('pending');
      expect(await sellingOf(items[0])).toBe('2.0000');
      expect((await admin.post(`/approvals/${sub.approval_id}/approve`, {})).body.code).toBe('CANNOT_APPROVE_OWN_REQUEST');
      expect((await admin.post(`/prices/bulk/${pv.id}/submit`, {})).body.code).toBe('PRICE_BATCH_NOT_DRAFT');
      expect((await approver.api.post(`/approvals/${sub.approval_id}/approve`, {})).status).toBe(200);
      expect(await sellingOf(items[0])).toBe('2.2000');
      expect(await sellingOf(items[1])).toBe('3.6600');
      expect(await sellingOf(items[2])).toBeUndefined(); // Gamma had no price, so it was left alone
      const after = (await admin.get(`/prices/bulk/${pv.id}`)).body;
      expect(after.status).toBe('applied');
      const hist = (await admin.get(`/products/${items[0].id}/prices`)).body.filter((h: any) => h.price_type === 'selling');
      expect(hist[0]).toMatchObject({ old_amount: '2.0000', new_amount: '2.2000', reason: 'Annual price review (PUP-000001)', changed_by: 'approver' });
      expect((await ctx.db.query(`select 1 from audit.audit_logs where action = 'price.bulk_applied'`)).rowCount).toBe(1);
    });

    it('refuses to apply if any price changed after the preview, and leaves everything as it was', async () => {
      const pv = (await preview({ mode: 'percent', value: '10', categoryId: cat.id })).body;
      const sub = (await admin.post(`/prices/bulk/${pv.id}/submit`, {})).body;
      await admin.post(`/products/${items[1].id}/prices`, { unitId: U.tablet, priceType: 'selling', amount: '5', reason: 'Urgent correction' });
      const fail = await approver.api.post(`/approvals/${sub.approval_id}/approve`, {});
      expect(fail.status).toBe(409);
      expect(fail.body).toMatchObject({ code: 'STALE_PREVIEW', details: { count: 1 } });
      expect(await sellingOf(items[0])).toBe('2.0000'); // none of the other prices moved either
      expect(await sellingOf(items[1])).toBe('5.0000');
      expect((await admin.get(`/prices/bulk/${pv.id}`)).body.status).toBe('pending');
    });

    it('can be rejected or withdrawn, and only by the right people', async () => {
      const mk = async () => (await preview({ mode: 'set', value: '9', categoryId: cat.id })).body;
      const a = await mk(), b = await mk(), c = await mk();
      expect((await approver.api.post(`/prices/bulk/${a.id}/submit`, {})).status).toBe(404); // not their draft
      const subA = (await admin.post(`/prices/bulk/${a.id}/submit`, {})).body;
      expect((await approver.api.post(`/approvals/${subA.approval_id}/reject`, { comment: 'Too steep' })).body.status).toBe('rejected');
      expect((await admin.get(`/prices/bulk/${a.id}`)).body.status).toBe('rejected');
      expect((await admin.post(`/prices/bulk/${b.id}/cancel`, {})).body.status).toBe('cancelled');
      const subC = (await admin.post(`/prices/bulk/${c.id}/submit`, {})).body;
      expect((await admin.post(`/prices/bulk/${c.id}/cancel`, {})).body.status).toBe('cancelled');
      expect((await approver.api.post(`/approvals/${subC.approval_id}/approve`, {})).body.code).toBe('APPROVAL_ALREADY_DECIDED');
      expect((await admin.post(`/prices/bulk/${a.id}/cancel`, {})).body.code).toBe('PRICE_BATCH_NOT_CANCELLABLE');
      expect(await sellingOf(items[0])).toBe('2.0000');
      expect((await admin.get('/prices/bulk?status=cancelled')).body.total).toBe(2);
    });

    it('applies immediately when approval is switched off, but only for people who may approve', async () => {
      await admin.put('/settings/catalog.bulk_price_approval_required', { value: false });
      const registrar = await userWith('pm.registrar', 'Pharmacy Manager');
      const pv = (await preview({ mode: 'set', value: '7', productIds: [items[0].id] }, registrar.api)).body;
      expect((await registrar.api.post(`/prices/bulk/${pv.id}/submit`, {})).body.status).toBe('applied');
      expect(await sellingOf(items[0])).toBe('7.0000');
      await admin.post('/roles', { name: 'Price clerk', permissions: ['products.read', 'prices.change'] });
      const rid = (await admin.get('/roles')).body.find((r: any) => r.name === 'Price clerk').id;
      await admin.post('/users', { username: 'clerk', password: GOOD_PASSWORD, roles: [{ roleId: rid }] });
      await ctx.db.query(`update iam.users set must_change_password = false where username = 'clerk'`);
      const clerk = authed(ctx, await tokenFor(ctx, 'clerk', GOOD_PASSWORD));
      const pv2 = (await preview({ mode: 'set', value: '8', productIds: [items[0].id] }, clerk)).body;
      expect((await clerk.post(`/prices/bulk/${pv2.id}/submit`, {})).status).toBe(403);
    });
  });

  describe('barcodes and labels', () => {
    let p: any;
    beforeEach(async () => {
      p = (await admin.post('/products', { name: 'Paracetamol', strength: '500 mg', baseUnitId: U.tablet, units: [{ unitId: U.strip, factorToBase: '10' }],
        prices: [{ unitId: U.strip, priceType: 'selling', amount: '25.5' }] })).body;
    });

    it('generates unique in-store EAN-13 barcodes with a valid check digit', async () => {
      const first = (await admin.post(`/products/${p.id}/barcodes/generate`, { unitId: U.strip })).body;
      const second = (await admin.post(`/products/${p.id}/barcodes/generate`, { unitId: U.tablet })).body;
      const codes = second.barcodes.map((b: any) => b.barcode);
      expect(codes).toHaveLength(2);
      for (const c of codes) { expect(c).toMatch(/^2\d{12}$/); expect(isValidEan13(c)).toBe(true); }
      expect(new Set(codes).size).toBe(2);
      expect(first.barcodes).toHaveLength(1);
      expect(first.barcodes[0].is_primary).toBe(true);
      expect(second.barcodes.filter((b: any) => b.is_primary)).toHaveLength(1);
      expect((await admin.post(`/products/${p.id}/barcodes/generate`, { unitId: U.vial })).body.code).toBe('UNIT_NOT_CONFIGURED');
      expect((await admin.post(`/products/${p.id}/barcodes/generate`, {})).status).toBe(400);
    });

    it('renders a printable label with the price of that pack, and escapes hostile text', async () => {
      const withBarcode = (await admin.post(`/products/${p.id}/barcodes/generate`, { unitId: U.strip })).body;
      const b = withBarcode.barcodes[0];
      const res = await getText(`/products/${p.id}/barcodes/${b.id}/label`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
      const text = res.body as string;
      expect(text).toContain(b.barcode);
      expect(text).toContain('Paracetamol');
      expect(text).toContain('ETB 25.50');
      expect(text).toContain('per strip');
      expect(text).toMatch(/<rect x=/);

      const evil = (await admin.post('/products', { name: '<script>alert(1)</script> & "x"', baseUnitId: U.tablet })).body;
      const eb = (await admin.post(`/products/${evil.id}/barcodes/generate`, { unitId: U.tablet })).body.barcodes[0];
      const svg = (await getText(`/products/${evil.id}/barcodes/${eb.id}/label`)).body as string;
      expect(svg).not.toContain('<script>');
      expect(svg).toContain('&lt;script&gt;');

      const sheet = await admin.post('/products/labels/sheet', { items: [{ productId: p.id, barcodeId: b.id, copies: 3 }, { productId: evil.id, barcodeId: eb.id, copies: 1 }], columns: 2 });
      expect(sheet.status).toBe(200);
      expect(sheet.text.match(/class="cell"/g)).toHaveLength(4);
      expect(sheet.text).not.toContain('<script>');
      expect(sheet.text).toContain('repeat(2,1fr)');
      expect((await admin.post('/products/labels/sheet', { items: [{ productId: p.id, barcodeId: b.id, copies: 0 }] })).status).toBe(400);
      expect((await ctx.http().get(`/api/v1/products/${p.id}/barcodes/00000000-0000-4000-8000-000000000000/label`).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    });
  });

  describe('product images', () => {
    let p: any;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(30, 3)]);
    beforeEach(async () => { p = (await admin.post('/products', { name: 'Imaged', baseUnitId: U.tablet })).body; });
    const get = (id: string, tok = token) => ctx.http().get(`/api/v1/products/${id}/image`).set('Authorization', `Bearer ${tok}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const files = () => readdirSync(join(uploadDir, 'products'));

    it('stores a verified image and serves it back safely', async () => {
      expect((await upload(token, `/products/${p.id}/image`, png, 'photo.png', 'put')).status).toBe(200);
      const res = await get(p.id);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(res.body, png)).toBe(0);
      expect(files()).toHaveLength(1);
      expect(files()[0]).toMatch(new RegExp(`^${p.id}-[0-9a-f]{16}\\.png$`)); // the stored name is generated, never taken from the upload
      expect((await upload(token, `/products/${p.id}/image`, jpg, 'a.jpeg', 'put')).body.type).toBe('image/jpeg');
      expect(files()).toHaveLength(1); // the old file was removed
      expect((await upload(token, `/products/${p.id}/image`, webp, 'a.webp', 'put')).body.type).toBe('image/webp');
      expect((await get(p.id)).headers['content-type']).toBe('image/webp');
    });

    it('decides by the content, not by the name or claimed type', async () => {
      const bad = async (content: Buffer | string, name: string) => (await upload(token, `/products/${p.id}/image`, content, name, 'put')).body;
      expect((await bad('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'logo.png')).code).toBe('UNSUPPORTED_IMAGE');
      expect((await bad('GIF89a....', 'x.gif')).code).toBe('UNSUPPORTED_IMAGE');
      expect((await bad('<?php echo 1; ?>', 'shell.jpg')).code).toBe('UNSUPPORTED_IMAGE');
      expect((await bad(Buffer.alloc(0), 'empty.png')).code ?? 'rejected').toBeDefined();
      expect((await upload(token, `/products/${p.id}/image`, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]), 'big.png', 'put')).status).toBe(413);
      expect((await upload(token, `/products/${p.id}/image`, png, '../../etc/passwd.png', 'put')).status).toBe(200);
      expect(files().every((f) => /^[0-9a-f-]{36}-[0-9a-f]{16}\.png$/.test(f))).toBe(true);
      expect((await ctx.http().put(`/api/v1/products/${p.id}/image`).set('Authorization', `Bearer ${token}`)).status).toBe(400);
    });

    it('can be removed, and needs the right permissions', async () => {
      const cashier = await userWith('cash', 'Cashier');
      expect((await upload(cashier.token, `/products/${p.id}/image`, png, 'a.png', 'put')).status).toBe(403);
      await upload(token, `/products/${p.id}/image`, png, 'a.png', 'put');
      expect((await get(p.id, cashier.token)).status).toBe(200); // cashiers can see product images
      expect((await ctx.http().delete(`/api/v1/products/${p.id}/image`).set('Authorization', `Bearer ${cashier.token}`)).status).toBe(403);
      expect((await admin.del(`/products/${p.id}/image`)).status).toBe(204);
      expect((await get(p.id)).status).toBe(404);
      expect(files()).toHaveLength(0);
      expect((await upload(token, '/products/00000000-0000-4000-8000-000000000000/image', png, 'a.png', 'put')).status).toBe(404);
    });
  });
});
