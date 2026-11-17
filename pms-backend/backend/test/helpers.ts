import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/database/database.service';
import { runMigrations } from '../src/database/migrate';
import { MessagingService } from '../src/modules/iam/messaging.service';
import { PasswordService } from '../src/modules/iam/password.service';
import { bootstrapAdmin, seedAccessControl, seedReferenceData } from '../src/seed/seed';

export const GOOD_PASSWORD = 'Str0ng-Passw0rd!';
export const ADMIN = { username: 'admin', password: 'Adm1n-Passw0rd!' };

export interface TestCtx {
  app: INestApplication;
  db: DatabaseService;
  messaging: MessagingService;
  http: () => ReturnType<typeof request>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestCtx> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://pms:pms_dev_pw@localhost:5432/pms_test',
    JWT_ACCESS_SECRET: 'test_secret_test_secret_test_secret_test_1234',
    PERMISSION_CACHE_TTL_MS: '0',
    SETTINGS_CACHE_TTL_MS: '0',
    THROTTLE_LOGIN_LIMIT: '1000',
    MAX_FAILED_LOGINS: '3',
    LOCKOUT_MINUTES: '15',
    SWAGGER_ENABLED: 'false',
    ...overrides,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const db = app.get(DatabaseService);
  await runMigrations(db.pool);

  const reset = async () => {
    await db.query(`truncate iam.password_reset_tokens, iam.login_history, iam.sessions, iam.user_branch_access,
      iam.user_permission_overrides, iam.user_roles, iam.users, iam.role_permissions, iam.roles, iam.permissions,
      org.cash_registers, org.storage_locations, org.warehouses, org.employees, org.departments, org.branches,
      platform.seed_grants, platform.settings, platform.settings_history, platform.document_sequences,
      finance.tax_rules, finance.tax_categories,
      sync.conflicts, sync.change_log, sync.devices,
      platform.notification_reads, platform.notification_preferences, platform.notifications, platform.job_runs,
      finance.manual_journals, finance.journal_lines, finance.journal_entries, finance.register_sessions, finance.expenses, finance.incomes,
      finance.expense_categories, finance.income_categories, finance.account_mappings, finance.fiscal_periods, finance.accounts,
      catalog.import_jobs, catalog.price_update_items, catalog.price_update_batches,
      catalog.price_change_log, catalog.product_prices, catalog.product_barcodes, catalog.product_suppliers, catalog.product_units,
      catalog.products, catalog.manufacturers, catalog.categories, catalog.dosage_forms, catalog.units,
      sales.sales_return_allocations, sales.sales_return_items, sales.sale_refunds, sales.sales_returns, sales.sale_payments, sales.sale_item_allocations, sales.sale_items,
      sales.discount_requests, sales.sales, sales.prescription_items, sales.prescriptions, sales.customer_payments, sales.customer_ledger, sales.customers, sales.payment_methods,
      procurement.supplier_credit_applications, procurement.supplier_credits, procurement.purchase_return_items, procurement.purchase_returns,
      procurement.supplier_payment_allocations, procurement.supplier_payments, procurement.supplier_invoices,
      procurement.goods_receipt_items, procurement.goods_receipts, procurement.purchase_order_revisions, procurement.purchase_order_items,
      procurement.purchase_orders, procurement.purchase_request_items, procurement.purchase_requests,
      inventory.stock_count_items, inventory.stock_counts, inventory.stock_transfer_items, inventory.stock_transfers,
      inventory.stock_disposal_items, inventory.stock_disposals, inventory.stock_adjustment_items, inventory.stock_adjustments,
      inventory.stock_movements, inventory.stock_balances, inventory.stock_batches, platform.approval_requests,
      procurement.suppliers, audit.audit_logs restart identity cascade`);
    await seedAccessControl(db.pool);
    await seedReferenceData(db.pool);
    app.get(MessagingService).outbox.length = 0;
  };
  return {
    app, db, messaging: app.get(MessagingService),
    http: () => request(app.getHttpServer()),
    reset,
    close: () => app.close(),
  };
}

/** Creates the first System Administrator exactly as the seed script does, then clears the first-login flag. */
export async function makeAdmin(ctx: TestCtx) {
  await bootstrapAdmin(ctx.db.pool, ctx.app.get(PasswordService), ADMIN.username, ADMIN.password);
  await ctx.db.query(`update iam.users set must_change_password = false where username = $1`, [ADMIN.username]);
}

export async function login(ctx: TestCtx, username: string, password: string) {
  const res = await ctx.http().post('/api/v1/auth/login').send({ username, password });
  return res;
}

export async function tokenFor(ctx: TestCtx, username: string, password: string): Promise<string> {
  const res = await login(ctx, username, password);
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

export const authed = (ctx: TestCtx, token: string) => ({
  get: (p: string) => ctx.http().get(`/api/v1${p}`).set('Authorization', `Bearer ${token}`),
  post: (p: string, b: object = {}) => ctx.http().post(`/api/v1${p}`).set('Authorization', `Bearer ${token}`).send(b),
  patch: (p: string, b: object = {}) => ctx.http().patch(`/api/v1${p}`).set('Authorization', `Bearer ${token}`).send(b),
  put: (p: string, b: object = {}) => ctx.http().put(`/api/v1${p}`).set('Authorization', `Bearer ${token}`).send(b),
  del: (p: string) => ctx.http().delete(`/api/v1${p}`).set('Authorization', `Bearer ${token}`),
});

export async function roleId(ctx: TestCtx, name: string): Promise<string> {
  return (await ctx.db.query(`select id from iam.roles where name = $1`, [name])).rows[0].id;
}
