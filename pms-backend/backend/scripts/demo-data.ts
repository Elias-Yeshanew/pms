/**
 * Loads sample data through the public API, exactly as people would enter it: branches, products, prices, stock,
 * users and two weeks of sales. Nothing is written to the database behind the API's back, so every rule still applies.
 *
 *   API_URL=http://localhost:3000/api/v1 DEMO_ADMIN_USERNAME=admin DEMO_ADMIN_PASSWORD=... npm run demo-data
 *
 * Run it once, on a fresh installation. Never run it against a client's real data.
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const ADMIN_USER = process.env.DEMO_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.DEMO_ADMIN_PASSWORD ?? '';
const DEMO_PASS = process.env.DEMO_USER_PASSWORD ?? 'Demo-Passw0rd!2026';
const FIRST_PASS = 'First-Passw0rd!2026';

class Client {
  constructor(private token = '') {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async ok(method: string, path: string, body?: unknown) {
    const r = await this.call(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  static async login(username: string, password: string, firstPassword?: string) {
    let r = await new Client().call('POST', '/auth/login', { username, password: firstPassword ?? password });
    if (r.status !== 200) throw new Error(`Sign-in as ${username} failed (${r.status}). ${JSON.stringify(r.body)}`);
    if (r.body.mustChangePassword) {
      // New accounts must choose their own password at first sign-in; demo accounts do it here
      if (!firstPassword) throw new Error(`${username} must change the password first: sign in once through the app, then run this again.`);
      await new Client(r.body.accessToken).ok('POST', '/auth/change-password', { currentPassword: firstPassword, newPassword: password });
      r = await new Client().call('POST', '/auth/login', { username, password });
      if (r.status !== 200) throw new Error(`Sign-in as ${username} failed after the password change.`);
    }
    return new Client(r.body.accessToken);
  }
}
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const pick = <T,>(xs: T[], i: number) => xs[i % xs.length];

async function main() {
  if (!ADMIN_PASS) throw new Error('Set DEMO_ADMIN_PASSWORD (and DEMO_ADMIN_USERNAME if it is not "admin").');
  const admin = await Client.login(ADMIN_USER, ADMIN_PASS);
  if ((await admin.ok('GET', '/branches')).total > 0) throw new Error('This system already has branches. Demo data is for a fresh installation only.');
  const units: Record<string, string> = Object.fromEntries((await admin.ok('GET', '/units')).map((u: any) => [u.code, u.id]));
  const roles: Record<string, string> = Object.fromEntries((((r: any) => (Array.isArray(r) ? r : r.items))(await admin.ok('GET', '/roles?pageSize=100')) as any[]).map((r: any) => [r.name, r.id]));

  // ---- branches, stores and registers ----
  const main = await admin.ok('POST', '/branches', { code: 'MAIN', name: 'Main Dispenser', address: 'Bole, Addis Ababa' });
  const piassa = await admin.ok('POST', '/branches', { code: 'PIASSA', name: 'Piassa Dispenser', address: 'Piassa, Addis Ababa' });
  const wh = { main: await admin.ok('POST', '/warehouses', { branchId: main.id, code: 'STORE', name: 'Main store' }), piassa: await admin.ok('POST', '/warehouses', { branchId: piassa.id, code: 'STORE', name: 'Piassa store' }) };
  const reg = { main: await admin.ok('POST', '/cash-registers', { branchId: main.id, code: 'R1', name: 'Counter 1', offlineMode: 'offline_capable' }), piassa: await admin.ok('POST', '/cash-registers', { branchId: piassa.id, code: 'R1', name: 'Counter 1', offlineMode: 'offline_capable' }) };

  // ---- people ----
  const mk = async (username: string, role: string, branchId?: string) => {
    await admin.ok('POST', '/users', { username, password: FIRST_PASS, roles: [{ roleId: roles[role], branchId }] });
  };
  await mk('demo.manager', 'Pharmacy Manager'); await mk('demo.keeper', 'Storekeeper'); await mk('demo.cashier1', 'Cashier', main.id); await mk('demo.cashier2', 'Cashier', piassa.id); await mk('demo.dispenser', 'Dispenser / Sales Staff', main.id);

  // ---- tax: a 15% VAT category as an example. Confirm the real rates and exemptions with the accountant before go-live. ----
  const vat = await admin.ok('POST', '/tax-categories', { name: 'VAT (sample)' });
  await admin.ok('POST', '/tax-rules', { taxCategoryId: vat.id, taxCode: 'VAT', name: 'VAT (sample rate)', rate: '15', isInclusive: false, effectiveFrom: '2020-01-01' });

  // ---- catalogue ----
  const catalogue: Array<[string, string, string, number, boolean]> = [
    ['Paracetamol 500 mg', 'tablet', 'Tablet', 2, false], ['Ibuprofen 400 mg', 'tablet', 'Tablet', 3, false], ['Amoxicillin 500 mg', 'capsule', 'Capsule', 8, true],
    ['Vitamin C 500 mg', 'tablet', 'Tablet', 1.5, false], ['Oral Rehydration Salts', 'sachet', 'Sachet', 12, false], ['Metformin 500 mg', 'tablet', 'Tablet', 4, true],
    ['Omeprazole 20 mg', 'capsule', 'Capsule', 6, false], ['Cetirizine 10 mg', 'tablet', 'Tablet', 3.5, false], ['Zinc sulphate 20 mg', 'tablet', 'Tablet', 5, false],
    ['Salbutamol inhaler', 'piece', 'Piece', 180, true], ['Povidone iodine 10%', 'bottle', 'Bottle', 65, false], ['Adhesive plaster', 'piece', 'Piece', 8, false],
  ];
  const products: Array<{ id: string; name: string; unit: string; price: number; rx: boolean }> = [];
  for (const [name, unitCode, , price, rx] of catalogue) {
    const p = await admin.ok('POST', '/products', { name, baseUnitId: units[unitCode], requiresPrescription: rx, taxCategoryId: vat.id, reorderLevel: '50', prices: [{ unitId: units[unitCode], priceType: 'selling', amount: price.toFixed(2) }] });
    products.push({ id: p.id, name, unit: units[unitCode], price, rx });
  }
  const supplier = await admin.ok('POST', '/suppliers', { code: 'EPSA', name: 'Sample Pharmaceutical Wholesaler', paymentTermsDays: 30 });
  void supplier;

  // ---- opening stock, approved by a different person (the four-eyes rule applies to demo data too) ----
  const keeper = await Client.login('demo.keeper', DEMO_PASS, FIRST_PASS); const manager = await Client.login('demo.manager', DEMO_PASS, FIRST_PASS);
  for (const [i, p] of products.entries()) {
    for (const [branchKey, warehouse] of [['main', wh.main], ['piassa', wh.piassa]] as const) {
      const adj = await keeper.ok('POST', '/inventory/adjustments', { warehouseId: warehouse.id, reasonCode: 'opening_balance', reason: 'Demo opening stock', items: [{ productId: p.id, quantity: String(300 + i * 20), direction: 'increase', newBatch: { batchRef: `DEMO-${branchKey}-${i + 1}`, expiryDate: day(i % 4 === 0 ? 45 : 300 + i * 10), unitCost: (p.price * 0.6).toFixed(2) } }] });
      await manager.ok('POST', `/approvals/${adj.approval_id}/approve`, {});
    }
  }

  // ---- two weeks of sales ----
  const cashiers = [{ c: await Client.login('demo.cashier1', DEMO_PASS, FIRST_PASS), r: reg.main }, { c: await Client.login('demo.cashier2', DEMO_PASS, FIRST_PASS), r: reg.piassa }];
  const sellable = products.filter((p) => !p.rx);
  let made = 0;
  for (let d = 13; d >= 0; d--) {
    for (let n = 0; n < 6; n++) {
      const { c, r } = pick(cashiers, d + n);
      const a = pick(sellable, d * 7 + n), b = pick(sellable, d * 3 + n * 5 + 1);
      const items = a.id === b.id ? [{ productId: a.id, quantity: String(1 + (n % 4)) }] : [{ productId: a.id, quantity: String(1 + (n % 4)) }, { productId: b.id, quantity: '2' }];
      const gross = items.reduce((t, it) => t + Number(it.quantity) * sellable.find((p) => p.id === it.productId)!.price, 0);
      const body = (amount: string) => ({ registerId: r.id, idempotencyKey: `DEMO-${d}-${n}`, soldAt: new Date(Date.now() - d * 864e5 - n * 3600e3).toISOString(), items, payments: [{ methodCode: 'cash', amount }] });
      let res = await c.call('POST', '/sales', body((gross * 1.15).toFixed(2)));
      // Tax rounding can differ by a cent from this estimate; the server says what the total really is
      if (res.status === 400 && res.body.code === 'PAYMENT_MISMATCH') res = await c.call('POST', '/sales', body(res.body.details.total));
      if (res.status === 201) made++; else console.log(`Sale ${d}/${n} skipped: ${res.body.code ?? res.status}`);
    }
  }
  console.log(`Demo data loaded: 2 branches, ${products.length} products, ${made} sales.`);
  console.log(`Sample users (password "${DEMO_PASS}"): demo.manager, demo.keeper, demo.cashier1, demo.cashier2, demo.dispenser. Change or delete them before real use.`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
