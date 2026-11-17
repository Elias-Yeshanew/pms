import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { likePattern, offsetOf, Page } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { CreateBranchDto, CreateDepartmentDto, CreateEmployeeDto, EmployeesQuery, UpdateBranchDto, UpdateEmployeeDto } from './org.dto';
import { PageQuery } from '../../common/pagination';

const branchNotFound = () => AppError.notFound('BRANCH_NOT_FOUND', 'Branch not found.');
const employeeNotFound = () => AppError.notFound('EMPLOYEE_NOT_FOUND', 'Employee not found.');
const outOfScope = () => AppError.forbidden('OUT_OF_SCOPE', 'You do not have access to this branch.');

@Injectable()
export class OrgService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  // ---- branches ----
  async listBranches(auth: AuthContext, q: PageQuery): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('branches.read').sql('b.id', params)];
    if (q.search) { params.push(likePattern(q.search)); where.push(`(b.name ilike $${params.length} or b.code ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from org.branches b where ${w}`, params)).rows[0].count);
    const items = await many(
      this.db,
      `select b.id, b.code, b.name, b.address, b.phone, b.status, b.is_central, b.version from org.branches b
        where ${w} order by b.code limit ${q.pageSize} offset ${offsetOf(q)}`,
      params,
    );
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async getBranch(auth: AuthContext, id: string) {
    const b = await maybeOne(this.db, `select id, code, name, address, phone, status, is_central, version from org.branches where id = $1`, [id]);
    if (!b || !auth.scopeFor('branches.read').includes(id)) throw branchNotFound();
    return b;
  }

  async createBranch(auth: AuthContext, dto: CreateBranchDto) {
    // Creating a branch changes the company structure, so it needs company-wide access
    if (!auth.scopeFor('branches.manage').isUnrestricted) throw outOfScope();
    const row = await this.db.tx(async (q) => {
      const b = await one<{ id: string }>(
        q,
        `insert into org.branches (code, name, address, phone, is_central, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) returning id`,
        [dto.code, dto.name, dto.address ?? null, dto.phone ?? null, dto.isCentral === true, auth.userId],
      );
      await this.audit.record({ action: 'branch.created', entityType: 'branch', entityId: b.id, branchId: b.id, newValue: dto }, q);
      return b;
    });
    return this.getBranch(auth, row.id);
  }

  async updateBranch(auth: AuthContext, id: string, dto: UpdateBranchDto) {
    if (!auth.scopeFor('branches.manage').includes(id)) throw branchNotFound();
    const before = await this.getBranch(auth, id);
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'org.branches', id, dto.version, { name: dto.name, address: dto.address, phone: dto.phone, status: dto.status }, auth.userId, branchNotFound);
      await this.audit.record({ action: 'branch.updated', entityType: 'branch', entityId: id, branchId: id, oldValue: before, newValue: dto }, q);
    });
    return this.getBranch(auth, id);
  }

  // ---- departments ----
  listDepartments() { return many(this.db, `select id, name from org.departments order by name`); }

  async createDepartment(auth: AuthContext, dto: CreateDepartmentDto) {
    if (!auth.scopeFor('employees.manage').isUnrestricted) throw outOfScope();
    return this.db.tx(async (q) => {
      const d = await one(q, `insert into org.departments (name, created_by, updated_by) values ($1, $2, $2) returning id, name`, [dto.name, auth.userId]);
      await this.audit.record({ action: 'department.created', entityType: 'department', entityId: d.id, newValue: dto }, q);
      return d;
    });
  }

  // ---- employees ----
  private readonly EMP = `e.id, e.branch_id, e.department_id, e.full_name, e.job_title, e.hire_date, e.employment_status, e.phone, e.email, e.version,
                          (select u.id from iam.users u where u.employee_id = e.id) as user_id`;

  async listEmployees(auth: AuthContext, q: EmployeesQuery): Promise<Page<unknown>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('employees.read').sql('e.branch_id', params)];
    const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.branchId) add('e.branch_id = ?', q.branchId);
    if (q.departmentId) add('e.department_id = ?', q.departmentId);
    if (q.employmentStatus) add('e.employment_status = ?', q.employmentStatus);
    if (q.search) { params.push(likePattern(q.search)); where.push(`(e.full_name ilike $${params.length} or e.job_title ilike $${params.length})`); }
    const w = where.join(' and ');
    const total = Number((await this.db.query(`select count(*) from org.employees e where ${w}`, params)).rows[0].count);
    const items = await many(this.db, `select ${this.EMP} from org.employees e where ${w} order by e.full_name limit ${q.pageSize} offset ${offsetOf(q)}`, params);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async getEmployee(auth: AuthContext, id: string) {
    const e = await maybeOne<{ branch_id: string }>(this.db, `select ${this.EMP} from org.employees e where e.id = $1`, [id]);
    if (!e || !auth.scopeFor('employees.read').includes(e.branch_id)) throw employeeNotFound();
    return e;
  }

  private async assertBranchExists(branchId: string) {
    if (!(await maybeOne(this.db, `select 1 from org.branches where id = $1`, [branchId]))) throw AppError.badRequest('BRANCH_NOT_FOUND', 'The branch does not exist.');
  }

  async createEmployee(auth: AuthContext, dto: CreateEmployeeDto) {
    if (!auth.scopeFor('employees.manage').includes(dto.branchId)) throw outOfScope();
    await this.assertBranchExists(dto.branchId);
    const row = await this.db.tx(async (q) => {
      const e = await one<{ id: string }>(
        q,
        `insert into org.employees (branch_id, department_id, full_name, job_title, hire_date, phone, email, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
        [dto.branchId, dto.departmentId ?? null, dto.fullName, dto.jobTitle ?? null, dto.hireDate ?? null, dto.phone ?? null, dto.email ?? null, auth.userId],
      );
      await this.audit.record({ action: 'employee.created', entityType: 'employee', entityId: e.id, branchId: dto.branchId, newValue: dto }, q);
      return e;
    });
    return this.getEmployee(auth, row.id);
  }

  async updateEmployee(auth: AuthContext, id: string, dto: UpdateEmployeeDto) {
    const before = await this.getEmployee(auth, id) as { branch_id: string };
    if (!auth.scopeFor('employees.manage').includes(before.branch_id)) throw outOfScope();
    if (dto.branchId) {
      if (!auth.scopeFor('employees.manage').includes(dto.branchId)) throw outOfScope();
      await this.assertBranchExists(dto.branchId);
    }
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'org.employees', id, dto.version, {
        branch_id: dto.branchId, department_id: dto.departmentId, full_name: dto.fullName, job_title: dto.jobTitle,
        hire_date: dto.hireDate, phone: dto.phone, email: dto.email, employment_status: dto.employmentStatus,
      }, auth.userId, employeeNotFound);
      await this.audit.record({ action: 'employee.updated', entityType: 'employee', entityId: id, branchId: dto.branchId ?? before.branch_id, oldValue: before, newValue: dto }, q);
    });
    return this.getEmployee(auth, id);
  }
}
