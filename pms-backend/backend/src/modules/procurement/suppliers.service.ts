import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { likePattern, offsetOf, Page, PageQuery } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { SequenceService } from '../platform/sequence.service';

const notFound = () => AppError.notFound('SUPPLIER_NOT_FOUND', 'Supplier not found.');
const COLS = `id, code, name, contact_person, phone, email, address, tax_id, registration_no, payment_terms_days, credit_limit, bank_details, status, rating, version`;

export interface SupplierInput {
  code?: string; name: string; contactPerson?: string; phone?: string; email?: string; address?: string; taxId?: string;
  registrationNo?: string; paymentTermsDays?: number; creditLimit?: string; bankDetails?: string; rating?: string;
}

@Injectable()
export class SuppliersService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly sequences: SequenceService) {}

  async list(q: PageQuery & { status?: string }): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where: string[] = ['true'];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.search) { params.push(likePattern(q.search)); where.push(`(name ilike $${params.length} or code ilike $${params.length} or contact_person ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from procurement.suppliers where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select ${COLS} from procurement.suppliers where ${w} order by name limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string) {
    const s = await maybeOne(this.db, `select ${COLS} from procurement.suppliers where id = $1`, [id]);
    if (!s) throw notFound();
    return s;
  }

  async create(auth: AuthContext, dto: SupplierInput) {
    const id = await this.db.tx(async (q) => {
      const code = dto.code ?? (await this.sequences.next(q, 'supplier'));
      const s = await one<{ id: string }>(q,
        `insert into procurement.suppliers (code, name, contact_person, phone, email, address, tax_id, registration_no, payment_terms_days, credit_limit, bank_details, rating, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::int, 0), coalesce($10::numeric, 0), $11, $12, $13, $13) returning id`,
        [code, dto.name, dto.contactPerson ?? null, dto.phone ?? null, dto.email ?? null, dto.address ?? null, dto.taxId ?? null, dto.registrationNo ?? null,
          dto.paymentTermsDays ?? null, dto.creditLimit ?? null, dto.bankDetails ?? null, dto.rating ?? null, auth.userId]);
      await this.audit.record({ action: 'supplier.created', entityType: 'supplier', entityId: s.id, newValue: { ...dto, code } }, q);
      return s.id;
    });
    return this.get(id);
  }

  async update(auth: AuthContext, id: string, dto: Partial<SupplierInput> & { version: number; status?: 'active' | 'inactive' | 'blocked' }) {
    const before = await this.get(id);
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'procurement.suppliers', id, dto.version, {
        name: dto.name, contact_person: dto.contactPerson, phone: dto.phone, email: dto.email, address: dto.address, tax_id: dto.taxId,
        registration_no: dto.registrationNo, payment_terms_days: dto.paymentTermsDays, credit_limit: dto.creditLimit,
        bank_details: dto.bankDetails, rating: dto.rating, status: dto.status,
      }, auth.userId, notFound);
      await this.audit.record({ action: 'supplier.updated', entityType: 'supplier', entityId: id, oldValue: before, newValue: dto }, q);
    });
    return this.get(id);
  }

  // ---- supplier product catalog ----
  async listProducts(id: string) {
    await this.get(id);
    return many(this.db, `select ps.product_id, p.sku, p.name, ps.supplier_sku, ps.last_price from catalog.product_suppliers ps join catalog.products p on p.id = ps.product_id where ps.supplier_id = $1 order by p.name`, [id]);
  }

  async linkProduct(auth: AuthContext, supplierId: string, productId: string, dto: { supplierSku?: string; lastPrice?: string }) {
    await this.get(supplierId);
    if (!(await maybeOne(this.db, `select 1 from catalog.products where id = $1`, [productId]))) throw AppError.badRequest('PRODUCT_NOT_FOUND', 'The product does not exist.');
    await this.db.tx(async (q) => {
      await q.query(`insert into catalog.product_suppliers (product_id, supplier_id, supplier_sku, last_price) values ($1, $2, $3, $4)
                     on conflict (product_id, supplier_id) do update set supplier_sku = excluded.supplier_sku, last_price = excluded.last_price`, [productId, supplierId, dto.supplierSku ?? null, dto.lastPrice ?? null]);
      await this.audit.record({ action: 'supplier.product_linked', entityType: 'supplier', entityId: supplierId, newValue: { productId, ...dto } }, q);
    });
    return this.listProducts(supplierId);
  }

  async unlinkProduct(auth: AuthContext, supplierId: string, productId: string) {
    await this.get(supplierId);
    await this.db.tx(async (q) => {
      await q.query(`delete from catalog.product_suppliers where supplier_id = $1 and product_id = $2`, [supplierId, productId]);
      await this.audit.record({ action: 'supplier.product_unlinked', entityType: 'supplier', entityId: supplierId, newValue: { productId } }, q);
    });
  }
}
