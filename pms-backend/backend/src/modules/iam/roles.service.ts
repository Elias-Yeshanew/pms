import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { PermissionService } from './permission.service';
import { CreateRoleDto, SetRolePermissionsDto, UpdateRoleDto } from './roles.dto';

interface RoleView { id: string; name: string; description: string | null; is_system: boolean; version: number; permissions: string[] }
const notFound = () => AppError.notFound('ROLE_NOT_FOUND', 'Role not found.');

@Injectable()
export class RolesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return many(
      this.db,
      `select r.id, r.name, r.description, r.is_system, r.version,
              (select count(*) from iam.role_permissions rp where rp.role_id = r.id)::int as permission_count,
              (select count(*) from iam.user_roles ur where ur.role_id = r.id)::int as user_count
         from iam.roles r order by r.name`,
    );
  }

  async get(id: string): Promise<RoleView> {
    const role = await maybeOne<Omit<RoleView, 'permissions'>>(this.db, `select id, name, description, is_system, version from iam.roles where id = $1`, [id]);
    if (!role) throw notFound();
    const permissions = await many<{ code: string }>(
      this.db,
      `select p.code from iam.role_permissions rp join iam.permissions p on p.id = rp.permission_id where rp.role_id = $1 order by p.code`,
      [id],
    );
    return { ...role, permissions: permissions.map((p) => p.code) };
  }

  listPermissions() {
    return many(this.db, `select code, module, action, description from iam.permissions order by module, action`);
  }

  /** Reports unknown codes before any access check so the caller gets the most useful error. */
  private async assertKnown(codes: string[]) {
    const unique = [...new Set(codes)];
    const found = await many<{ code: string }>(this.db, `select code from iam.permissions where code = any($1::text[])`, [unique]);
    if (found.length !== unique.length) {
      const known = new Set(found.map((f) => f.code));
      throw AppError.badRequest('UNKNOWN_PERMISSION', 'One or more permission codes do not exist.', unique.filter((c) => !known.has(c)));
    }
  }

  private async replacePermissions(q: PoolClient, roleId: string, codes: string[]) {
    const unique = [...new Set(codes)];
    const found = await many<{ id: string; code: string }>(q, `select id, code from iam.permissions where code = any($1::text[])`, [unique]);
    if (found.length !== unique.length) {
      const known = new Set(found.map((f) => f.code));
      throw AppError.badRequest('UNKNOWN_PERMISSION', 'One or more permission codes do not exist.', unique.filter((c) => !known.has(c)));
    }
    await q.query(`delete from iam.role_permissions where role_id = $1`, [roleId]);
    for (const f of found) await q.query(`insert into iam.role_permissions (role_id, permission_id) values ($1, $2)`, [roleId, f.id]);
  }

  async create(auth: AuthContext, dto: CreateRoleDto) {
    await this.assertKnown(dto.permissions ?? []);
    await this.perms.assertCanGrantPermissions(auth, dto.permissions ?? []);
    const id = await this.db.tx(async (q) => {
      const r = await one<{ id: string }>(q, `insert into iam.roles (name, description, created_by, updated_by) values ($1, $2, $3, $3) returning id`, [dto.name, dto.description ?? null, auth.userId]);
      await this.replacePermissions(q, r.id, dto.permissions ?? []);
      await this.audit.record({ action: 'role.created', entityType: 'role', entityId: r.id, newValue: dto }, q);
      return r.id;
    });
    return this.get(id);
  }

  async update(auth: AuthContext, id: string, dto: UpdateRoleDto) {
    const before = await this.get(id);
    if (before.is_system && dto.name !== undefined && dto.name !== before.name) {
      throw AppError.badRequest('SYSTEM_ROLE_NAME_LOCKED', 'Built-in roles cannot be renamed.');
    }
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'iam.roles', id, dto.version, { name: dto.name, description: dto.description }, auth.userId, notFound);
      await this.audit.record({ action: 'role.updated', entityType: 'role', entityId: id, oldValue: { name: before.name, description: before.description }, newValue: { name: dto.name ?? before.name, description: dto.description ?? before.description } }, q);
    });
    return this.get(id);
  }

  async setPermissions(auth: AuthContext, id: string, dto: SetRolePermissionsDto) {
    await this.assertKnown(dto.permissions);
    const before = await this.get(id);
    // Changing a role is as powerful as granting its permissions, both for added and removed ones
    const changed = [...new Set([...before.permissions.filter((c) => !dto.permissions.includes(c)), ...dto.permissions.filter((c) => !before.permissions.includes(c))])];
    await this.perms.assertCanGrantPermissions(auth, changed);
    await this.db.tx(async (q) => {
      await updateVersioned(q, 'iam.roles', id, dto.version, {}, auth.userId, notFound);
      await this.replacePermissions(q, id, dto.permissions);
      await this.audit.record({ action: 'role.permissions_changed', entityType: 'role', entityId: id, oldValue: before.permissions, newValue: [...new Set(dto.permissions)].sort() }, q);
    });
    this.perms.invalidate();
    return this.get(id);
  }
}
