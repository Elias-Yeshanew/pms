import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { ENV, Env } from '../../config/env';
import { DatabaseService, many, maybeOne, Queryable } from '../../database/database.service';
import { AuditService } from '../audit/audit.service';
import { isSettingKey, SETTINGS, SettingKey, SettingValue } from './settings.registry';

interface Row { key: string; branch_id: string | null; value: unknown; version: number }

@Injectable()
export class SettingsService {
  private cache = new Map<string, { expires: number; value: unknown }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Effective value: branch override (if allowed), else company value, else the built-in default. */
  async get<K extends SettingKey>(key: K, branchId?: string | null, q: Queryable = this.db): Promise<SettingValue<K>> {
    const def = SETTINGS[key];
    const cacheKey = `${key}|${def.branchOverridable ? branchId ?? '' : ''}`;
    const ttl = this.env.SETTINGS_CACHE_TTL_MS;
    const hit = this.cache.get(cacheKey);
    if (ttl > 0 && hit && hit.expires > Date.now()) return hit.value as SettingValue<K>;

    const rows = await many<Row>(
      q,
      `select key, branch_id, value, version from platform.settings
        where key = $1 and (branch_id is null or branch_id = $2) order by branch_id nulls last limit 1`,
      [key, def.branchOverridable ? branchId ?? null : null],
    );
    const value = (rows[0] ? rows[0].value : def.default(this.env)) as SettingValue<K>;
    if (ttl > 0) this.cache.set(cacheKey, { expires: Date.now() + ttl, value });
    return value;
  }

  /** All settings with their effective values, optionally as seen from one branch. */
  async list(auth: AuthContext, branchId?: string) {
    if (branchId && !auth.scopeFor('settings.read').includes(branchId)) throw AppError.notFound('BRANCH_NOT_FOUND', 'Branch not found.');
    const rows = await many<Row>(this.db, `select key, branch_id, value, version from platform.settings where branch_id is null or branch_id = $1`, [branchId ?? null]);
    return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
      const def = SETTINGS[key];
      const branchRow = def.branchOverridable ? rows.find((r) => r.key === key && r.branch_id) : undefined;
      const companyRow = rows.find((r) => r.key === key && !r.branch_id);
      const row = branchRow ?? companyRow;
      return {
        key, group: def.group, description: def.description, branchOverridable: def.branchOverridable,
        value: row ? row.value : def.default(this.env),
        source: branchRow ? 'branch' : companyRow ? 'company' : 'default',
        version: row?.version ?? null,
      };
    });
  }

  private assertKey(key: string): SettingKey {
    if (!isSettingKey(key)) throw AppError.notFound('SETTING_NOT_FOUND', 'Unknown setting.');
    return key;
  }

  private assertCanWrite(auth: AuthContext, key: SettingKey, branchId: string | null) {
    const scope = auth.scopeFor('settings.manage');
    if (branchId) {
      if (!SETTINGS[key].branchOverridable) throw AppError.badRequest('NOT_BRANCH_OVERRIDABLE', 'This setting applies to the whole company and cannot be set per branch.');
      if (!scope.includes(branchId)) throw AppError.forbidden('OUT_OF_SCOPE', 'You cannot change settings for this branch.');
    } else if (!scope.isUnrestricted) {
      throw AppError.forbidden('OUT_OF_SCOPE', 'Company-wide settings need company-wide access.');
    }
  }

  async set(auth: AuthContext, rawKey: string, rawValue: unknown, branchId: string | null, version: number | undefined, reason?: string) {
    const key = this.assertKey(rawKey);
    this.assertCanWrite(auth, key, branchId);
    const parsed = SETTINGS[key].schema.safeParse(rawValue);
    if (!parsed.success) throw AppError.badRequest('INVALID_SETTING_VALUE', 'The value is not valid for this setting.', parsed.error.issues.map((i) => i.message));
    if (branchId && !(await maybeOne(this.db, `select 1 from org.branches where id = $1`, [branchId]))) throw AppError.badRequest('BRANCH_NOT_FOUND', 'The branch does not exist.');

    await this.db.tx(async (q) => {
      const locked = await SETTINGS[key].lockedReason?.(q);
      if (locked) throw AppError.conflict('SETTING_LOCKED', locked);
      const current = await maybeOne<Row>(q, `select key, branch_id, value, version from platform.settings where key = $1 and branch_id is not distinct from $2 for update`, [key, branchId]);
      if (current && version !== undefined && current.version !== version) throw AppError.conflict('VERSION_CONFLICT', 'The setting was changed by someone else. Reload it and try again.');
      if (!current && version !== undefined) throw AppError.conflict('VERSION_CONFLICT', 'The setting does not have an explicit value yet; omit the version.');
      const json = JSON.stringify(parsed.data);
      if (current) {
        await q.query(`update platform.settings set value = $3, version = version + 1, updated_by = $4 where key = $1 and branch_id is not distinct from $2`, [key, branchId, json, auth.userId]);
      } else {
        await q.query(`insert into platform.settings (key, branch_id, value, updated_by) values ($1, $2, $3, $4)`, [key, branchId, json, auth.userId]);
      }
      await q.query(`insert into platform.settings_history (key, branch_id, old_value, new_value, reason, changed_by) values ($1, $2, $3, $4, $5, $6)`,
        [key, branchId, current ? JSON.stringify(current.value) : null, json, reason ?? null, auth.userId]);
      await this.audit.record({ action: 'setting.changed', entityType: 'setting', entityId: key, branchId, oldValue: current?.value ?? SETTINGS[key].default(this.env), newValue: parsed.data }, q);
    });
    this.cache.clear();
    return (await this.list(auth, branchId ?? undefined)).find((s) => s.key === key);
  }

  /** Removes an explicit value so the setting falls back to the company value or the default. */
  async reset(auth: AuthContext, rawKey: string, branchId: string | null, reason?: string) {
    const key = this.assertKey(rawKey);
    this.assertCanWrite(auth, key, branchId);
    await this.db.tx(async (q) => {
      const locked = await SETTINGS[key].lockedReason?.(q);
      if (locked) throw AppError.conflict('SETTING_LOCKED', locked);
      const current = await maybeOne<Row>(q, `delete from platform.settings where key = $1 and branch_id is not distinct from $2 returning key, branch_id, value, version`, [key, branchId]);
      if (!current) return;
      const fallback = branchId ? await this.get(key) : SETTINGS[key].default(this.env);
      await q.query(`insert into platform.settings_history (key, branch_id, old_value, new_value, reason, changed_by) values ($1, $2, $3, $4, $5, $6)`,
        [key, branchId, JSON.stringify(current.value), JSON.stringify(fallback), reason ?? 'reset to default', auth.userId]);
      await this.audit.record({ action: 'setting.reset', entityType: 'setting', entityId: key, branchId, oldValue: current.value, newValue: fallback }, q);
    });
    this.cache.clear();
    return (await this.list(auth, branchId ?? undefined)).find((s) => s.key === key);
  }

  /** Today's date (YYYY-MM-DD) in the business time zone. Expiry and effective dates are always judged by this. */
  async businessDate(now: Date = new Date(), q: Queryable = this.db): Promise<string> {
    const tz = await this.get('business.timezone', null, q);
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  history(key: string, q: Queryable = this.db) {
    this.assertKey(key);
    return many(q, `select h.key, h.branch_id, h.old_value, h.new_value, h.reason, h.changed_at, u.username as changed_by
                      from platform.settings_history h left join iam.users u on u.id = h.changed_by
                     where h.key = $1 order by h.changed_at desc limit 200`, [key]);
  }
}
