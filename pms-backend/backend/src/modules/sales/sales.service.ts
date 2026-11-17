import { Injectable, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { canonicalJson } from '../../common/canonical-json';
import { offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { add, cmp, divide, format, mul, parse, sub } from '../../domain/decimal';
import { lineTotal, percentDiscount } from '../../domain/pricing';
import { columnsFor, ReceiptData, renderReceipt } from '../../domain/receipt';
import { AuditService } from '../audit/audit.service';
import { TaxService } from '../finance/tax.service';
import { InventoryService, Allocation } from '../inventory/inventory.service';
import { LedgerService } from '../inventory/ledger.service';
import { ApprovalRequestRow, ApprovalsService } from '../platform/approvals.service';
import { JournalService } from '../finance/journal.service';
import { SessionsService } from '../finance/sessions.service';
import { SequenceService } from '../platform/sequence.service';
import { SettingsService } from '../platform/settings.service';
import { CustomersService } from './customers.service';
import { DiscountsService } from './discounts.service';
import { PrescriptionsService } from './prescriptions.service';

export interface SaleItemInput { productId: string; unitId?: string; quantity: string; discountPercent?: string; discountAmount?: string }
export interface SalePaymentInput { methodCode: string; amount: string; tendered?: string; reference?: string }
export interface CreateSaleDto {
  registerId: string; idempotencyKey: string; customerId?: string; prescriptionId?: string; warehouseId?: string; discountRequestId?: string;
  deviceId?: string; offlineRef?: string; soldAt?: string; items: SaleItemInput[]; payments: SalePaymentInput[];
}

const notFound = () => AppError.notFound('SALE_NOT_FOUND', 'Sale not found.');
interface SaleRow { id: string; reference_no: string; branch_id: string; status: string; customer_id: string | null; prescription_id: string | null; cashier_id: string; total: string; paid_total: string; credit_total: string; credit_returned: string; sold_at: Date; request_hash: string }
interface Priced { productId: string; name: string; unitId: string; quantity: string; base: string; price: string; gross: string; discount: string; discountPct: string; net: string; taxRate: string; tax: string; total: string; requiresRx: boolean; taxCategoryId: string | null }

/**
 * Selling. One transaction takes stock (earliest expiry first), prices and taxes every line, checks the discount and any
 * prescription, records the payments and any amount put on the customer's account. If anything fails, nothing happens.
 */
@Injectable()
export class SalesService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService, private readonly inventory: InventoryService, private readonly ledger: LedgerService, private readonly tax: TaxService,
    private readonly customers: CustomersService, private readonly prescriptions: PrescriptionsService, private readonly discounts: DiscountsService,
    private readonly approvals: ApprovalsService, private readonly sequences: SequenceService, private readonly settings: SettingsService, private readonly audit: AuditService,
    private readonly journal: JournalService, private readonly sessions: SessionsService,
  ) {}

  onModuleInit() {
    this.approvals.registerHandler('sales.cancel', {
      onApproved: (q, r, auth) => this.performCancel(q, r.source_id, auth, String((r.summary as { reason?: string }).reason ?? 'Cancelled')),
    });
  }

  /** Books the money side of a sale: what was received (or put on the customer's account) against revenue and tax collected. */
  private async postRevenue(q: PoolClient, s: { saleId: string; branchId: string; reference: string; total: string; taxTotal: string; cashierId: string }) {
    const pays = await many<{ code: string; amount: string }>(q, `select m.code, p.amount from sales.sale_payments p join sales.payment_methods m on m.id = p.method_id where p.sale_id = $1 order by p.id`, [s.saleId]);
    const lines = [];
    for (const p of pays) lines.push({ account: await this.journal.paymentAccountKey(q, p.code), debit: p.amount });
    lines.push({ account: 'revenue', credit: sub(s.total, s.taxTotal) }, { account: 'tax_output', credit: s.taxTotal });
    await this.journal.post(q, { eventCode: 'sale.revenue', description: `Sale ${s.reference}`, branchId: s.branchId, sourceType: 'sale', sourceId: s.saleId, createdBy: s.cashierId, lines });
  }

  // =============== creating a sale ===============
  async create(auth: AuthContext, dto: CreateSaleDto): Promise<{ sale: unknown; replay: boolean }> {
    const reg = await maybeOne<{ branch_id: string; status: string }>(this.db, `select branch_id, status from org.cash_registers where id = $1`, [dto.registerId]);
    if (!reg || !auth.scopeFor('sales.read').includes(reg.branch_id)) throw AppError.notFound('REGISTER_NOT_FOUND', 'Cash register not found.');
    if (!auth.scopeFor('sales.create').includes(reg.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to sell at this branch.');
    if (reg.status !== 'active') throw AppError.conflict('REGISTER_INACTIVE', 'This cash register is not active.');
    if (dto.soldAt && new Date(dto.soldAt).getTime() > Date.now() + 5 * 60000) throw AppError.badRequest('SOLD_AT_IN_FUTURE', 'The sale time cannot be in the future.');
    const hash = createHash('sha256').update(canonicalJson(dto)).digest('hex');

    const result = await this.db.tx(async (q) => {
      // A repeated submission waits for the first one to finish, then gets the same sale back
      await q.query(`select pg_advisory_xact_lock(hashtext($1))`, [`sale:${dto.idempotencyKey}`]);
      const existing = await maybeOne<{ id: string; request_hash: string; cashier_id: string }>(q, `select id, request_hash, cashier_id from sales.sales where idempotency_key = $1`, [dto.idempotencyKey]);
      if (existing) {
        if (existing.request_hash !== hash || existing.cashier_id !== auth.userId) throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'This key was already used for a different sale.');
        return { id: existing.id, replay: true };
      }
      return { id: await this.createWithin(q, auth, dto, reg.branch_id, hash), replay: false };
    });
    return { sale: await this.get(auth, result.id), replay: result.replay };
  }

  private async createWithin(q: PoolClient, auth: AuthContext, dto: CreateSaleDto, branchId: string, hash: string): Promise<string> {
    if (!dto.deviceId && !dto.offlineRef) await this.sessions.assertOpenIfRequired(q, branchId, dto.registerId);
    if (dto.warehouseId && !(await maybeOne(q, `select 1 from org.warehouses where id = $1 and branch_id = $2`, [dto.warehouseId, branchId]))) throw AppError.badRequest('WAREHOUSE_NOT_FOUND', 'The warehouse does not belong to this branch.');
    if (dto.customerId) {
      const c = await maybeOne<{ status: string }>(q, `select status from sales.customers where id = $1`, [dto.customerId]);
      if (!c) throw AppError.badRequest('CUSTOMER_NOT_FOUND', 'The customer does not exist.');
      if (c.status !== 'active') throw AppError.conflict('CUSTOMER_INACTIVE', 'This customer is inactive.');
    }
    // An offline sale is priced and taxed as of the moment it was made, not the moment it reached the server
    const soldAt = dto.soldAt && (dto.deviceId || dto.offlineRef) ? new Date(dto.soldAt) : new Date();
    const today = await this.settings.businessDate(soldAt, q);
    const dp = await this.settings.get('business.currency_decimals', null, q);
    const limit = await this.settings.get('sales.max_discount_percent', branchId, q);

    // ---- price every line ----
    const lines: Priced[] = [];
    for (const it of dto.items) {
      const p = await maybeOne<{ name: string; strength: string | null; is_active: boolean; base_unit_id: string; tax_category_id: string | null; requires_prescription: boolean; is_controlled: boolean }>(q,
        `select name, strength, is_active, base_unit_id, tax_category_id, requires_prescription, is_controlled from catalog.products where id = $1`, [it.productId]);
      if (!p) throw AppError.badRequest('PRODUCT_NOT_FOUND', 'A product does not exist.');
      if (!p.is_active) throw AppError.conflict('PRODUCT_INACTIVE', `${p.name} is inactive and cannot be sold.`);
      const unitId = it.unitId ?? p.base_unit_id;
      const pu = await maybeOne<{ is_sellable: boolean }>(q, `select is_sellable from catalog.product_units where product_id = $1 and unit_id = $2`, [it.productId, unitId]);
      if (!pu) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this pack size.');
      if (!pu.is_sellable) throw AppError.badRequest('UNIT_NOT_SELLABLE', 'This pack size cannot be sold.');
      const base = await this.inventory.toBase(q, it.productId, unitId, it.quantity);
      if (cmp(base, '0') <= 0) throw AppError.badRequest('INVALID_QUANTITY', 'Quantities must be greater than zero.');
      const price = await maybeOne<{ amount: string }>(q, `select amount from catalog.product_prices where product_id = $1 and unit_id = $2 and price_type = 'selling' and effective_from <= $3 and (effective_to is null or effective_to > $3)`, [it.productId, unitId, soldAt]);
      if (!price) throw AppError.conflict('NO_PRICE', `${p.name} has no selling price for this pack size.`);
      const gross = lineTotal(price.amount, it.quantity, 'half_up', dp);
      if (it.discountPercent !== undefined && it.discountAmount !== undefined) throw AppError.badRequest('DISCOUNT_AMBIGUOUS', 'Give a discount percentage or an amount, not both.');
      let discount = '0.0000', discountPct = '0.0000';
      if (it.discountPercent !== undefined) {
        if (cmp(it.discountPercent, '100') > 0) throw AppError.badRequest('INVALID_DISCOUNT', 'A discount cannot exceed 100 percent.');
        discountPct = format(parse(it.discountPercent)); discount = percentDiscount(gross, it.discountPercent, 'half_up', dp);
      } else if (it.discountAmount !== undefined) {
        if (cmp(it.discountAmount, gross) > 0) throw AppError.badRequest('INVALID_DISCOUNT', 'A discount cannot be more than the line is worth.');
        discount = format(parse(it.discountAmount)); discountPct = cmp(gross, '0') > 0 ? divide(mul(discount, '100'), gross) : '0.0000';
      }
      const taxable = sub(gross, discount);
      let net = taxable, tax = '0.0000', total = taxable, rate = '0.0000';
      if (p.tax_category_id) { const t = await this.tax.calculate({ taxCategoryId: p.tax_category_id, amount: taxable, date: today }, q); net = t.net; tax = t.tax; total = t.gross; rate = t.rule.ratePercent; }
      lines.push({ productId: it.productId, name: p.strength ? `${p.name} ${p.strength}` : p.name, unitId, quantity: format(parse(it.quantity)), base, price: format(parse(price.amount)), gross, discount, discountPct, net, taxRate: rate, tax, total, requiresRx: p.requires_prescription || p.is_controlled, taxCategoryId: p.tax_category_id });
    }

    // ---- discount authority ----
    const maxPct = lines.reduce((m, l) => (cmp(l.discountPct, m) > 0 ? l.discountPct : m), '0.0000');
    if (cmp(maxPct, limit) > 0) {
      if (!dto.discountRequestId) throw new AppError(403, 'DISCOUNT_APPROVAL_REQUIRED', `Discounts above ${limit}% need approval first.`, { limit, requested: maxPct });
      await this.discounts.consume(q, dto.discountRequestId, branchId, maxPct);
    }

    // ---- prescription ----
    const rxProducts = [...new Set(lines.filter((l) => l.requiresRx).map((l) => l.productId))];
    if (rxProducts.length && !dto.prescriptionId) throw AppError.conflict('PRESCRIPTION_REQUIRED', 'A prescription is required for one or more of these medicines.', { productIds: rxProducts });
    let rxLinks = new Map<string, string>();
    if (dto.prescriptionId) {
      const perProduct = new Map<string, { productId: string; baseQuantity: string; mustBePrescribed: boolean }>();
      for (const l of lines) {
        const cur = perProduct.get(l.productId);
        perProduct.set(l.productId, { productId: l.productId, baseQuantity: cur ? add(cur.baseQuantity, l.base) : l.base, mustBePrescribed: l.requiresRx || (cur?.mustBePrescribed ?? false) });
      }
      rxLinks = await this.prescriptions.dispense(q, auth, dto.prescriptionId, [...perProduct.values()], today);
    }

    // ---- payments ----
    const total = lines.reduce((t, l) => add(t, l.total), '0.0000');
    const codes = [...new Set(dto.payments.map((p) => p.methodCode))];
    const methods = await many<{ id: string; code: string; is_cash: boolean; is_credit: boolean; requires_reference: boolean; is_active: boolean }>(q, `select id, code, is_cash, is_credit, requires_reference, is_active from sales.payment_methods where code = any($1::text[])`, [codes]);
    let paid = '0.0000', credit = '0.0000', change = '0.0000';
    const payments: Array<{ methodId: string; amount: string; tendered: string | null; change: string; reference: string | null }> = [];
    for (const p of dto.payments) {
      const m = methods.find((x) => x.code === p.methodCode);
      if (!m || !m.is_active) throw AppError.badRequest('PAYMENT_METHOD_NOT_FOUND', `Payment method "${p.methodCode}" does not exist or is not in use.`);
      if (cmp(p.amount, '0') <= 0) throw AppError.badRequest('INVALID_AMOUNT', 'Payment amounts must be greater than zero.');
      if (m.requires_reference && !p.reference?.trim()) throw AppError.badRequest('REFERENCE_REQUIRED', `${m.code} payments need a reference.`);
      let tendered: string | null = null, chg = '0.0000';
      if (p.tendered !== undefined) {
        if (!m.is_cash) throw AppError.badRequest('TENDERED_CASH_ONLY', 'Change can only be given on cash payments.');
        if (cmp(p.tendered, p.amount) < 0) throw AppError.badRequest('TENDERED_TOO_LOW', 'The cash handed over is less than the amount paid.');
        tendered = format(parse(p.tendered)); chg = sub(tendered, p.amount);
      }
      if (m.is_credit) {
        if (!dto.customerId) throw AppError.badRequest('CUSTOMER_REQUIRED', 'Choose a customer to sell on account.');
        if (!auth.can('customers.credit', branchId)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to sell on account.');
        credit = add(credit, p.amount);
      } else paid = add(paid, p.amount);
      change = add(change, chg);
      payments.push({ methodId: m.id, amount: format(parse(p.amount)), tendered, change: chg, reference: p.reference?.trim() ?? null });
    }
    if (cmp(add(paid, credit), total) !== 0) throw AppError.badRequest('PAYMENT_MISMATCH', 'The payments do not add up to the total.', { total, paid: add(paid, credit) });
    if (cmp(total, '0') === 0 && payments.length) throw AppError.badRequest('INVALID_PAYMENT', 'A sale with nothing to pay needs no payment.');

    // ---- take the stock ----
    const saleId = (await one<{ id: string }>(q, `select public.uuid_v7() as id`)).id;
    const reference = await this.sequences.next(q, 'sale', branchId);
    const allocations = new Map<number, Allocation[]>();
    const order = lines.map((_, i) => i).sort((a, b) => (lines[a].productId < lines[b].productId ? -1 : lines[a].productId > lines[b].productId ? 1 : a - b)); // same lock order for every sale
    for (const i of order) {
      try {
        allocations.set(i, await this.inventory.issueFefo(q, { productId: lines[i].productId, branchId, baseQuantity: lines[i].base, warehouseId: dto.warehouseId ?? null, movementType: 'sale', referenceNo: reference, sourceType: 'sale', sourceId: saleId, createdBy: auth.userId }));
      } catch (e) {
        if (e instanceof AppError && e.code === 'INSUFFICIENT_STOCK') throw AppError.conflict('INSUFFICIENT_STOCK', `Not enough saleable stock of ${lines[i].name}.`, { ...(e.details as object), productId: lines[i].productId, product: lines[i].name });
        throw e;
      }
    }

    // ---- write the sale ----
    const costOf = (i: number) => allocations.get(i)!.reduce((t, a) => add(t, mul(a.quantity, a.unitCost)), '0.0000');
    const cogs = lines.reduce((t, _l, i) => add(t, costOf(i)), '0.0000');
    const subtotal = lines.reduce((t, l) => add(t, l.net), '0.0000');
    const discountTotal = lines.reduce((t, l) => add(t, l.discount), '0.0000');
    const taxTotal = lines.reduce((t, l) => add(t, l.tax), '0.0000');
    await q.query(
      `insert into sales.sales (id, reference_no, branch_id, register_id, customer_id, prescription_id, cashier_id, subtotal, discount_total, tax_total, total, paid_total, credit_total, change_given, cogs_total,
              max_discount_percent, discount_request_id, idempotency_key, request_hash, device_id, offline_ref, sold_at, synced_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, coalesce($22::timestamptz, clock_timestamp()), case when $20::uuid is null then null else clock_timestamp() end)`,
      [saleId, reference, branchId, dto.registerId, dto.customerId ?? null, dto.prescriptionId ?? null, auth.userId, subtotal, discountTotal, taxTotal, total, paid, credit, change, cogs, maxPct,
        cmp(maxPct, limit) > 0 ? dto.discountRequestId : null, dto.idempotencyKey, hash, dto.deviceId ?? null, dto.offlineRef ?? null, dto.soldAt ?? null]);
    for (const [i, l] of lines.entries()) {
      const item = await one<{ id: string }>(q, `insert into sales.sale_items (sale_id, line_no, product_id, unit_id, quantity, base_quantity, unit_price, line_gross, discount_percent, discount_amount, line_net, tax_rate, tax_amount, line_total, cost_total, prescription_item_id)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) returning id`,
        [saleId, i + 1, l.productId, l.unitId, l.quantity, l.base, l.price, l.gross, l.discountPct, l.discount, l.net, l.taxRate, l.tax, l.total, costOf(i), rxLinks.get(l.productId) ?? null]);
      for (const a of allocations.get(i)!) await q.query(`insert into sales.sale_item_allocations (sale_item_id, batch_id, warehouse_id, location_id, base_quantity, unit_cost) values ($1, $2, $3, $4, $5, $6)`, [item.id, a.batchId, a.warehouseId, a.locationId, a.quantity, a.unitCost]);
    }
    for (const p of payments) await q.query(`insert into sales.sale_payments (sale_id, method_id, amount, tendered, change_given, reference) values ($1, $2, $3, $4, $5, $6)`, [saleId, p.methodId, p.amount, p.tendered, p.change, p.reference]);
    await this.postRevenue(q, { saleId, branchId, reference, total, taxTotal, cashierId: auth.userId });
    if (cmp(credit, '0') > 0) await this.customers.postEntry(q, { customerId: dto.customerId!, type: 'credit_sale', amount: credit, branchId, sourceType: 'sale', sourceId: saleId, referenceNo: reference, createdBy: auth.userId, enforceLimit: true });
    if (cmp(maxPct, limit) > 0) await this.discounts.markUsed(q, dto.discountRequestId!, saleId);
    await this.audit.record({ action: 'sale.completed', entityType: 'sale', entityId: saleId, branchId, newValue: { reference, total, lines: lines.length, credit, discountTotal } }, q);
    return saleId;
  }

  // =============== reading ===============
  async get(auth: AuthContext, id: string) {
    const s = await maybeOne<SaleRow>(this.db,
      `select s.*, b.code as branch_code, r.code as register_code, cu.username as cashier_name, c.name as customer_name, c.code as customer_code, rx.reference_no as prescription_reference
         from sales.sales s join org.branches b on b.id = s.branch_id join org.cash_registers r on r.id = s.register_id join iam.users cu on cu.id = s.cashier_id
         left join sales.customers c on c.id = s.customer_id left join sales.prescriptions rx on rx.id = s.prescription_id where s.id = $1`, [id]);
    if (!s || !auth.scopeFor('sales.read').includes(s.branch_id)) throw notFound();
    const items = await many<{ id: string }>(this.db, `select i.id, i.line_no, i.product_id, p.sku, p.name as product_name, i.unit_id, u.code as unit_code, i.quantity, i.base_quantity, i.unit_price, i.line_gross, i.discount_percent, i.discount_amount,
        i.line_net, i.tax_rate, i.tax_amount, i.line_total, i.cost_total, i.returned_base, i.prescription_item_id from sales.sale_items i join catalog.products p on p.id = i.product_id join catalog.units u on u.id = i.unit_id where i.sale_id = $1 order by i.line_no`, [id]);
    const allocs = await many<{ sale_item_id: string }>(this.db, `select a.sale_item_id, a.batch_id, sb.batch_ref, to_char(sb.expiry_date, 'YYYY-MM-DD') as expiry_date, a.warehouse_id, a.base_quantity, a.unit_cost, a.returned_base from sales.sale_item_allocations a join inventory.stock_batches sb on sb.id = a.batch_id
        where a.sale_item_id = any($1::uuid[]) order by sb.expiry_date`, [items.map((i) => i.id)]);
    const payments = await many(this.db, `select p.id, m.code as method_code, m.name as method_name, p.amount, p.tendered, p.change_given, p.reference from sales.sale_payments p join sales.payment_methods m on m.id = p.method_id where p.sale_id = $1 order by p.received_at, p.id`, [id]);
    const refunds = await many(this.db, `select f.kind, f.amount, f.to_account, m.code as method_code, f.created_at from sales.sale_refunds f left join sales.payment_methods m on m.id = f.method_id where f.sale_id = $1 order by f.created_at`, [id]);
    const returns = await many(this.db, `select id, reference_no, status, refund_total, requested_at from sales.sales_returns where sale_id = $1 order by requested_at`, [id]);
    const seesCost = auth.can('finance.read', s.branch_id);
    const hide = <T extends object>(o: T, ...keys: string[]) => seesCost ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
    return { ...hide(s, 'cogs_total'), items: items.map((i) => ({ ...hide(i, 'cost_total'), allocations: allocs.filter((a) => a.sale_item_id === i.id).map((a) => hide(a, 'unit_cost')) })), payments, refunds, returns };
  }

  async list(auth: AuthContext, q: PageQuery & { branchId?: string; cashierId?: string; customerId?: string; status?: string; from?: string; to?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('sales.read').sql('s.branch_id', params)];
    const add2 = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.branchId) add2('s.branch_id = ?', q.branchId);
    if (q.cashierId) add2('s.cashier_id = ?', q.cashierId);
    if (q.customerId) add2('s.customer_id = ?', q.customerId);
    if (q.status) add2('s.status = ?', q.status);
    if (q.from) add2('s.sold_at >= ?', q.from);
    if (q.to) add2('s.sold_at <= ?', q.to);
    if (q.search) add2('s.reference_no ilike ?', `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from sales.sales s where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select s.id, s.reference_no, s.branch_id, s.register_id, s.cashier_id, cu.username as cashier_name, s.customer_id, s.status, s.total, s.discount_total, s.paid_total, s.credit_total, s.sold_at
        from sales.sales s join iam.users cu on cu.id = s.cashier_id where ${w} order by s.sold_at desc, s.reference_no desc limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Receipt as data and as text for a thermal printer. Every print after the first is marked as a reprint. */
  async receipt(auth: AuthContext, id: string, reprint: boolean) {
    const s = await this.get(auth, id) as unknown as SaleRow & { branch_code: string; cashier_name: string; customer_name: string | null; items: Array<Record<string, string>>; payments: Array<Record<string, string>>; change_given: string; subtotal: string; discount_total: string; tax_total: string };
    const b = await one<{ name: string; address: string | null; phone: string | null }>(this.db, `select name, address, phone from org.branches where id = $1`, [s.branch_id]);
    const [business, currency, footer, width, tz] = await Promise.all([this.settings.get('business.name'), this.settings.get('business.currency'), this.settings.get('sales.receipt_footer', s.branch_id), this.settings.get('sales.receipt_paper_width', s.branch_id), this.settings.get('business.timezone')]);
    const soldAt = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(s.sold_at));
    const data: ReceiptData = {
      businessName: business, branchName: b.name, branchAddress: b.address, branchPhone: b.phone, reference: s.reference_no, soldAt, cashier: s.cashier_name, customer: s.customer_name, currency, footer: footer || undefined, reprint, cancelled: s.status === 'cancelled',
      lines: s.items.map((i) => ({ name: i.product_name, unit: i.unit_code, quantity: i.quantity, unitPrice: i.unit_price, discount: i.discount_amount, total: i.line_total })),
      subtotal: s.subtotal, discountTotal: s.discount_total, taxTotal: s.tax_total, total: s.total,
      payments: s.payments.map((p) => ({ method: p.method_name, amount: p.amount, reference: p.reference })), changeGiven: s.change_given, creditTotal: s.credit_total,
    };
    await this.audit.record({ action: reprint ? 'sale.receipt_reprinted' : 'sale.receipt_printed', entityType: 'sale', entityId: id, branchId: s.branch_id });
    return { reference: s.reference_no, paperWidthMm: width, columns: columnsFor(width), reprint, data, text: renderReceipt(data, columnsFor(width)) };
  }

  /** Totals for a period: revenue, tax, discounts, cost of goods and gross profit (from the real cost of the batches sold), plus how it was paid. */
  async summary(auth: AuthContext, f: { from?: string; to?: string; branchId?: string }) {
    const params: unknown[] = [f.from ?? null, f.to ?? null];
    const where = [`s.status <> 'cancelled'`, `($1::timestamptz is null or s.sold_at >= $1)`, `($2::timestamptz is null or s.sold_at <= $2)`, auth.scopeFor('sales.read').sql('s.branch_id', params)];
    if (f.branchId) { params.push(f.branchId); where.push(`s.branch_id = $${params.length}`); }
    const w = where.join(' and ');
    const t = await one<{ sales: number; subtotal: string; discounts: string; tax: string; total: string; cogs: string; credit: string }>(this.db,
      `select count(*)::int as sales, coalesce(sum(subtotal), 0)::numeric(18,4) as subtotal, coalesce(sum(discount_total), 0)::numeric(18,4) as discounts, coalesce(sum(tax_total), 0)::numeric(18,4) as tax,
              coalesce(sum(total), 0)::numeric(18,4) as total, coalesce(sum(cogs_total), 0)::numeric(18,4) as cogs, coalesce(sum(credit_total), 0)::numeric(18,4) as credit from sales.sales s where ${w}`, params);
    const byMethod = await many(this.db, `select m.code as method_code, m.name as method_name, (sum(p.amount))::numeric(18,4) as amount, count(*)::int as payments from sales.sale_payments p join sales.sales s on s.id = p.sale_id join sales.payment_methods m on m.id = p.method_id where ${w} group by m.code, m.name order by m.code`, params);
    const byCashier = await many(this.db, `select u.username as cashier, count(*)::int as sales, (sum(s.total))::numeric(18,4) as total from sales.sales s join iam.users u on u.id = s.cashier_id where ${w} group by u.username order by u.username`, params);
    const rp: unknown[] = [f.from ?? null, f.to ?? null];
    const rWhere = [`($1::timestamptz is null or f.created_at >= $1)`, `($2::timestamptz is null or f.created_at <= $2)`, auth.scopeFor('sales.read').sql('s.branch_id', rp)];
    if (f.branchId) { rp.push(f.branchId); rWhere.push(`s.branch_id = $${rp.length}`); }
    const refunds = await one<{ v: string }>(this.db, `select coalesce(sum(f.amount), 0)::numeric(18,4) as v from sales.sale_refunds f join sales.sales s on s.id = f.sale_id where ${rWhere.join(' and ')}`, rp);
    // Cost and profit are for people who may see the books; a cashier's view shows takings only
    const seesCost = f.branchId ? auth.scopeFor('finance.read').includes(f.branchId) : auth.scopeFor('finance.read').isUnrestricted;
    const { cogs, ...takings } = t;
    return { ...takings, ...(seesCost ? { cogs, grossProfit: sub(t.subtotal, t.cogs) } : {}), refunds: refunds.v, byPaymentMethod: byMethod, byCashier };
  }

  // =============== cancelling a sale ===============
  async requestCancel(auth: AuthContext, id: string, reason: string) {
    const s = await this.get(auth, id) as unknown as SaleRow;
    if (!auth.scopeFor('sales.cancel').includes(s.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to cancel sales at this branch.');
    await this.assertCancellable(this.db, s);
    const needs = await this.settings.get('sales.cancel_approval_required');
    if (needs) {
      await this.db.tx(async (q) => {
        await this.approvals.request(q, auth, { actionCode: 'sales.cancel', sourceType: 'sale', sourceId: id, branchId: s.branch_id, requiredPermission: 'sales.cancel_approve', summary: { reference: s.reference_no, total: s.total, reason } });
        await this.audit.record({ action: 'sale.cancel_requested', entityType: 'sale', entityId: id, branchId: s.branch_id, newValue: { reason } }, q);
      });
    } else {
      if (!auth.can('sales.cancel_approve', s.branch_id)) throw AppError.forbidden('PERMISSION_DENIED', 'Cancellations are applied immediately, so you need the cancellation-approval permission.');
      await this.db.tx((q) => this.performCancel(q, id, auth, reason));
    }
    return this.get(auth, id);
  }

  private async assertCancellable(q: PoolClient | DatabaseService, s: SaleRow) {
    if (s.status !== 'completed') throw AppError.conflict('SALE_NOT_CANCELLABLE', s.status === 'cancelled' ? 'This sale is already cancelled.' : 'A sale with returns cannot be cancelled.');
    const hours = await this.settings.get('sales.cancel_window_hours', s.branch_id, q);
    if (hours > 0 && Date.now() - new Date(s.sold_at).getTime() > hours * 3600000) throw AppError.conflict('CANCEL_WINDOW_PASSED', `Sales can only be cancelled within ${hours} hours. Use a return instead.`);
  }

  /** Puts everything back as it was: stock to saleable, the customer's account, the prescription, and records what is refunded. */
  private async performCancel(q: PoolClient, saleId: string, auth: AuthContext, reason: string) {
    const s = await maybeOne<SaleRow>(q, `select * from sales.sales where id = $1 for update`, [saleId]);
    if (!s) throw notFound();
    await this.assertCancellable(q, s);
    const items = await many<{ id: string; product_id: string; base_quantity: string; prescription_item_id: string | null }>(q, `select id, product_id, base_quantity, prescription_item_id from sales.sale_items where sale_id = $1`, [saleId]);
    const allocs = await many<{ batch_id: string; warehouse_id: string; location_id: string | null; base_quantity: string; product_id: string }>(q,
      `select a.batch_id, a.warehouse_id, a.location_id, a.base_quantity, i.product_id from sales.sale_item_allocations a join sales.sale_items i on i.id = a.sale_item_id where i.sale_id = $1 order by a.id`, [saleId]);
    const reference = await this.sequences.next(q, 'sale_cancel', s.branch_id);
    await this.ledger.post(q, allocs.map((a) => ({ productId: a.product_id, batchId: a.batch_id, warehouseId: a.warehouse_id, locationId: a.location_id, status: 'available' as const, quantityDelta: format(parse(a.base_quantity)), movementType: 'correction' as const, referenceNo: reference, sourceType: 'sale_cancellation', sourceId: saleId, reason: `Sale ${s.reference_no} cancelled: ${reason}`, createdBy: auth.userId })));
    if (s.prescription_id) await this.prescriptions.undoDispense(q, s.prescription_id, items);
    if (s.customer_id && cmp(s.credit_total, '0') > 0) await this.customers.postEntry(q, { customerId: s.customer_id, type: 'cancel_credit', amount: format(-parse(s.credit_total)), branchId: s.branch_id, sourceType: 'sale', sourceId: saleId, referenceNo: s.reference_no, note: reason, createdBy: auth.userId });
    const pays = await many<{ method_id: string; amount: string }>(q, `select p.method_id, p.amount from sales.sale_payments p join sales.payment_methods m on m.id = p.method_id where p.sale_id = $1 and not m.is_credit`, [saleId]);
    await this.journal.reverseSource(q, { sourceType: 'sale', sourceId: saleId, eventCode: 'sale.revenue', reason: `Sale ${s.reference_no} cancelled`, createdBy: auth.userId });
    for (const p of pays) await q.query(`insert into sales.sale_refunds (sale_id, kind, method_id, amount, created_by) values ($1, 'cancellation', $2, $3, $4)`, [saleId, p.method_id, p.amount, auth.userId]);
    await q.query(`update sales.sales set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, version = version + 1 where id = $1`, [saleId, auth.userId, reason]);
    await this.audit.record({ action: 'sale.cancelled', entityType: 'sale', entityId: saleId, branchId: s.branch_id, newValue: { reference: s.reference_no, reason, cancellationReference: reference } }, q);
  }
}
export type { ApprovalRequestRow };
