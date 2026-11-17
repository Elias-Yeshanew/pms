import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { Scope } from '../../common/scope';
import { DatabaseService, many, Queryable } from '../../database/database.service';
import { ENV, Env } from '../../config/env';

interface Grant { code: string; branch_id: string | null; effect: 'allow' | 'deny' }

export class PermissionSet {
  constructor(private readonly scopes: ReadonlyMap<string, Scope>) {}
  scopeFor(code: string): Scope { return this.scopes.get(code) ?? Scope.none(); }
  can(code: string, branchId?: string | null): boolean {
    const s = this.scopeFor(code);
    if (s.isEmpty) return false;
    return branchId === undefined ? true : s.includes(branchId);
  }
  codes(): string[] { return [...this.scopes.entries()].filter(([, s]) => !s.isEmpty).map(([c]) => c).sort(); }
}

/** Turns raw role grants and per-user overrides into one scope per permission. Deny always wins. */
export function computeScopes(grants: Grant[]): Map<string, Scope> {
  const byCode = new Map<string, Grant[]>();
  for (const g of grants) byCode.set(g.code, [...(byCode.get(g.code) ?? []), g]);
  const out = new Map<string, Scope>();
  for (const [code, list] of byCode) {
    const allowAll = list.some((g) => g.effect === 'allow' && g.branch_id === null);
    const allowIds = new Set(list.filter((g) => g.effect === 'allow' && g.branch_id !== null).map((g) => g.branch_id!));
    const denyAll = list.some((g) => g.effect === 'deny' && g.branch_id === null);
    const denyIds = new Set(list.filter((g) => g.effect === 'deny' && g.branch_id !== null).map((g) => g.branch_id!));
    if (denyAll) continue;
    if (allowAll) out.set(code, new Scope(true, new Set(), denyIds));
    else {
      for (const d of denyIds) allowIds.delete(d);
      if (allowIds.size) out.set(code, new Scope(false, allowIds));
    }
  }
  return out;
}

@Injectable()
export class PermissionService {
  private readonly cache = new Map<string, { expires: number; set: PermissionSet }>();

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async forUser(userId: string): Promise<PermissionSet> {
    const ttl = this.env.PERMISSION_CACHE_TTL_MS;
    const hit = this.cache.get(userId);
    if (ttl > 0 && hit && hit.expires > Date.now()) return hit.set;
    const rows = await many<Grant>(
      this.db,
      `select p.code, ur.branch_id, 'allow'::text as effect
         from iam.user_roles ur
         join iam.role_permissions rp on rp.role_id = ur.role_id
         join iam.permissions p on p.id = rp.permission_id
        where ur.user_id = $1
       union all
       select p.code, o.branch_id, o.effect
         from iam.user_permission_overrides o
         join iam.permissions p on p.id = o.permission_id
        where o.user_id = $1`,
      [userId],
    );
    const set = new PermissionSet(computeScopes(rows));
    if (ttl > 0) this.cache.set(userId, { expires: Date.now() + ttl, set });
    return set;
  }

  /** Call after any change to a user's roles/overrides or to a role's permissions. */
  invalidate(userId?: string) {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  toAuthContext(base: { userId: string; sessionId: string; username: string; mustChangePassword: boolean }, set: PermissionSet): AuthContext {
    return {
      ...base,
      scopeFor: (c) => set.scopeFor(c),
      can: (c, b) => set.can(c, b),
      permissionCodes: () => set.codes(),
    };
  }

  /**
   * Prevents privilege escalation: someone may only hand out a role if they themselves hold every
   * permission in it, for at least the branch scope they are granting.
   */
  async assertCanGrantRole(auth: AuthContext, roleId: string, branchId: string | null, q: Queryable = this.db): Promise<void> {
    const codes = await many<{ code: string }>(
      q,
      `select p.code from iam.role_permissions rp join iam.permissions p on p.id = rp.permission_id where rp.role_id = $1`,
      [roleId],
    );
    const missing = codes.map((c) => c.code).filter((code) => !auth.scopeFor(code).includes(branchId));
    if (missing.length) {
      throw AppError.forbidden('ROLE_EXCEEDS_YOUR_ACCESS', 'You cannot grant a role that contains permissions you do not hold for this scope.');
    }
  }

  async assertCanGrantPermissions(auth: AuthContext, codes: string[]): Promise<void> {
    const missing = codes.filter((c) => !auth.scopeFor(c).isUnrestricted);
    if (missing.length) {
      throw AppError.forbidden('PERMISSION_EXCEEDS_YOUR_ACCESS', 'You cannot grant permissions you do not hold company-wide.');
    }
  }
}
