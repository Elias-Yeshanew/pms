import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { updateVersioned } from '../../common/db-util';
import { DatabaseService, many, maybeOne, one, Queryable } from '../../database/database.service';
import { computeTax } from '../../domain/pricing';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../platform/settings.service';

const catNotFound = () => AppError.notFound('TAX_CATEGORY_NOT_FOUND', 'Tax category not found.');
const ruleNotFound = () => AppError.notFound('TAX_RULE_NOT_FOUND', 'Tax rule not found.');

export interface RuleInput {
  taxCategoryId: string; taxCode: string; name: string; rate: string; isInclusive?: boolean;
  roundingRule?: 'half_up' | 'half_even' | 'down' | 'up'; effectiveFrom: string; effectiveTo?: string; countryPack?: string;
}

const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class TaxService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  listCategories() { return many(this.db, `select id, name, description, is_active, version from finance.tax_categories order by name`); }

  async createCategory(auth: AuthContext, dto: { name: string; description?: string }) {
    return this.db.tx(async (q) => {
      const c = await one(q, `insert into finance.tax_categories (name, description, created_by, updated_by) values ($1, $2, $3, $3) returning id, name, description, is_active, version`, [dto.name, dto.description ?? null, auth.userId]);
      await this.audit.record({ action: 'tax_category.created', entityType: 'tax_category', entityId: c.id, newValue: dto }, q);
      return c;
    });
  }

  async updateCategory(auth: AuthContext, id: string, dto: { version: number; name?: string; description?: string; isActive?: boolean }) {
    return this.db.tx(async (q) => {
      const row = await updateVersioned(q, 'finance.tax_categories', id, dto.version, { name: dto.name, description: dto.description, is_active: dto.isActive }, auth.userId, catNotFound);
      await this.audit.record({ action: 'tax_category.updated', entityType: 'tax_category', entityId: id, newValue: dto }, q);
      return { id: row.id, name: row.name, description: row.description, is_active: row.is_active, version: row.version };
    });
  }

  listRules(taxCategoryId?: string) {
    return many(this.db, `select id, tax_category_id, tax_code, name, rate, is_inclusive, rounding_rule, effective_from, effective_to, country_pack, version
                            from finance.tax_rules where ($1::uuid is null or tax_category_id = $1) order by tax_category_id, effective_from desc`, [taxCategoryId ?? null]);
  }

  private assertRate(rate: string) {
    if (Number(rate) > 100) throw AppError.badRequest('INVALID_RATE', 'The rate cannot exceed 100 percent.');
  }

  async createRule(auth: AuthContext, dto: RuleInput) {
    this.assertRate(dto.rate);
    if (dto.effectiveTo && dto.effectiveTo < dto.effectiveFrom) throw AppError.badRequest('INVALID_PERIOD', 'The end date cannot be before the start date.');
    const inclusive = dto.isInclusive ?? (await this.settings.get('tax.prices_include_tax'));
    return this.db.tx(async (q) => {
      if (!(await maybeOne(q, `select 1 from finance.tax_categories where id = $1`, [dto.taxCategoryId]))) throw catNotFound();
      const r = await one(q,
        `insert into finance.tax_rules (tax_category_id, tax_code, name, rate, is_inclusive, rounding_rule, effective_from, effective_to, country_pack, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'ET'), $10, $10) returning *`,
        [dto.taxCategoryId, dto.taxCode, dto.name, dto.rate, inclusive, dto.roundingRule ?? 'half_up', dto.effectiveFrom, dto.effectiveTo ?? null, dto.countryPack ?? null, auth.userId]);
      await this.audit.record({ action: 'tax_rule.created', entityType: 'tax_rule', entityId: r.id, newValue: dto }, q);
      return r;
    });
  }

  /** A rule's rate is never edited: the past stays reproducible. Only its name and end date can change. */
  async endRule(auth: AuthContext, id: string, dto: { version: number; name?: string; effectiveTo?: string }) {
    return this.db.tx(async (q) => {
      const before = await maybeOne<{ effective_from: string }>(q, `select to_char(effective_from, 'YYYY-MM-DD') as effective_from from finance.tax_rules where id = $1`, [id]);
      if (!before) throw ruleNotFound();
      if (dto.effectiveTo && dto.effectiveTo < before.effective_from) throw AppError.badRequest('INVALID_PERIOD', 'The end date cannot be before the start date.');
      const row = await updateVersioned(q, 'finance.tax_rules', id, dto.version, { name: dto.name, effective_to: dto.effectiveTo }, auth.userId, ruleNotFound);
      await this.audit.record({ action: 'tax_rule.updated', entityType: 'tax_rule', entityId: id, newValue: dto }, q);
      return row;
    });
  }

  /** Replaces a rule from a given date: ends the old one the day before and starts the new one, atomically. */
  async supersede(auth: AuthContext, id: string, dto: { rate: string; effectiveFrom: string; name?: string; taxCode?: string; isInclusive?: boolean; roundingRule?: RuleInput['roundingRule'] }) {
    this.assertRate(dto.rate);
    return this.db.tx(async (q) => {
      const old = await maybeOne<any>(q, `select *, to_char(effective_from, 'YYYY-MM-DD') as from_s, to_char(effective_to, 'YYYY-MM-DD') as to_s from finance.tax_rules where id = $1 for update`, [id]);
      if (!old) throw ruleNotFound();
      if (dto.effectiveFrom <= old.from_s) throw AppError.badRequest('SUPERSEDE_DATE_TOO_EARLY', 'The new rule must start after the rule it replaces.');
      if (old.to_s && old.to_s < dto.effectiveFrom) throw AppError.badRequest('RULE_ALREADY_ENDED', 'The rule has already ended before that date.');
      await q.query(`update finance.tax_rules set effective_to = $2, version = version + 1, updated_by = $3 where id = $1`, [id, addDays(dto.effectiveFrom, -1), auth.userId]);
      const created = await one(q,
        `insert into finance.tax_rules (tax_category_id, tax_code, name, rate, is_inclusive, rounding_rule, effective_from, effective_to, country_pack, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning *`,
        [old.tax_category_id, dto.taxCode ?? old.tax_code, dto.name ?? old.name, dto.rate, dto.isInclusive ?? old.is_inclusive, dto.roundingRule ?? old.rounding_rule, dto.effectiveFrom, old.to_s, old.country_pack, auth.userId]);
      await this.audit.record({ action: 'tax_rule.superseded', entityType: 'tax_rule', entityId: created.id, oldValue: { id, rate: old.rate }, newValue: dto }, q);
      return created;
    });
  }

  async resolve(taxCategoryId: string, date?: string, q: Queryable = this.db) {
    const on = date ?? (await this.settings.businessDate(new Date(), q));
    const rule = await maybeOne(q,
      `select id, tax_category_id, tax_code, name, rate, is_inclusive, rounding_rule, effective_from, effective_to from finance.tax_rules
        where tax_category_id = $1 and effective_from <= $2 and (effective_to is null or effective_to >= $2)`, [taxCategoryId, on]);
    if (!rule) {
      if (!(await maybeOne(q, `select 1 from finance.tax_categories where id = $1`, [taxCategoryId]))) throw catNotFound();
      throw AppError.conflict('NO_TAX_RULE', `No tax rule is in force for this category on ${on}.`);
    }
    return rule;
  }

  /** Tax for one amount. A missing rule is an error, never a silent zero. */
  async calculate(dto: { taxCategoryId: string; amount: string; date?: string }, q: Queryable = this.db) {
    const rule = await this.resolve(dto.taxCategoryId, dto.date, q);
    const decimals = await this.settings.get('business.currency_decimals', null, q);
    const result = computeTax({ amount: dto.amount, ratePercent: rule.rate, inclusive: rule.is_inclusive, rounding: rule.rounding_rule, currencyDecimals: decimals });
    return { ...result, rule: { id: rule.id, taxCode: rule.tax_code, ratePercent: rule.rate, inclusive: rule.is_inclusive, rounding: rule.rounding_rule } };
  }
}
