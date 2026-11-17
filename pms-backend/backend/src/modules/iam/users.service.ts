import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { likePattern, offsetOf, Page } from '../../common/pagination';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { PermissionService } from './permission.service';
import { CreateUserDto, RoleAssignmentDto, UpdateUserDto, UsersQuery } from './users.dto';

const ADMIN_ROLE = 'System Administrator';
const notFound = () => AppError.notFound('USER_NOT_FOUND', 'User not found.');

interface UserView {
  id: string; username: string; email: string | null; status: string; must_change_password: boolean;
  two_factor_enabled: boolean; last_login_at: Date | null; version: number; employee_id: string | null;
  full_name: string | null; branch_id: string | null; created_at: Date;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
  ) {}

  private readonly VIEW = `u.id, u.username, u.email, u.status, u.must_change_password, u.two_factor_enabled, u.last_login_at,
                            u.version, u.employee_id, e.full_name, e.branch_id, u.created_at`;

  async list(auth: AuthContext, q: UsersQuery): Promise<Page<UserView>> {
    const params: unknown[] = [];
    const where = [auth.scopeFor('users.read').sql('e.branch_id', params)];
    const add = (cond: string, v: unknown) => { params.push(v); where.push(cond.replace('?', `$${params.length}`)); };
    if (q.status) add('u.status = ?', q.status);
    if (q.branchId) add('e.branch_id = ?', q.branchId);
    if (q.roleId) add('exists (select 1 from iam.user_roles ur where ur.user_id = u.id and ur.role_id = ?)', q.roleId);
    if (q.search) {
      params.push(likePattern(q.search));
      const n = params.length;
      where.push(`(u.username ilike $${n} or u.email ilike $${n} or e.full_name ilike $${n})`);
    }
    const whereSql = where.join(' and ');
    const from = `from iam.users u left join org.employees e on e.id = u.employee_id where ${whereSql}`;
    const total = Number((await this.db.query(`select count(*) ${from}`, params)).rows[0].count);
    const rows = await many<UserView>(
      this.db,
      `select ${this.VIEW} ${from} order by u.username ${q.order === 'desc' ? 'desc' : 'asc'} limit ${q.pageSize} offset ${offsetOf(q)}`,
      params,
    );
    return { items: rows, total, page: q.page, pageSize: q.pageSize };
  }

  /** Out-of-scope users are reported as "not found" so their existence is not revealed. */
  private async load(auth: AuthContext, id: string, permission: string, q: DatabaseService | PoolClient = this.db): Promise<UserView> {
    const u = await maybeOne<UserView>(q, `select ${this.VIEW} from iam.users u left join org.employees e on e.id = u.employee_id where u.id = $1`, [id]);
    if (!u || !auth.scopeFor(permission).includes(u.branch_id)) throw notFound();
    return u;
  }

  async get(auth: AuthContext, id: string) {
    const user = await this.load(auth, id, 'users.read');
    const roles = await many(
      this.db,
      `select ur.id as assignment_id, r.id as role_id, r.name, ur.branch_id from iam.user_roles ur join iam.roles r on r.id = ur.role_id
        where ur.user_id = $1 order by r.name`,
      [id],
    );
    return { ...user, roles };
  }

  private async employeeBranch(q: DatabaseService | PoolClient, employeeId: string): Promise<string> {
    const e = await maybeOne<{ branch_id: string }>(q, `select branch_id from org.employees where id = $1`, [employeeId]);
    if (!e) throw AppError.badRequest('EMPLOYEE_NOT_FOUND', 'The employee does not exist.');
    return e.branch_id;
  }

  private async assertAssignable(auth: AuthContext, a: RoleAssignmentDto, q: PoolClient) {
    const role = await maybeOne(q, `select 1 from iam.roles where id = $1`, [a.roleId]);
    if (!role) throw AppError.badRequest('ROLE_NOT_FOUND', 'A selected role does not exist.');
    if (a.branchId && !(await maybeOne(q, `select 1 from org.branches where id = $1`, [a.branchId]))) {
      throw AppError.badRequest('BRANCH_NOT_FOUND', 'A selected branch does not exist.');
    }
    await this.perms.assertCanGrantRole(auth, a.roleId, a.branchId ?? null, q);
  }

  /**
   * Prevents taking over a stronger account: you may only change a user (reset password, (de)activate, edit)
   * if every permission they hold - through roles or 'allow' overrides - is within your own access for that branch.
   */
  private async assertCanManage(auth: AuthContext, userId: string, q: DatabaseService | PoolClient = this.db) {
    const grants = await many<{ code: string; branch_id: string | null }>(
      q,
      `select p.code, ur.branch_id from iam.user_roles ur join iam.role_permissions rp on rp.role_id = ur.role_id join iam.permissions p on p.id = rp.permission_id
        where ur.user_id = $1
       union
       select p.code, o.branch_id from iam.user_permission_overrides o join iam.permissions p on p.id = o.permission_id
        where o.user_id = $1 and o.effect = 'allow'`,
      [userId],
    );
    if (grants.some((g) => !auth.scopeFor(g.code).includes(g.branch_id))) {
      throw AppError.forbidden('USER_EXCEEDS_YOUR_ACCESS', 'You cannot change a user who has access you do not have yourself.');
    }
  }

  /** There must always be at least one active company-wide System Administrator. */
  private async assertAdminRemains(q: PoolClient) {
    const r = await one<{ n: string }>(
      q,
      `select count(*) as n from iam.user_roles ur join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
        where r.name = $1 and ur.branch_id is null and u.status = 'active'`,
      [ADMIN_ROLE],
    );
    if (Number(r.n) < 1) throw AppError.conflict('LAST_ADMIN', 'This change would leave the system without an active System Administrator.');
  }

  async create(auth: AuthContext, dto: CreateUserDto) {
    let branchId: string | null = null;
    if (dto.employeeId) branchId = await this.employeeBranch(this.db, dto.employeeId);
    if (!auth.scopeFor('users.create').includes(branchId)) {
      throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot create users for this branch.');
    }
    const temporary = dto.password === undefined;
    const password = dto.password ?? (await this.passwords.generateTemporary());
    await this.passwords.assertPolicy(password, dto.username);
    const hash = await this.passwords.hash(password);

    const created = await this.db.tx(async (q) => {
      const u = await one<{ id: string }>(
        q,
        `insert into iam.users (username, email, employee_id, password_hash, must_change_password, created_by, updated_by, password_changed_at)
         values ($1, $2, $3, $4, $5, $6, $6, now()) returning id`,
        [dto.username, dto.email ?? null, dto.employeeId ?? null, hash, true, auth.userId],
      );
      for (const a of dto.roles ?? []) {
        await this.assertAssignable(auth, a, q);
        await q.query(`insert into iam.user_roles (user_id, role_id, branch_id, created_by) values ($1, $2, $3, $4)`, [u.id, a.roleId, a.branchId ?? null, auth.userId]);
      }
      await this.audit.record({ action: 'user.created', entityType: 'user', entityId: u.id, branchId, newValue: { username: dto.username, email: dto.email, employeeId: dto.employeeId, roles: dto.roles } }, q);
      return u.id;
    });
    const user = await this.get(auth, created);
    return { ...user, ...(temporary ? { temporaryPassword: password } : {}) };
  }

  async update(auth: AuthContext, id: string, dto: UpdateUserDto) {
    const before = await this.load(auth, id, 'users.update');
    await this.assertCanManage(auth, id);
    let newBranch = before.branch_id;
    if (dto.employeeId) {
      newBranch = await this.employeeBranch(this.db, dto.employeeId);
      if (!auth.scopeFor('users.update').includes(newBranch)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot assign a user to this branch.');
    }
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'iam.users', id, dto.version, { email: dto.email, employee_id: dto.employeeId }, auth.userId, notFound);
      await this.audit.record({ action: 'user.updated', entityType: 'user', entityId: id, branchId: newBranch, oldValue: { email: before.email, employeeId: before.employee_id }, newValue: { email: dto.email ?? before.email, employeeId: dto.employeeId ?? before.employee_id } }, q);
    });
    this.perms.invalidate(id);
    return this.get(auth, id);
  }

  async setActive(auth: AuthContext, id: string, active: boolean, version: number) {
    const before = await this.load(auth, id, 'users.deactivate');
    await this.assertCanManage(auth, id);
    if (!active && id === auth.userId) throw AppError.badRequest('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account.');
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'iam.users', id, version, { status: active ? 'active' : 'inactive', deactivated_at: active ? null : new Date() }, auth.userId, notFound);
      if (!active) {
        await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'user_deactivated' where user_id = $1 and revoked_at is null`, [id]);
        await this.assertAdminRemains(q);
      }
      await this.audit.record({ action: active ? 'user.activated' : 'user.deactivated', entityType: 'user', entityId: id, branchId: before.branch_id, oldValue: { status: before.status }, newValue: { status: active ? 'active' : 'inactive' } }, q);
    });
    this.perms.invalidate(id);
    return this.get(auth, id);
  }

  async resetPassword(auth: AuthContext, id: string) {
    const before = await this.load(auth, id, 'users.reset_password');
    if (id === auth.userId) throw AppError.badRequest('USE_CHANGE_PASSWORD', 'Use the change-password option for your own account.');
    await this.assertCanManage(auth, id);
    const temporaryPassword = await this.passwords.generateTemporary();
    const hash = await this.passwords.hash(temporaryPassword);
    await this.db.tx(async (q) => {
      await q.query(
        `update iam.users set password_hash = $2, must_change_password = true, password_changed_at = now(),
                failed_login_count = 0, locked_until = null, version = version + 1, updated_by = $3 where id = $1`,
        [id, hash, auth.userId],
      );
      await q.query(`update iam.sessions set revoked_at = now(), revoked_reason = 'admin_password_reset' where user_id = $1 and revoked_at is null`, [id]);
      await this.audit.record({ action: 'user.password_reset_by_admin', entityType: 'user', entityId: id, branchId: before.branch_id }, q);
    });
    return { temporaryPassword };
  }

  async setRoles(auth: AuthContext, id: string, assignments: RoleAssignmentDto[]) {
    const user = await this.load(auth, id, 'users.assign_roles');
    const key = (a: { roleId?: string; role_id?: string; branchId?: string | null; branch_id?: string | null }) => `${a.roleId ?? a.role_id}|${(a.branchId ?? a.branch_id) ?? ''}`;
    const wanted = new Map(assignments.map((a) => [key(a), a]));
    if (wanted.size !== assignments.length) throw AppError.badRequest('DUPLICATE_ASSIGNMENT', 'The same role and branch appears more than once.');

    await this.db.tx(async (q) => {
      const current = await many<{ id: string; role_id: string; branch_id: string | null }>(q, `select id, role_id, branch_id from iam.user_roles where user_id = $1 for update`, [id]);
      const currentKeys = new Map(current.map((c) => [key(c), c]));
      const toAdd = [...wanted.entries()].filter(([k]) => !currentKeys.has(k)).map(([, a]) => a);
      const toRemove = current.filter((c) => !wanted.has(key(c)));
      // Granting or taking away a role both need the same level of access as the role itself
      for (const a of toAdd) await this.assertAssignable(auth, a, q);
      for (const r of toRemove) await this.perms.assertCanGrantRole(auth, r.role_id, r.branch_id, q);
      for (const r of toRemove) await q.query(`delete from iam.user_roles where id = $1`, [r.id]);
      for (const a of toAdd) await q.query(`insert into iam.user_roles (user_id, role_id, branch_id, created_by) values ($1, $2, $3, $4)`, [id, a.roleId, a.branchId ?? null, auth.userId]);
      await this.assertAdminRemains(q);
      await this.audit.record({ action: 'user.roles_changed', entityType: 'user', entityId: id, branchId: user.branch_id, oldValue: current.map((c) => ({ roleId: c.role_id, branchId: c.branch_id })), newValue: assignments }, q);
    });
    this.perms.invalidate(id);
    return this.get(auth, id);
  }

  async loginHistory(auth: AuthContext, id: string, page: number, pageSize: number) {
    await this.load(auth, id, 'login_history.read');
    const total = Number((await this.db.query(`select count(*) from iam.login_history where user_id = $1`, [id])).rows[0].count);
    const items = await many(
      this.db,
      `select id, attempted_at, ip_address, user_agent, success, failure_reason from iam.login_history
        where user_id = $1 order by attempted_at desc limit $2 offset $3`,
      [id, pageSize, (page - 1) * pageSize],
    );
    return { items, total, page, pageSize };
  }
}
