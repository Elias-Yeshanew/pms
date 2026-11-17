import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, one } from '../../database/database.service';
import { add, divide, format, parse } from '../../domain/decimal';
import { SettingsService } from '../platform/settings.service';
import { Preset, resolvePeriod } from './period';
import { REPORT_BY_CODE, REPORTS } from './report-defs';
import { Col, ReportCtx, Row } from './report-types';

export interface ReportFilters { preset?: Preset; from?: string; to?: string; branchId?: string; limit?: number; options?: Record<string, string | undefined> }
export interface ReportResult {
  code: string; title: string; description: string; columns: Col[]; rows: Row[]; totals: Row | null;
  period: { preset: string; from: string; to: string; days: number } | null; branchId: string | null; generatedAt: string;
}

/** Dashboards: a handful of headline numbers and small tables for each kind of manager, built from the same reports. */
const DASHBOARDS: Record<string, { title: string; requires: string[] }> = {
  ceo: { title: 'Executive overview', requires: ['dashboards.management', 'sales.read', 'finance.read'] },
  pharmacy_manager: { title: 'Pharmacy manager', requires: ['dashboards.management', 'sales.read', 'inventory.read'] },
  supply_chain: { title: 'Supply chain', requires: ['dashboards.management', 'procurement.read', 'inventory.read'] },
  sales_manager: { title: 'Sales manager', requires: ['dashboards.management', 'sales.read'] },
  dispenser: { title: 'My shift', requires: ['sales.create'] },
};

type Tile = { key: string; label: string; value: string | number | null; type: 'money' | 'int' | 'percent' | 'qty' };

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService, private readonly settings: SettingsService) {}

  catalog(auth: AuthContext) {
    return REPORTS.filter((r) => auth.can(r.permission)).map((r) => ({ code: r.code, title: r.title, description: r.description, group: r.group, ranged: r.ranged, columns: r.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })) }));
  }

  private async ctx(auth: AuthContext, f: ReportFilters, ranged: boolean): Promise<ReportCtx & { period: ReportResult['period'] }> {
    const tz = String(await this.settings.get('business.timezone', null));
    const today = await this.settings.businessDate(new Date());
    const per = resolvePeriod(today, f.preset ?? (f.from && f.to ? 'custom' : 'this_month'), f.from, f.to);
    if (f.branchId && !auth.scopeFor('sales.read').includes(f.branchId) && !auth.scopeFor('inventory.read').includes(f.branchId) && !auth.scopeFor('procurement.read').includes(f.branchId) && !auth.scopeFor('finance.read').includes(f.branchId)) {
      throw AppError.forbidden('PERMISSION_DENIED', 'You cannot see reports for this branch.');
    }
    return { db: this.db, auth, from: per.from, to: per.to, days: per.days, tz, today, branchId: f.branchId, limit: f.limit ?? 200, canCost: auth.can('finance.read'), options: f.options ?? {}, period: ranged ? per : null };
  }

  async run(auth: AuthContext, code: string, f: ReportFilters = {}): Promise<ReportResult> {
    const def = REPORT_BY_CODE.get(code);
    if (!def) throw AppError.notFound('REPORT_NOT_FOUND', 'Report not found.');
    if (!auth.can(def.permission)) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to view this report.');
    const c = await this.ctx(auth, f, def.ranged);
    const cols = def.columns.filter((x) => !x.cost || c.canCost);
    const raw = await def.run(c);
    const keys = new Set(cols.map((x) => x.key));
    const rows = raw.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.has(k)))) as Row[];
    let totals: Row | null = null;
    if (rows.length && cols.some((x) => x.sum)) {
      totals = {};
      for (const col of cols) {
        if (!col.sum) continue;
        totals[col.key] = col.type === 'int' ? rows.reduce((t, r) => t + Number(r[col.key] ?? 0), 0) : rows.reduce((t: string, r) => (r[col.key] == null ? t : add(t, String(r[col.key]))), '0.0000');
      }
    }
    return { code, title: def.title, description: def.description, columns: cols, rows, totals, period: c.period, branchId: f.branchId ?? null, generatedAt: new Date().toISOString() };
  }

  // =============== dashboards ===============
  listDashboards(auth: AuthContext) {
    return Object.entries(DASHBOARDS).filter(([, d]) => d.requires.every((p) => auth.can(p))).map(([role, d]) => ({ role, title: d.title }));
  }

  async dashboard(auth: AuthContext, role: string, f: ReportFilters = {}) {
    const d = DASHBOARDS[role];
    if (!d) throw AppError.notFound('DASHBOARD_NOT_FOUND', 'Dashboard not found.');
    if (!d.requires.every((p) => auth.can(p))) throw AppError.forbidden('PERMISSION_DENIED', 'You do not have permission to open this dashboard.');
    const sum = async (extra = {}) => this.salesTotals(auth, f, extra);
    const tiles: Tile[] = []; const tables: Array<ReportResult> = [];
    const t = (key: string, label: string, value: string | number | null, type: Tile['type']) => tiles.push({ key, label, value, type });
    const rep = async (code: string, limit = 10, ff: ReportFilters = f) => { const r = await this.run(auth, code, { ...ff, limit }); tables.push(r); return r; };
    const alerts = (types: string[]) => this.alertCount(auth, d.requires[1], types, f.branchId);

    if (role === 'ceo' || role === 'sales_manager' || role === 'pharmacy_manager') {
      const s = await sum();
      t('net_sales', 'Net sales', s.net, 'money'); t('sales', 'Sales', s.sales, 'int'); t('average', 'Average receipt', s.average, 'money'); t('discounts', 'Discounts given', s.discounts, 'money');
    }
    if (role === 'ceo') {
      const pr = await this.run(auth, 'product_profitability', { ...f, limit: 1000 });
      const rev = pr.totals?.revenue as string | undefined, profit = pr.totals?.profit as string | undefined;
      t('gross_profit', 'Gross profit', profit ?? '0.0000', 'money');
      t('margin', 'Gross margin %', rev && Number(rev) > 0 ? Math.round((Number(profit) / Number(rev)) * 10000) / 100 : null, 'percent');
      const ex = await this.run(auth, 'expiry_exposure', f).catch(() => null);
      if (ex) { const risk = ex.rows.filter((r) => ['Already expired', 'Within 30 days', '31 to 90 days'].includes(String(r.bucket))); t('expiry_risk', 'Stock expiring within 90 days (at cost)', risk.reduce((a: string, r) => add(a, String(r.value ?? '0')), '0.0000'), 'money'); }
      await rep('branch_comparison'); await rep('top_products', 5); await rep('payment_methods');
    }
    if (role === 'sales_manager') { await rep('sales_by_day', 40); await rep('top_products', 10); await rep('cashier_performance'); await rep('discount_analysis'); }
    if (role === 'pharmacy_manager') {
      t('low_stock', 'Low-stock alerts', await alerts(['low_stock']), 'int'); t('out_of_stock', 'Out-of-stock alerts', await alerts(['out_of_stock']), 'int');
      t('expiry_alerts', 'Expiry alerts', await alerts(['expiry', 'expired_stock']), 'int'); t('pending_approvals', 'Waiting for approval', await alerts(['pending_approvals']), 'int');
      t('sync_conflicts', 'Offline sales needing attention', await this.openConflicts(auth, f.branchId), 'int');
      await rep('sales_by_day', 40); await rep('expiry_exposure'); await rep('slow_movers', 10);
    }
    if (role === 'supply_chain') {
      const po = await this.procurementCounts(auth, f.branchId);
      t('open_orders', 'Open purchase orders', po.open, 'int'); t('overdue_orders', 'Overdue deliveries', po.overdue, 'int'); t('pending_inspection', 'Deliveries awaiting inspection', po.inspection, 'int');
      t('low_stock', 'Low-stock alerts', await alerts(['low_stock', 'out_of_stock']), 'int'); t('supplier_due', 'Supplier payments due soon', await alerts(['supplier_payment_due']), 'int');
      await rep('supplier_performance'); await rep('expiry_exposure'); await rep('stock_turnover', 15);
    }
    if (role === 'dispenser') {
      const mine = await one<{ sales: string; total: string }>(this.db, `select count(*)::text sales, coalesce(sum(total), 0)::text total from sales.sales where cashier_id = $1 and status <> 'cancelled' and sold_at >= (($2::date)::timestamp at time zone $3)`, [auth.userId, await this.settings.businessDate(new Date()), String(await this.settings.get('business.timezone', null))]);
      t('my_sales_today', 'My sales today', Number(mine.sales), 'int'); t('my_total_today', 'My takings today', format(parse(mine.total)), 'money');
    }
    return { role, title: d.title, period: (await this.ctx(auth, f, true)).period, tiles, tables, generatedAt: new Date().toISOString() };
  }

  private async salesTotals(auth: AuthContext, f: ReportFilters, _extra = {}) {
    const r = await this.run(auth, 'sales_by_day', { ...f, limit: 1000 });
    const sales = Number(r.totals?.sales ?? 0), net = String(r.totals?.net ?? '0.0000'), total = String(r.totals?.total ?? '0.0000');
    return { sales, net, discounts: String(r.totals?.discounts ?? '0.0000'), average: sales ? divide(total, String(sales)) : '0.0000' };
  }

  private async alertCount(auth: AuthContext, perm: string, types: string[], branchId?: string): Promise<number> {
    const params: unknown[] = [types]; const w = [`n.resolved_at is null`, `n.type = any($1::text[])`, auth.scopeFor(perm).sql('n.branch_id', params)];
    if (branchId) { params.push(branchId); w.push(`n.branch_id = $${params.length}`); }
    return Number((await one<{ n: string }>(this.db, `select count(*)::text n from platform.notifications n where ${w.join(' and ')}`, params)).n);
  }

  private async openConflicts(auth: AuthContext, branchId?: string): Promise<number> {
    const params: unknown[] = []; const w = [`c.status = 'open'`, auth.scopeFor('sync.resolve').sql('c.branch_id', params)];
    if (branchId) { params.push(branchId); w.push(`c.branch_id = $${params.length}`); }
    return Number((await one<{ n: string }>(this.db, `select count(*)::text n from sync.conflicts c where ${w.join(' and ')}`, params)).n);
  }

  private async procurementCounts(auth: AuthContext, branchId?: string) {
    const today = await this.settings.businessDate(new Date());
    const params: unknown[] = [today]; const w = [auth.scopeFor('procurement.read').sql('po.branch_id', params)];
    if (branchId) { params.push(branchId); w.push(`po.branch_id = $${params.length}`); }
    const o = await one<{ open: string; overdue: string }>(this.db, `select count(*) filter (where po.status in ('approved', 'partially_received'))::text as open, count(*) filter (where po.status in ('approved', 'partially_received') and po.expected_date < $1::date)::text as overdue from procurement.purchase_orders po where ${w.join(' and ')}`, params);
    const params2: unknown[] = []; const w2 = [`gr.status = 'pending_inspection'`, auth.scopeFor('procurement.read').sql('gr.branch_id', params2)];
    if (branchId) { params2.push(branchId); w2.push(`gr.branch_id = $${params2.length}`); }
    const g = await one<{ n: string }>(this.db, `select count(*)::text n from procurement.goods_receipts gr where ${w2.join(' and ')}`, params2);
    return { open: Number(o.open), overdue: Number(o.overdue), inspection: Number(g.n) };
  }
}
