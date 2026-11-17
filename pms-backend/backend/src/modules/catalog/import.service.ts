import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { parseCsv, toCsv } from '../../domain/csv';
import { AuditService } from '../audit/audit.service';
import { CreateProductDto } from './products.dto';
import { ProductsService } from './products.service';

export const IMPORT_COLUMNS = ['name', 'sku', 'generic_name', 'brand_name', 'strength', 'dosage_form', 'category', 'manufacturer', 'base_unit', 'pack_units', 'barcode', 'barcode_unit',
  'requires_prescription', 'is_controlled', 'registration_no', 'min_stock', 'reorder_level', 'max_stock', 'price_unit', 'selling_price', 'purchase_price', 'tax_category', 'description'];
const REQUIRED = ['name', 'base_unit'];
const MAX_ROWS = 5000;
const DECIMAL = /^\d{1,14}(\.\d{1,4})?$/;

export type RowStatus = 'ok' | 'duplicate' | 'error';
export interface RowResult { line: number; status: RowStatus; name: string; sku?: string; messages: string[] }
type Row = Record<string, string>;

class RowProblems extends Error { constructor(readonly messages: string[]) { super(messages.join('; ')); } }

@Injectable()
export class ImportService {
  constructor(private readonly db: DatabaseService, private readonly products: ProductsService, private readonly audit: AuditService) {}

  template(): string {
    return toCsv([IMPORT_COLUMNS, ['Paracetamol 500 mg', '', 'Paracetamol', 'Panadol', '500 mg', 'Tablet', 'Analgesics > Mild', 'GSK', 'tablet', 'strip=10;box=100', '6001234500011', 'strip', 'no', 'no', 'EFDA/123', '100', '200', '5000', 'strip', '25.50', '18.00', '', 'Pain and fever relief']]);
  }

  private parseFile(text: string): Array<{ line: number; row: Row }> {
    if (text.includes('\u0000')) throw AppError.badRequest('INVALID_IMPORT_FILE', 'The file does not look like a CSV text file.');
    let grid: string[][];
    try { grid = parseCsv(text); } catch (e) { throw AppError.badRequest('INVALID_IMPORT_FILE', (e as Error).message); }
    if (grid.length < 2) throw AppError.badRequest('INVALID_IMPORT_FILE', 'The file needs a header row and at least one product row.');
    const header = grid[0].map((h) => h.trim().toLowerCase());
    const unknown = header.filter((h) => h && !IMPORT_COLUMNS.includes(h));
    const missing = REQUIRED.filter((r) => !header.includes(r));
    const dupes = header.filter((h, i) => h && header.indexOf(h) !== i);
    if (unknown.length || missing.length || dupes.length) throw AppError.badRequest('INVALID_IMPORT_FILE', 'The header row is not valid.', { unknownColumns: unknown, missingColumns: missing, duplicateColumns: [...new Set(dupes)] });
    const rows: Array<{ line: number; row: Row }> = [];
    grid.slice(1).forEach((cells, i) => {
      if (cells.every((c) => c.trim() === '')) return;
      const row: Row = {};
      header.forEach((h, idx) => { if (h) row[h] = (cells[idx] ?? '').trim(); });
      rows.push({ line: i + 2, row });
    });
    if (rows.length === 0) throw AppError.badRequest('INVALID_IMPORT_FILE', 'The file has no product rows.');
    if (rows.length > MAX_ROWS) throw AppError.badRequest('TOO_MANY_ROWS', `A file can hold at most ${MAX_ROWS} products.`);
    return rows;
  }

  // ---- turning one CSV row into a product, reporting every problem at once ----
  private async rowToDto(q: PoolClient, r: Row, autoCreate: boolean, auth: AuthContext): Promise<CreateProductDto> {
    const problems: string[] = [];
    const bool = (col: string): boolean | undefined => {
      const v = (r[col] ?? '').toLowerCase();
      if (v === '') return undefined;
      if (['yes', 'true', '1', 'y'].includes(v)) return true;
      if (['no', 'false', '0', 'n'].includes(v)) return false;
      problems.push(`${col}: "${r[col]}" is not yes or no`); return undefined;
    };
    const dec = (col: string): string | undefined => {
      const v = r[col] ?? '';
      if (v === '') return undefined;
      if (!DECIMAL.test(v)) { problems.push(`${col}: "${v}" is not a valid non-negative number (up to 4 decimals)`); return undefined; }
      return v;
    };
    const unitByCode = async (v: string, col: string): Promise<string | undefined> => {
      const u = await maybeOne<{ id: string }>(q, `select id from catalog.units where is_active and (lower(code) = lower($1) or lower(name) = lower($1))`, [v]);
      if (!u) problems.push(`${col}: unit "${v}" does not exist`);
      return u?.id;
    };

    if (!r.name) problems.push('name is required');
    const baseUnitId = r.base_unit ? await unitByCode(r.base_unit, 'base_unit') : undefined;
    if (!r.base_unit) problems.push('base_unit is required');

    const units: Array<{ unitId: string; factorToBase: string }> = [];
    for (const part of (r.pack_units ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
      const [code, factor] = part.split('=').map((x) => x.trim());
      if (!code || !factor || !DECIMAL.test(factor) || Number(factor) <= 0) { problems.push(`pack_units: "${part}" must look like strip=10`); continue; }
      const id = await unitByCode(code, 'pack_units');
      if (id) units.push({ unitId: id, factorToBase: factor });
    }
    const packIds = new Set([baseUnitId, ...units.map((u) => u.unitId)]);

    const lookup = async (table: string, col: string, value: string, label: string): Promise<string | undefined> => {
      const row = await maybeOne<{ id: string }>(q, `select id from ${table} where ${col} = $1`, [value]); // table and column names are constants below
      if (!row) problems.push(`${label} "${value}" does not exist`);
      return row?.id;
    };
    let dosageFormId: string | undefined, taxCategoryId: string | undefined, manufacturerId: string | undefined, categoryId: string | undefined;
    if (r.dosage_form) dosageFormId = await lookup('catalog.dosage_forms', 'name', r.dosage_form, 'dosage_form');
    if (r.tax_category) taxCategoryId = await lookup('finance.tax_categories', 'name', r.tax_category, 'tax_category');
    if (r.manufacturer) {
      const m = await maybeOne<{ id: string }>(q, `select id from catalog.manufacturers where name = $1`, [r.manufacturer]);
      if (m) manufacturerId = m.id;
      else if (autoCreate) manufacturerId = (await one<{ id: string }>(q, `insert into catalog.manufacturers (name, created_by, updated_by) values ($1, $2, $2) returning id`, [r.manufacturer, auth.userId])).id;
      else problems.push(`manufacturer "${r.manufacturer}" does not exist (tick "create missing categories and manufacturers" to add it)`);
    }
    if (r.category) {
      let parent: string | null = null;
      for (const name of r.category.split('>').map((s) => s.trim()).filter(Boolean)) {
        let node: { id: string } | null = await maybeOne<{ id: string }>(q, `select id from catalog.categories where name = $1 and parent_id is not distinct from $2::uuid`, [name, parent]);
        if (!node && autoCreate) node = await one<{ id: string }>(q, `insert into catalog.categories (name, parent_id, created_by, updated_by) values ($1, $2, $3, $3) returning id`, [name, parent, auth.userId]);
        if (!node) { problems.push(`category "${name}" does not exist (tick "create missing categories and manufacturers" to add it)`); parent = null; break; }
        parent = node.id;
      }
      categoryId = parent ?? undefined;
    }

    const barcodes: CreateProductDto['barcodes'] = [];
    if (r.barcode) {
      const bu = r.barcode_unit ? await unitByCode(r.barcode_unit, 'barcode_unit') : baseUnitId;
      if (bu && !packIds.has(bu)) problems.push('barcode_unit: the product does not have that unit (add it to pack_units)');
      else if (bu) barcodes.push({ unitId: bu, barcode: r.barcode });
    }
    const prices: CreateProductDto['prices'] = [];
    const sell = dec('selling_price'), buy = dec('purchase_price');
    if (sell !== undefined || buy !== undefined) {
      const pu = r.price_unit ? await unitByCode(r.price_unit, 'price_unit') : baseUnitId;
      if (pu && !packIds.has(pu)) problems.push('price_unit: the product does not have that unit (add it to pack_units)');
      else if (pu) {
        if (sell !== undefined) prices.push({ unitId: pu, priceType: 'selling', amount: sell });
        if (buy !== undefined) prices.push({ unitId: pu, priceType: 'purchase', amount: buy });
      }
    }
    const requiresPrescription = bool('requires_prescription'), isControlled = bool('is_controlled');
    const minStock = dec('min_stock'), reorderLevel = dec('reorder_level'), maxStock = dec('max_stock');
    if (problems.length) throw new RowProblems(problems);
    return {
      sku: r.sku || undefined, name: r.name, genericName: r.generic_name || undefined, brandName: r.brand_name || undefined, strength: r.strength || undefined,
      dosageFormId, categoryId, manufacturerId, baseUnitId: baseUnitId!, units, barcodes, prices, requiresPrescription, isControlled,
      registrationNo: r.registration_no || undefined, description: r.description || undefined, minStock, reorderLevel, maxStock, taxCategoryId,
    } as CreateProductDto;
  }

  /** Runs every row inside the transaction using savepoints, so one bad row never spoils the others. */
  private async runRows(q: PoolClient, auth: AuthContext, rows: Array<{ line: number; row: Row }>, autoCreate: boolean, confirmDuplicates: boolean): Promise<RowResult[]> {
    const results: RowResult[] = [];
    for (const { line, row } of rows) {
      await q.query('SAVEPOINT import_row');
      try {
        const dto = await this.rowToDto(q, row, autoCreate, auth);
        dto.confirmDuplicate = confirmDuplicates;
        const id = await this.products.createWithin(q, auth, dto);
        const sku = (await one<{ sku: string }>(q, `select sku from catalog.products where id = $1`, [id])).sku;
        await q.query('RELEASE SAVEPOINT import_row');
        results.push({ line, status: 'ok', name: row.name, sku, messages: [] });
      } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT import_row');
        if (e instanceof RowProblems) results.push({ line, status: 'error', name: row.name, messages: e.messages });
        else if (e instanceof AppError && e.code === 'POSSIBLE_DUPLICATE') {
          const m = ((e.details as { matches?: Array<{ sku: string; name: string }> })?.matches ?? []).map((x) => `${x.sku} ${x.name}`);
          results.push({ line, status: 'duplicate', name: row.name, messages: [`Looks like an existing product: ${m.join(', ')}`] });
        } else if (e instanceof AppError) results.push({ line, status: 'error', name: row.name, messages: [e.message] });
        else throw e;
      }
    }
    return results;
  }

  private summarize(results: RowResult[]) {
    return { total: results.length, ok: results.filter((r) => r.status === 'ok').length, duplicates: results.filter((r) => r.status === 'duplicate').length, errors: results.filter((r) => r.status === 'error').length };
  }

  /** Dry run: everything is validated against the real database, then rolled back. Nothing is created and no SKU numbers are used up. */
  async preview(auth: AuthContext, fileName: string, text: string, autoCreate: boolean) {
    const rows = this.parseFile(text);
    // Its own connection and a transaction that is always rolled back: validation sees the real data, nothing is kept
    const client = await this.db.pool.connect();
    let results: RowResult[];
    try {
      await client.query('BEGIN');
      results = await this.runRows(client, auth, rows, autoCreate, false);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const summary = this.summarize(results);
    const job = await one<{ id: string }>(this.db, `insert into catalog.import_jobs (file_name, row_count, summary, rows, auto_create, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [fileName.slice(0, 200), rows.length, JSON.stringify({ ...summary, results }), JSON.stringify(rows), autoCreate, auth.userId]);
    return { jobId: job.id, fileName, ...summary, results };
  }

  async getJob(auth: AuthContext, id: string) {
    const j = await maybeOne<{ created_by: string; summary: object }>(this.db, `select id, file_name, status, row_count, summary, auto_create, created_by, created_at, committed_at from catalog.import_jobs where id = $1`, [id]);
    if (!j || j.created_by !== auth.userId) throw AppError.notFound('IMPORT_NOT_FOUND', 'Import not found.');
    return j;
  }

  async commit(auth: AuthContext, id: string, opts: { skipInvalid?: boolean; confirmDuplicates?: boolean }) {
    await this.getJob(auth, id);
    const outcome = await this.db.tx(async (q) => {
      const job = await one<{ status: string; rows: Array<{ line: number; row: Row }>; auto_create: boolean }>(q, `select status, rows, auto_create from catalog.import_jobs where id = $1 for update`, [id]);
      if (job.status !== 'previewed') throw AppError.conflict('IMPORT_ALREADY_DONE', 'This import has already been committed or cancelled.');
      const results = await this.runRows(q, auth, job.rows, job.auto_create, opts.confirmDuplicates === true);
      const bad = results.filter((r) => r.status !== 'ok');
      if (bad.length && !opts.skipInvalid) throw AppError.conflict('IMPORT_HAS_PROBLEMS', 'Some rows have problems. Fix the file, or choose to skip the problem rows.', { ...this.summarize(results), results });
      await q.query(`update catalog.import_jobs set status = 'committed', committed_by = $2, committed_at = now() where id = $1`, [id, auth.userId]);
      const summary = this.summarize(results);
      await this.audit.record({ action: 'product.import_committed', entityType: 'import_job', entityId: id, newValue: summary }, q);
      return { ...summary, results };
    });
    return { created: outcome.ok, skipped: outcome.total - outcome.ok, ...outcome };
  }
}
