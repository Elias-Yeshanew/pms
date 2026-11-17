import { z } from 'zod';
import { Env } from '../../config/env';
import { Queryable } from '../../database/database.service';

interface SettingDefinition<T extends z.ZodTypeAny> {
  group: 'security' | 'business' | 'inventory' | 'sales' | 'tax' | 'finance' | 'notifications' | 'offline';
  description: string;
  schema: T;
  /** Value used until an administrator sets one. */
  default: (env: Env) => z.infer<T>;
  /** Can a single branch override the company value? */
  branchOverridable: boolean;
  /** Returns a reason when the setting may no longer be changed (for example, once stock transactions exist). */
  lockedReason?: (q: Queryable) => Promise<string | null>;
}

const define = <T extends z.ZodTypeAny>(d: SettingDefinition<T>) => d;
const decimalString = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);

/** True when a table exists and already holds rows. Safe before the module that owns the table is installed. */
async function hasRows(q: Queryable, table: string): Promise<boolean> {
  const exists = await q.query(`select to_regclass($1) as t`, [table]);
  if (!exists.rows[0].t) return false;
  const rows = await q.query(`select 1 from ${table} limit 1`); // table name is a constant from this file
  return rows.rowCount === 1;
}

/**
 * Everything an administrator can configure without a code change. Each entry declares its type, default,
 * and whether a branch may override it. Unknown keys are rejected, so settings cannot silently drift.
 */
export const SETTINGS = {
  'security.password_min_length': define({ group: 'security', description: 'Minimum password length', schema: z.number().int().min(8).max(64), default: (e) => e.PASSWORD_MIN_LENGTH, branchOverridable: false }),
  'security.max_failed_logins': define({ group: 'security', description: 'Failed sign-ins before the account is locked', schema: z.number().int().min(1).max(20), default: (e) => e.MAX_FAILED_LOGINS, branchOverridable: false }),
  'security.lockout_minutes': define({ group: 'security', description: 'How long a locked account stays locked (minutes)', schema: z.number().int().min(1).max(1440), default: (e) => e.LOCKOUT_MINUTES, branchOverridable: false }),
  'security.password_reset_ttl_minutes': define({ group: 'security', description: 'How long a password reset link works (minutes)', schema: z.number().int().min(5).max(1440), default: (e) => e.PASSWORD_RESET_TTL_MINUTES, branchOverridable: false }),

  'business.name': define({ group: 'business', description: 'Business name shown on receipts and reports', schema: z.string().max(150), default: () => '', branchOverridable: false }),
  'business.currency': define({ group: 'business', description: 'Currency code (ISO 4217)', schema: z.string().regex(/^[A-Z]{3}$/), default: () => 'ETB', branchOverridable: false }),
  'business.currency_decimals': define({ group: 'business', description: 'Decimal places used for money amounts', schema: z.number().int().min(0).max(4), default: () => 2, branchOverridable: false }),
  'business.timezone': define({
    group: 'business', description: 'Time zone for business dates (IANA name)',
    schema: z.string().max(60).refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'unknown time zone'),
    default: () => 'Africa/Addis_Ababa', branchOverridable: false,
  }),

  'inventory.expiry_warning_days': define({
    group: 'inventory', description: 'Days before expiry at which warnings are raised',
    schema: z.array(z.number().int().min(1).max(3650)).min(1).max(8).refine((a) => new Set(a).size === a.length, 'values must be unique'),
    default: () => [180, 90, 30, 7], branchOverridable: true,
  }),
  'inventory.allow_negative_stock': define({ group: 'inventory', description: 'Allow stock to go below zero (normally off)', schema: z.boolean(), default: () => false, branchOverridable: false }),
  'inventory.costing_method': define({
    group: 'inventory', description: 'How the cost of goods sold is calculated', schema: z.enum(['batch', 'weighted_average', 'fifo']), default: () => 'batch' as const, branchOverridable: false,
    lockedReason: async (q) => (await hasRows(q, 'inventory.stock_movements')) ? 'The costing method cannot change once stock transactions exist.' : null,
  }),

  'inventory.adjustment_approval_required': define({ group: 'inventory', description: 'Stock adjustments must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'inventory.disposal_approval_required': define({ group: 'inventory', description: 'Disposals of expired or damaged stock must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'inventory.transfer_approval_required': define({ group: 'inventory', description: 'Stock transfers must be approved by a second person before dispatch', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'inventory.count_approval_required': define({ group: 'inventory', description: 'Physical count results must be approved by a second person before stock is corrected', schema: z.boolean(), default: () => true, branchOverridable: false }),

  'catalog.bulk_price_approval_required': define({ group: 'inventory', description: 'Bulk price updates must be approved by a second person before they take effect', schema: z.boolean(), default: () => true, branchOverridable: false }),

  'procurement.pr_approval_required': define({ group: 'inventory', description: 'Purchase requests must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'procurement.po_approval_required': define({ group: 'inventory', description: 'Purchase orders must be approved by a second person before they are sent', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'procurement.return_approval_required': define({ group: 'inventory', description: 'Returns to suppliers must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'procurement.separate_inspector': define({ group: 'inventory', description: 'Goods must be inspected by someone other than the person who received them', schema: z.boolean(), default: () => false, branchOverridable: false }),
  'procurement.enforce_credit_limit': define({ group: 'inventory', description: 'Block purchase orders that would take a supplier past its credit limit', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'procurement.over_receipt_tolerance_percent': define({ group: 'inventory', description: 'How far (%) above the ordered quantity a delivery may go', schema: decimalString, default: () => '0', branchOverridable: false }),
  'procurement.invoice_tolerance_percent': define({ group: 'inventory', description: 'How far (%) a supplier invoice may exceed the value of accepted goods before it needs approval', schema: decimalString, default: () => '2', branchOverridable: false }),

  'sales.max_discount_percent': define({ group: 'sales', description: 'Highest discount (%) a cashier may give without approval', schema: decimalString, default: () => '10', branchOverridable: true }),
  'sales.return_approval_required': define({ group: 'sales', description: 'Customer returns must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'sales.cancel_approval_required': define({ group: 'sales', description: 'Cancelling a completed sale must be approved by a second person', schema: z.boolean(), default: () => true, branchOverridable: false }),
  'sales.return_window_days': define({ group: 'sales', description: 'Days after a sale during which items can be returned (0 = no limit)', schema: z.number().int().min(0).max(3650), default: () => 30, branchOverridable: true }),
  'sales.cancel_window_hours': define({ group: 'sales', description: 'Hours after a sale during which it can be cancelled (0 = no limit)', schema: z.number().int().min(0).max(8760), default: () => 24, branchOverridable: true }),
  'sales.discount_approval_minutes': define({ group: 'sales', description: 'How long an approved discount can be used', schema: z.number().int().min(1).max(1440), default: () => 30, branchOverridable: false }),
  'finance.expense_approval_threshold': define({ group: 'finance', description: 'Expenses at or above this amount need a second person to approve (0 = never)', schema: decimalString, default: () => '5000', branchOverridable: true }),
  'finance.cash_variance_tolerance': define({ group: 'finance', description: 'A register may close with a difference up to this amount without a manager reviewing it', schema: decimalString, default: () => '0', branchOverridable: true }),
  'finance.require_open_register_session': define({ group: 'finance', description: 'Cashiers must open a register session before selling on that register', schema: z.boolean(), default: () => false, branchOverridable: true }),
  'notifications.email_enabled': define({ group: 'notifications', description: 'Also send notifications by email (people can opt out of each type)', schema: z.boolean(), default: () => false, branchOverridable: false }),
  'notifications.approval_reminder_hours': define({ group: 'notifications', description: 'Remind approvers about requests waiting longer than this many hours', schema: z.number().int().min(1).max(720), default: () => 24, branchOverridable: false }),
  'notifications.supplier_due_warning_days': define({ group: 'notifications', description: 'Warn this many days before a supplier invoice is due', schema: z.number().int().min(0).max(90), default: () => 7, branchOverridable: false }),
  'notifications.customer_overdue_days': define({ group: 'notifications', description: 'Warn when a customer has owed money for more than this many days', schema: z.number().int().min(1).max(3650), default: () => 30, branchOverridable: false }),
  'notifications.unusual_adjustment_value': define({ group: 'notifications', description: 'A stock adjustment worth at least this much (at cost) raises an alert (0 = never)', schema: decimalString, default: () => '5000', branchOverridable: true }),
  'prescriptions.validity_days': define({ group: 'sales', description: 'Days a prescription stays valid after it was written (0 = no limit). Confirm the legal rule with EFDA.', schema: z.number().int().min(0).max(3650), default: () => 0, branchOverridable: false }),
  'prescriptions.required_fields': define({ group: 'sales', description: 'Details that must be filled in when registering a prescription', schema: z.array(z.enum(['patientName', 'patientBirthDate', 'patientPhone', 'prescriberName', 'prescriberLicenseNo', 'facility', 'prescribedDate'])), default: () => ['patientName', 'prescriberName', 'prescribedDate'] as Array<'patientName' | 'prescriberName' | 'prescribedDate'>, branchOverridable: false }),
  'sales.receipt_paper_width': define({ group: 'sales', description: 'Thermal receipt paper width in millimetres', schema: z.union([z.literal(58), z.literal(80)]), default: () => 80 as 58 | 80, branchOverridable: true }),
  'sales.receipt_footer': define({ group: 'sales', description: 'Text printed at the bottom of receipts', schema: z.string().max(300), default: () => '', branchOverridable: true }),

  'tax.prices_include_tax': define({ group: 'tax', description: 'Default for new tax rules: whether entered selling prices already include tax. Confirm with your accountant.', schema: z.boolean(), default: () => false, branchOverridable: false }),

  'offline.max_offline_hours': define({ group: 'offline', description: 'How long a register may sell offline before it must sync', schema: z.number().int().min(1).max(720), default: () => 72, branchOverridable: true }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
export const isSettingKey = (k: string): k is SettingKey => Object.prototype.hasOwnProperty.call(SETTINGS, k);
