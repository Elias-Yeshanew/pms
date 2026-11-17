import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

const nf = (what: string, code: string) => () => AppError.notFound(code, `${what} not found.`);

/** Units, dosage forms, categories and manufacturers: the small lists products are described with. */
@Injectable()
export class ReferenceService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  // ---- units ----
  listUnits() { return many(this.db, `select id, code, name, is_active, version from catalog.units order by name`); }
  async createUnit(auth: AuthContext, dto: { code: string; name: string }) {
    return this.db.tx(async (q) => {
      const u = await one(q, `insert into catalog.units (code, name) values ($1, $2) returning id, code, name, is_active, version`, [dto.code, dto.name]);
      await this.audit.record({ action: 'unit.created', entityType: 'unit', entityId: u.id, newValue: dto }, q);
      return u;
    });
  }
  async updateUnit(auth: AuthContext, id: string, dto: { version: number; name?: string; isActive?: boolean }) {
    return this.db.tx(async (q) => {
      const u = await updateVersioned(q, 'catalog.units', id, dto.version, { name: dto.name, is_active: dto.isActive }, auth.userId, nf('Unit', 'UNIT_NOT_FOUND'));
      await this.audit.record({ action: 'unit.updated', entityType: 'unit', entityId: id, newValue: dto }, q);
      return { id: u.id, code: u.code, name: u.name, is_active: u.is_active, version: u.version };
    });
  }

  // ---- dosage forms ----
  listDosageForms() { return many(this.db, `select id, name, version from catalog.dosage_forms order by name`); }
  async createDosageForm(auth: AuthContext, dto: { name: string }) {
    return this.db.tx(async (q) => {
      const f = await one(q, `insert into catalog.dosage_forms (name) values ($1) returning id, name, version`, [dto.name]);
      await this.audit.record({ action: 'dosage_form.created', entityType: 'dosage_form', entityId: f.id, newValue: dto }, q);
      return f;
    });
  }

  // ---- categories ----
  listCategories() { return many(this.db, `select id, parent_id, name, is_active, version from catalog.categories order by name`); }

  async createCategory(auth: AuthContext, dto: { name: string; parentId?: string }) {
    if (dto.parentId && !(await maybeOne(this.db, `select 1 from catalog.categories where id = $1`, [dto.parentId]))) throw AppError.badRequest('PARENT_NOT_FOUND', 'The parent category does not exist.');
    return this.db.tx(async (q) => {
      const c = await one(q, `insert into catalog.categories (name, parent_id, created_by, updated_by) values ($1, $2, $3, $3) returning id, parent_id, name, is_active, version`, [dto.name, dto.parentId ?? null, auth.userId]);
      await this.audit.record({ action: 'category.created', entityType: 'category', entityId: c.id, newValue: dto }, q);
      return c;
    });
  }

  async updateCategory(auth: AuthContext, id: string, dto: { version: number; name?: string; parentId?: string; isActive?: boolean }) {
    if (dto.parentId) {
      if (dto.parentId === id) throw AppError.badRequest('CATEGORY_CYCLE', 'A category cannot be its own parent.');
      const cycle = await maybeOne(this.db,
        `with recursive anc as (select id, parent_id from catalog.categories where id = $1
           union all select c.id, c.parent_id from catalog.categories c join anc on c.id = anc.parent_id)
         select 1 from anc where id = $2`, [dto.parentId, id]);
      if (cycle) throw AppError.badRequest('CATEGORY_CYCLE', 'A category cannot be moved under one of its own subcategories.');
    }
    return this.db.tx(async (q) => {
      const c = await updateVersioned(q, 'catalog.categories', id, dto.version, { name: dto.name, parent_id: dto.parentId, is_active: dto.isActive }, auth.userId, nf('Category', 'CATEGORY_NOT_FOUND'));
      await this.audit.record({ action: 'category.updated', entityType: 'category', entityId: id, newValue: dto }, q);
      return { id: c.id, parent_id: c.parent_id, name: c.name, is_active: c.is_active, version: c.version };
    });
  }

  // ---- manufacturers ----
  listManufacturers() { return many(this.db, `select id, name, country, status, version from catalog.manufacturers order by name`); }
  async createManufacturer(auth: AuthContext, dto: { name: string; country?: string }) {
    return this.db.tx(async (q) => {
      const m = await one(q, `insert into catalog.manufacturers (name, country, created_by, updated_by) values ($1, $2, $3, $3) returning id, name, country, status, version`, [dto.name, dto.country ?? null, auth.userId]);
      await this.audit.record({ action: 'manufacturer.created', entityType: 'manufacturer', entityId: m.id, newValue: dto }, q);
      return m;
    });
  }
  async updateManufacturer(auth: AuthContext, id: string, dto: { version: number; name?: string; country?: string; status?: 'active' | 'inactive' }) {
    return this.db.tx(async (q) => {
      const m = await updateVersioned(q, 'catalog.manufacturers', id, dto.version, { name: dto.name, country: dto.country, status: dto.status }, auth.userId, nf('Manufacturer', 'MANUFACTURER_NOT_FOUND'));
      await this.audit.record({ action: 'manufacturer.updated', entityType: 'manufacturer', entityId: id, newValue: dto }, q);
      return { id: m.id, name: m.name, country: m.country, status: m.status, version: m.version };
    });
  }
}
