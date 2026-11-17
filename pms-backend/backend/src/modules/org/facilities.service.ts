import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';

const whNotFound = () => AppError.notFound('WAREHOUSE_NOT_FOUND', 'Warehouse not found.');
const locNotFound = () => AppError.notFound('LOCATION_NOT_FOUND', 'Storage location not found.');
const regNotFound = () => AppError.notFound('REGISTER_NOT_FOUND', 'Cash register not found.');
const outOfScope = () => AppError.forbidden('OUT_OF_SCOPE', 'You do not have access to this branch.');

/** Warehouses, storage locations and cash registers: everything physical that belongs to one branch. */
@Injectable()
export class FacilitiesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  private async assertBranch(branchId: string) {
    if (!(await maybeOne(this.db, `select 1 from org.branches where id = $1`, [branchId]))) throw AppError.badRequest('BRANCH_NOT_FOUND', 'The branch does not exist.');
  }

  // ---- warehouses ----
  listWarehouses(auth: AuthContext, branchId?: string) {
    const params: unknown[] = [];
    const where = [auth.scopeFor('warehouses.read').sql('w.branch_id', params)];
    if (branchId) { params.push(branchId); where.push(`w.branch_id = $${params.length}`); }
    return many(this.db, `select w.id, w.branch_id, w.code, w.name, w.status, w.version from org.warehouses w where ${where.join(' and ')} order by w.branch_id, w.code`, params);
  }

  async createWarehouse(auth: AuthContext, dto: { branchId: string; code: string; name: string }) {
    if (!auth.scopeFor('warehouses.manage').includes(dto.branchId)) throw outOfScope();
    await this.assertBranch(dto.branchId);
    return this.db.tx(async (q) => {
      const w = await one(q, `insert into org.warehouses (branch_id, code, name, created_by, updated_by) values ($1, $2, $3, $4, $4) returning id, branch_id, code, name, status, version`, [dto.branchId, dto.code, dto.name, auth.userId]);
      await this.audit.record({ action: 'warehouse.created', entityType: 'warehouse', entityId: w.id, branchId: dto.branchId, newValue: dto }, q);
      return w;
    });
  }

  private async warehouseBranch(id: string): Promise<string> {
    const w = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from org.warehouses where id = $1`, [id]);
    if (!w) throw whNotFound();
    return w.branch_id;
  }

  async updateWarehouse(auth: AuthContext, id: string, dto: { version: number; name?: string; status?: 'active' | 'inactive' }) {
    const branchId = await this.warehouseBranch(id);
    if (!auth.scopeFor('warehouses.manage').includes(branchId)) throw whNotFound();
    return this.db.tx(async (q) => {
      const w = await updateVersioned(q, 'org.warehouses', id, dto.version, { name: dto.name, status: dto.status }, auth.userId, whNotFound);
      await this.audit.record({ action: 'warehouse.updated', entityType: 'warehouse', entityId: id, branchId, newValue: dto }, q);
      return { id: w.id, branch_id: w.branch_id, code: w.code, name: w.name, status: w.status, version: w.version };
    });
  }

  // ---- storage locations ----
  async listLocations(auth: AuthContext, warehouseId: string) {
    const branchId = await this.warehouseBranch(warehouseId);
    if (!auth.scopeFor('warehouses.read').includes(branchId)) throw whNotFound();
    return many(this.db, `select id, warehouse_id, code, name, temperature_zone, status, version from org.storage_locations where warehouse_id = $1 order by code`, [warehouseId]);
  }

  async createLocation(auth: AuthContext, dto: { warehouseId: string; code: string; name: string; temperatureZone?: string }) {
    const branchId = await this.warehouseBranch(dto.warehouseId);
    if (!auth.scopeFor('warehouses.manage').includes(branchId)) throw whNotFound();
    return this.db.tx(async (q) => {
      const l = await one(q, `insert into org.storage_locations (warehouse_id, code, name, temperature_zone, created_by, updated_by) values ($1, $2, $3, coalesce($4, 'ambient'), $5, $5)
                              returning id, warehouse_id, code, name, temperature_zone, status, version`, [dto.warehouseId, dto.code, dto.name, dto.temperatureZone ?? null, auth.userId]);
      await this.audit.record({ action: 'storage_location.created', entityType: 'storage_location', entityId: l.id, branchId, newValue: dto }, q);
      return l;
    });
  }

  async updateLocation(auth: AuthContext, id: string, dto: { version: number; name?: string; temperatureZone?: string; status?: 'active' | 'inactive' }) {
    const loc = await maybeOne<{ branch_id: string }>(this.db, `select w.branch_id from org.storage_locations l join org.warehouses w on w.id = l.warehouse_id where l.id = $1`, [id]);
    if (!loc || !auth.scopeFor('warehouses.manage').includes(loc.branch_id)) throw locNotFound();
    return this.db.tx(async (q) => {
      const l = await updateVersioned(q, 'org.storage_locations', id, dto.version, { name: dto.name, temperature_zone: dto.temperatureZone, status: dto.status }, auth.userId, locNotFound);
      await this.audit.record({ action: 'storage_location.updated', entityType: 'storage_location', entityId: id, branchId: loc.branch_id, newValue: dto }, q);
      return { id: l.id, warehouse_id: l.warehouse_id, code: l.code, name: l.name, temperature_zone: l.temperature_zone, status: l.status, version: l.version };
    });
  }

  // ---- cash registers ----
  listRegisters(auth: AuthContext, branchId?: string) {
    const params: unknown[] = [];
    const where = [auth.scopeFor('registers.read').sql('r.branch_id', params)];
    if (branchId) { params.push(branchId); where.push(`r.branch_id = $${params.length}`); }
    return many(this.db, `select r.id, r.branch_id, r.code, r.name, r.status, r.offline_mode, r.version from org.cash_registers r where ${where.join(' and ')} order by r.branch_id, r.code`, params);
  }

  async createRegister(auth: AuthContext, dto: { branchId: string; code: string; name: string; offlineMode?: string }) {
    if (!auth.scopeFor('registers.manage').includes(dto.branchId)) throw outOfScope();
    await this.assertBranch(dto.branchId);
    return this.db.tx(async (q) => {
      const r = await one(q, `insert into org.cash_registers (branch_id, code, name, offline_mode, created_by, updated_by) values ($1, $2, $3, coalesce($4, 'online_only'), $5, $5)
                              returning id, branch_id, code, name, status, offline_mode, version`, [dto.branchId, dto.code, dto.name, dto.offlineMode ?? null, auth.userId]);
      await this.audit.record({ action: 'cash_register.created', entityType: 'cash_register', entityId: r.id, branchId: dto.branchId, newValue: dto }, q);
      return r;
    });
  }

  async updateRegister(auth: AuthContext, id: string, dto: { version: number; name?: string; status?: 'active' | 'inactive'; offlineMode?: string }) {
    const reg = await maybeOne<{ branch_id: string }>(this.db, `select branch_id from org.cash_registers where id = $1`, [id]);
    if (!reg || !auth.scopeFor('registers.manage').includes(reg.branch_id)) throw regNotFound();
    return this.db.tx(async (q) => {
      const r = await updateVersioned(q, 'org.cash_registers', id, dto.version, { name: dto.name, status: dto.status, offline_mode: dto.offlineMode }, auth.userId, regNotFound);
      await this.audit.record({ action: 'cash_register.updated', entityType: 'cash_register', entityId: id, branchId: reg.branch_id, newValue: dto }, q);
      return { id: r.id, branch_id: r.branch_id, code: r.code, name: r.name, status: r.status, offline_mode: r.offline_mode, version: r.version };
    });
  }
}
