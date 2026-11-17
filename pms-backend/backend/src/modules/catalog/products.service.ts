import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { likePattern, offsetOf, Page } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { cmp } from '../../domain/decimal';
import { DecimalError } from '../../domain/decimal';
import { convertQuantity } from '../../domain/units';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../platform/sequence.service';
import { ChangePriceDto, CreateProductDto, ProductsQuery, UnitConfigDto, UpdateProductDto } from './products.dto';
import { isProductInUse } from './product-usage';

const notFound = () => AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found.');

const LIST_COLS = `p.id, p.sku, p.name, p.generic_name, p.brand_name, p.strength, p.category_id, p.manufacturer_id, p.dosage_form_id,
                   p.base_unit_id, p.requires_prescription, p.is_controlled, p.is_active, p.version`;

interface UnitRow { unit_id: string; code: string; name: string; factor_to_base: string; is_sellable: boolean; is_purchasable: boolean }

@Injectable()
export class ProductsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly sequences: SequenceService) {}

  // ---------- reading ----------
  async list(q: ProductsQuery): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where: string[] = ['true'];
    const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.categoryId) add('p.category_id = ?', q.categoryId);
    if (q.manufacturerId) add('p.manufacturer_id = ?', q.manufacturerId);
    if (q.requiresPrescription !== undefined) add('p.requires_prescription = ?', q.requiresPrescription);
    if (q.isActive !== undefined) add('p.is_active = ?', q.isActive);
    if (q.search) {
      params.push(likePattern(q.search));
      const like = `$${params.length}`;
      params.push(q.search);
      const exact = `$${params.length}`;
      where.push(`(p.name ilike ${like} or p.generic_name ilike ${like} or p.brand_name ilike ${like} or p.sku ilike ${like}
                   or exists (select 1 from catalog.product_barcodes b where b.product_id = p.id and b.barcode = ${exact}))`);
    }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from catalog.products p where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select ${LIST_COLS} from catalog.products p where ${w} order by p.name, p.sku limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  private async units(q: Queryable, productId: string): Promise<UnitRow[]> {
    return many<UnitRow>(q, `select pu.unit_id, u.code, u.name, pu.factor_to_base, pu.is_sellable, pu.is_purchasable
                               from catalog.product_units pu join catalog.units u on u.id = pu.unit_id where pu.product_id = $1 order by pu.factor_to_base, u.code`, [productId]);
  }

  async get(id: string) {
    const p = await maybeOne(this.db,
      `select ${LIST_COLS}, p.registration_no, p.description, p.image_path, p.min_stock, p.max_stock, p.reorder_level, p.tax_category_id,
              c.name as category_name, m.name as manufacturer_name, f.name as dosage_form_name, bu.code as base_unit_code
         from catalog.products p
         left join catalog.categories c on c.id = p.category_id
         left join catalog.manufacturers m on m.id = p.manufacturer_id
         left join catalog.dosage_forms f on f.id = p.dosage_form_id
         join catalog.units bu on bu.id = p.base_unit_id
        where p.id = $1`, [id]);
    if (!p) throw notFound();
    const [units, barcodes, prices] = await Promise.all([
      this.units(this.db, id),
      many(this.db, `select id, unit_id, barcode, is_primary from catalog.product_barcodes where product_id = $1 order by is_primary desc, barcode`, [id]),
      many(this.db, `select unit_id, price_type, amount, effective_from from catalog.product_prices where product_id = $1 and effective_to is null order by price_type, unit_id`, [id]),
    ]);
    return { ...p, units, barcodes, prices };
  }

  /** For the point of sale: scan a code, get the product, the pack that was scanned and its current selling price. */
  async byBarcode(barcode: string) {
    const row = await maybeOne(this.db,
      `select p.id as product_id, p.sku, p.name, p.strength, p.requires_prescription, p.is_controlled, p.is_active, p.base_unit_id,
              b.unit_id, u.code as unit_code, pu.factor_to_base, pu.is_sellable,
              (select pr.amount from catalog.product_prices pr where pr.product_id = p.id and pr.unit_id = b.unit_id and pr.price_type = 'selling' and pr.effective_to is null) as selling_price
         from catalog.product_barcodes b
         join catalog.products p on p.id = b.product_id
         join catalog.units u on u.id = b.unit_id
         join catalog.product_units pu on pu.product_id = b.product_id and pu.unit_id = b.unit_id
        where b.barcode = $1`, [barcode]);
    if (!row) throw AppError.notFound('BARCODE_NOT_FOUND', 'No product has this barcode.');
    return row;
  }

  // ---------- helpers ----------
  private async assertExists(q: Queryable, table: string, id: string | undefined, code: string, message: string) {
    if (id && !(await maybeOne(q, `select 1 from ${table} where id = $1`, [id]))) throw AppError.badRequest(code, message); // table names are constants in this file
  }

  private async assertRefs(q: Queryable, d: { categoryId?: string; manufacturerId?: string; dosageFormId?: string; taxCategoryId?: string }) {
    await this.assertExists(q, 'catalog.categories', d.categoryId, 'CATEGORY_NOT_FOUND', 'The category does not exist.');
    await this.assertExists(q, 'catalog.manufacturers', d.manufacturerId, 'MANUFACTURER_NOT_FOUND', 'The manufacturer does not exist.');
    await this.assertExists(q, 'catalog.dosage_forms', d.dosageFormId, 'DOSAGE_FORM_NOT_FOUND', 'The dosage form does not exist.');
    await this.assertExists(q, 'finance.tax_categories', d.taxCategoryId, 'TAX_CATEGORY_NOT_FOUND', 'The tax category does not exist.');
  }

  private assertStockLevels(min?: string | null, reorder?: string | null, max?: string | null) {
    const bad = (a?: string | null, b?: string | null) => a != null && b != null && cmp(a, b) > 0;
    if (bad(min, reorder) || bad(reorder, max) || bad(min, max)) {
      throw AppError.badRequest('INVALID_STOCK_LEVELS', 'Stock levels must satisfy: minimum <= reorder level <= maximum.');
    }
  }

  private async findDuplicates(q: Queryable, name: string, strength: string | undefined, dosageFormId: string | undefined, manufacturerId: string | undefined, excludeId?: string) {
    return many(q,
      `select id, sku, name, strength from catalog.products
        where lower(trim(name)) = lower(trim($1)) and lower(trim(coalesce(strength, ''))) = lower(trim($2))
          and dosage_form_id is not distinct from $3::uuid and manufacturer_id is not distinct from $4::uuid and ($5::uuid is null or id <> $5::uuid) limit 5`,
      [name, strength ?? '', dosageFormId ?? null, manufacturerId ?? null, excludeId ?? null]);
  }

  /** Builds the pack list: the base unit always exists with factor 1; other packs must be distinct and sensible. */
  private buildUnits(baseUnitId: string, units: UnitConfigDto[] = []): UnitConfigDto[] {
    const seen = new Set<string>([baseUnitId]);
    const result: UnitConfigDto[] = [{ unitId: baseUnitId, factorToBase: '1', isSellable: true, isPurchasable: true }];
    for (const u of units) {
      if (u.unitId === baseUnitId) {
        if (cmp(u.factorToBase, '1') !== 0) throw AppError.badRequest('BASE_UNIT_FACTOR', 'The base unit always has a factor of 1.');
        result[0] = { ...result[0], isSellable: u.isSellable ?? true, isPurchasable: u.isPurchasable ?? true };
        continue;
      }
      if (seen.has(u.unitId)) throw AppError.badRequest('DUPLICATE_UNIT', 'A unit appears more than once.');
      if (cmp(u.factorToBase, '0') <= 0) throw AppError.badRequest('INVALID_FACTOR', 'A pack must contain more than zero base units.');
      seen.add(u.unitId);
      result.push(u);
    }
    return result;
  }

  private async insertUnits(q: PoolClient, productId: string, units: UnitConfigDto[]) {
    for (const u of units) {
      await q.query(`insert into catalog.product_units (product_id, unit_id, factor_to_base, is_sellable, is_purchasable) values ($1, $2, $3, $4, $5)`,
        [productId, u.unitId, u.factorToBase, u.isSellable ?? true, u.isPurchasable ?? true]);
    }
  }

  private async assertUnitsExist(q: Queryable, unitIds: string[]) {
    const found = await many<{ id: string; is_active: boolean }>(q, `select id, is_active from catalog.units where id = any($1::uuid[])`, [unitIds]);
    if (found.length !== new Set(unitIds).size) throw AppError.badRequest('UNIT_NOT_FOUND', 'A selected unit does not exist.');
    if (found.some((f) => !f.is_active)) throw AppError.badRequest('UNIT_INACTIVE', 'A selected unit is no longer in use.');
  }

  // ---------- creating ----------
  async create(auth: AuthContext, dto: CreateProductDto) {
    const id = await this.db.tx((q) => this.createWithin(q, auth, dto));
    return this.get(id);
  }

  /** Registers one product inside the caller's transaction. The bulk importer reuses this, so imported rows obey exactly the same rules. */
  async createWithin(q: PoolClient, auth: AuthContext, dto: CreateProductDto): Promise<string> {
    if (dto.prices?.length && !auth.can('prices.change')) throw AppError.forbidden('PERMISSION_DENIED', 'You need the price-change permission to set prices.');
    this.assertStockLevels(dto.minStock, dto.reorderLevel, dto.maxStock);
    const units = this.buildUnits(dto.baseUnitId, dto.units);
    const unitIds = new Set(units.map((u) => u.unitId));
    for (const b of dto.barcodes ?? []) if (!unitIds.has(b.unitId)) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'A barcode refers to a unit the product does not have.');
    for (const p of dto.prices ?? []) if (!unitIds.has(p.unitId)) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'A price refers to a unit the product does not have.');
    if ((dto.barcodes ?? []).filter((b) => b.isPrimary).length > 1) throw AppError.badRequest('MULTIPLE_PRIMARY_BARCODES', 'Only one barcode can be primary.');

    await this.assertUnitsExist(q, [...unitIds]);
    await this.assertRefs(q, dto);
    if (!dto.confirmDuplicate) {
      const dups = await this.findDuplicates(q, dto.name, dto.strength, dto.dosageFormId, dto.manufacturerId);
      if (dups.length) throw AppError.conflict('POSSIBLE_DUPLICATE', 'A product with the same name, strength, form and manufacturer already exists.', { matches: dups });
    }
    const sku = dto.sku ?? (await this.sequences.next(q, 'product_sku'));
    const p = await one<{ id: string }>(q,
      `insert into catalog.products (sku, name, generic_name, brand_name, category_id, manufacturer_id, dosage_form_id, strength, base_unit_id,
              requires_prescription, is_controlled, registration_no, description, min_stock, max_stock, reorder_level, tax_category_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18) returning id`,
      [sku, dto.name.trim(), dto.genericName ?? null, dto.brandName ?? null, dto.categoryId ?? null, dto.manufacturerId ?? null, dto.dosageFormId ?? null, dto.strength ?? null,
        dto.baseUnitId, dto.requiresPrescription ?? false, dto.isControlled ?? false, dto.registrationNo ?? null, dto.description ?? null,
        dto.minStock ?? null, dto.maxStock ?? null, dto.reorderLevel ?? null, dto.taxCategoryId ?? null, auth.userId]);
    await this.insertUnits(q, p.id, units);
    for (const [i, b] of (dto.barcodes ?? []).entries()) await this.insertBarcode(q, auth, p.id, b.unitId, b.barcode, b.isPrimary ?? i === 0);
    for (const pr of dto.prices ?? []) await this.applyPrice(q, auth, p.id, pr.unitId, pr.priceType, pr.amount, 'Initial price');
    await this.audit.record({ action: 'product.created', entityType: 'product', entityId: p.id, newValue: { sku, ...dto } }, q);
    return p.id;
  }

  // ---------- editing ----------
  async update(auth: AuthContext, id: string, dto: UpdateProductDto) {
    const before = await this.get(id);
    this.assertStockLevels(dto.minStock ?? before.min_stock, dto.reorderLevel ?? before.reorder_level, dto.maxStock ?? before.max_stock);
    await this.db.tx(async (q) => {
      await this.assertRefs(q, dto);
      await updateVersioned(q, 'catalog.products', id, dto.version, {
        name: dto.name?.trim(), generic_name: dto.genericName, brand_name: dto.brandName, category_id: dto.categoryId, manufacturer_id: dto.manufacturerId,
        dosage_form_id: dto.dosageFormId, strength: dto.strength, requires_prescription: dto.requiresPrescription, is_controlled: dto.isControlled,
        registration_no: dto.registrationNo, description: dto.description, min_stock: dto.minStock, max_stock: dto.maxStock,
        reorder_level: dto.reorderLevel, tax_category_id: dto.taxCategoryId,
      }, auth.userId, notFound);
      await this.audit.record({ action: 'product.updated', entityType: 'product', entityId: id, oldValue: { name: before.name, strength: before.strength, requiresPrescription: before.requires_prescription, categoryId: before.category_id }, newValue: dto }, q);
    });
    return this.get(id);
  }

  async setActive(auth: AuthContext, id: string, active: boolean, version: number) {
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'catalog.products', id, version, { is_active: active }, auth.userId, notFound);
      await this.audit.record({ action: active ? 'product.activated' : 'product.deactivated', entityType: 'product', entityId: id }, q);
    });
    return this.get(id);
  }

  /** Replaces the larger packs of a product. Blocked once the product has been bought, stocked or sold. */
  async setUnits(auth: AuthContext, id: string, input: UnitConfigDto[]) {
    const p = await this.get(id);
    const units = this.buildUnits(p.base_unit_id, input);
    await this.db.tx(async (q) => {
      await q.query(`select 1 from catalog.products where id = $1 for update`, [id]);
      if (await isProductInUse(q, id)) throw AppError.conflict('PRODUCT_IN_USE', 'This product already has stock or transactions, so its pack sizes can no longer change.');
      await this.assertUnitsExist(q, units.map((u) => u.unitId));
      const current = await this.units(q, id);
      const wanted = new Map(units.map((u) => [u.unitId, u]));
      for (const c of current) {
        const w = wanted.get(c.unit_id);
        if (!w) {
          const refs = await maybeOne(q, `select 1 from catalog.product_barcodes where product_id = $1 and unit_id = $2 union all select 1 from catalog.product_prices where product_id = $1 and unit_id = $2 limit 1`, [id, c.unit_id]);
          if (refs) throw AppError.conflict('UNIT_HAS_BARCODES_OR_PRICES', `Remove the barcodes and prices of the ${c.code} pack before removing it.`);
          await q.query(`delete from catalog.product_units where product_id = $1 and unit_id = $2`, [id, c.unit_id]);
        } else {
          await q.query(`update catalog.product_units set factor_to_base = $3, is_sellable = $4, is_purchasable = $5 where product_id = $1 and unit_id = $2`, [id, c.unit_id, w.factorToBase, w.isSellable ?? true, w.isPurchasable ?? true]);
        }
      }
      const have = new Set(current.map((c) => c.unit_id));
      await this.insertUnits(q, id, units.filter((u) => !have.has(u.unitId)));
      await this.audit.record({ action: 'product.units_changed', entityType: 'product', entityId: id, oldValue: current.map((c) => ({ unitId: c.unit_id, factor: c.factor_to_base })), newValue: units }, q);
    });
    return this.get(id);
  }

  // ---------- barcodes ----------
  private async insertBarcode(q: PoolClient, auth: AuthContext, productId: string, unitId: string, barcode: string, isPrimary: boolean) {
    const clash = await maybeOne<{ product_id: string; sku: string }>(q, `select b.product_id, p.sku from catalog.product_barcodes b join catalog.products p on p.id = b.product_id where b.barcode = $1`, [barcode]);
    if (clash) throw AppError.conflict('BARCODE_IN_USE', 'This barcode already belongs to a product.', { productId: clash.product_id, sku: clash.sku });
    if (isPrimary) await q.query(`update catalog.product_barcodes set is_primary = false where product_id = $1 and is_primary`, [productId]);
    await q.query(`insert into catalog.product_barcodes (product_id, unit_id, barcode, is_primary, created_by) values ($1, $2, $3, $4, $5)`, [productId, unitId, barcode, isPrimary, auth.userId]);
  }

  async addBarcode(auth: AuthContext, id: string, dto: { unitId: string; barcode: string; isPrimary?: boolean }) {
    await this.get(id);
    await this.db.tx(async (q) => {
      if (!(await maybeOne(q, `select 1 from catalog.product_units where product_id = $1 and unit_id = $2`, [id, dto.unitId]))) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this unit.');
      const first = !(await maybeOne(q, `select 1 from catalog.product_barcodes where product_id = $1`, [id]));
      await this.insertBarcode(q, auth, id, dto.unitId, dto.barcode, dto.isPrimary ?? first);
      await this.audit.record({ action: 'product.barcode_added', entityType: 'product', entityId: id, newValue: dto }, q);
    });
    return this.get(id);
  }

  async removeBarcode(auth: AuthContext, id: string, barcodeId: string) {
    await this.db.tx(async (q) => {
      const b = await maybeOne<{ barcode: string; is_primary: boolean }>(q, `delete from catalog.product_barcodes where id = $1 and product_id = $2 returning barcode, is_primary`, [barcodeId, id]);
      if (!b) throw AppError.notFound('BARCODE_NOT_FOUND', 'Barcode not found.');
      if (b.is_primary) await q.query(`update catalog.product_barcodes set is_primary = true where id = (select id from catalog.product_barcodes where product_id = $1 order by created_at limit 1)`, [id]);
      await this.audit.record({ action: 'product.barcode_removed', entityType: 'product', entityId: id, oldValue: { barcode: b.barcode } }, q);
    });
    return this.get(id);
  }

  // ---------- prices ----------
  async applyPrice(q: PoolClient, auth: AuthContext, productId: string, unitId: string, priceType: string, amount: string, reason: string): Promise<string[]> {
    // Locking the pack row first makes simultaneous price changes for it queue up instead of colliding
    const unit = await maybeOne(q, `select 1 from catalog.product_units where product_id = $1 and unit_id = $2 for update`, [productId, unitId]);
    if (!unit) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have this unit.');
    const cur = await maybeOne<{ id: string; amount: string }>(q, `select id, amount from catalog.product_prices where product_id = $1 and unit_id = $2 and price_type = $3 and effective_to is null for update`, [productId, unitId, priceType]);
    if (cur && cmp(cur.amount, amount) === 0) throw AppError.badRequest('PRICE_UNCHANGED', 'The new price is the same as the current price.');
    // The real time now, not the transaction's start time: when changes queue behind the lock above, a transaction that
    // started earlier may run later, and the old price must always end after it began.
    const at = (await one<{ t: Date }>(q, `select clock_timestamp() as t`)).t;
    if (cur) await q.query(`update catalog.product_prices set effective_to = $2 where id = $1`, [cur.id, at]);
    await q.query(`insert into catalog.product_prices (product_id, unit_id, price_type, amount, effective_from, created_by) values ($1, $2, $3, $4, $5, $6)`, [productId, unitId, priceType, amount, at, auth.userId]);
    await q.query(`insert into catalog.price_change_log (product_id, unit_id, price_type, old_amount, new_amount, reason, changed_by) values ($1, $2, $3, $4, $5, $6, $7)`, [productId, unitId, priceType, cur?.amount ?? null, amount, reason, auth.userId]);
    await this.audit.record({ action: 'price.changed', entityType: 'product', entityId: productId, oldValue: cur ? { priceType, unitId, amount: cur.amount } : null, newValue: { priceType, unitId, amount, reason } }, q);
    const both = await many<{ price_type: string; amount: string }>(q, `select price_type, amount from catalog.product_prices where product_id = $1 and unit_id = $2 and effective_to is null and price_type in ('purchase', 'selling')`, [productId, unitId]);
    const purchase = both.find((b) => b.price_type === 'purchase')?.amount, selling = both.find((b) => b.price_type === 'selling')?.amount;
    return purchase && selling && cmp(selling, purchase) < 0 ? ['The selling price is below the purchase price for this pack.'] : [];
  }

  async changePrice(auth: AuthContext, id: string, dto: ChangePriceDto) {
    await this.get(id);
    const warnings = await this.db.tx((q) => this.applyPrice(q, auth, id, dto.unitId, dto.priceType, dto.amount, dto.reason));
    return { product: await this.get(id), warnings };
  }

  async priceHistory(id: string) {
    await this.get(id);
    return many(this.db,
      `select l.unit_id, u.code as unit_code, l.price_type, l.old_amount, l.new_amount, l.reason, l.changed_at, us.username as changed_by
         from catalog.price_change_log l join catalog.units u on u.id = l.unit_id left join iam.users us on us.id = l.changed_by
        where l.product_id = $1 order by l.changed_at desc, l.id`, [id]);
  }

  // ---------- conversion ----------
  async convert(id: string, dto: { quantity: string; fromUnitId: string; toUnitId: string }) {
    const units = await this.units(this.db, (await this.get(id)).id);
    const from = units.find((u) => u.unit_id === dto.fromUnitId), to = units.find((u) => u.unit_id === dto.toUnitId);
    if (!from || !to) throw AppError.badRequest('UNIT_NOT_CONFIGURED', 'The product does not have one of these units.');
    try {
      return { quantity: dto.quantity, from: from.code, to: to.code, result: convertQuantity(dto.quantity, from.factor_to_base, to.factor_to_base) };
    } catch (e) {
      if (e instanceof DecimalError) throw new AppError(422, e.code, e.message);
      throw e;
    }
  }
}
