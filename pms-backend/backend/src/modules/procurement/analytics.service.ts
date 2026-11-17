import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/app-error';
import { AuthContext } from '../../common/auth-types';
import { DatabaseService, many, maybeOne, one } from '../../database/database.service';
import { format, parse } from '../../domain/decimal';

/** Helps choose a supplier and judge how well suppliers perform. */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  /** For one product: what each supplier last charged, per base unit, so offers can be compared like for like. */
  async priceComparison(productId: string) {
    const p = await maybeOne<{ name: string; sku: string }>(this.db, `select name, sku from catalog.products where id = $1`, [productId]);
    if (!p) throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found.');
    const rows = await many<{ supplier_id: string; supplier_name: string; supplier_status: string; listed_price: string | null; last_cost: string | null; last_received: string | null; last_order_cost: string | null; last_order_date: string | null }>(this.db,
      `select s.id as supplier_id, s.name as supplier_name, s.status as supplier_status, ps.last_price as listed_price,
              lr.unit_cost as last_cost, to_char(lr.received_at, 'YYYY-MM-DD') as last_received,
              lo.cost as last_order_cost, to_char(lo.order_date, 'YYYY-MM-DD') as last_order_date
         from procurement.suppliers s
         left join catalog.product_suppliers ps on ps.supplier_id = s.id and ps.product_id = $1
         left join lateral (select gi.unit_cost, g.received_at from procurement.goods_receipt_items gi join procurement.goods_receipts g on g.id = gi.receipt_id where g.supplier_id = s.id and gi.product_id = $1 order by g.received_at desc limit 1) lr on true
         left join lateral (select round(i.line_net / i.base_quantity, 4) as cost, o.order_date from procurement.purchase_order_items i join procurement.purchase_orders o on o.id = i.order_id
                             where o.supplier_id = s.id and i.product_id = $1 and o.status in ('approved', 'partially_received', 'received', 'closed') order by o.order_date desc, o.created_at desc limit 1) lo on true
        where ps.product_id is not null or lr.unit_cost is not null or lo.cost is not null`, [productId]);
    const best = (r: typeof rows[number]) => r.last_order_cost ?? r.last_cost ?? r.listed_price;
    const offers = rows.map((r) => ({ ...r, comparable_cost: best(r) })).sort((a, b) => (a.comparable_cost === null ? 1 : b.comparable_cost === null ? -1 : parse(a.comparable_cost) < parse(b.comparable_cost) ? -1 : 1));
    return { productId, sku: p.sku, name: p.name, note: 'All costs are per base unit, net of tax.', offers, cheapestSupplierId: offers.find((o) => o.supplier_status === 'active' && o.comparable_cost !== null)?.supplier_id ?? null };
  }

  /** On-time delivery, how much of what was ordered was accepted, rejection rate, lead time and spend. */
  async supplierPerformance(auth: AuthContext, supplierId: string, from?: string, to?: string) {
    const s = await maybeOne<{ name: string }>(this.db, `select name from procurement.suppliers where id = $1`, [supplierId]);
    if (!s) throw AppError.notFound('SUPPLIER_NOT_FOUND', 'Supplier not found.');
    const params: unknown[] = [supplierId, from ?? null, to ?? null];
    const scope = auth.scopeFor('procurement.read').sql('o.branch_id', params);
    const base = `from procurement.purchase_orders o where o.supplier_id = $1 and o.status in ('approved', 'partially_received', 'received', 'closed') and ($2::date is null or o.order_date >= $2) and ($3::date is null or o.order_date <= $3) and ${scope}`;
    const orders = await one<{ orders: number; ordered: string; received: string; accepted: string; rejected: string }>(this.db,
      `select count(*)::int as orders, coalesce((select sum(i.base_quantity) from procurement.purchase_order_items i where i.order_id in (select o.id ${base})), 0)::numeric(18,4) as ordered,
              coalesce((select sum(i.received_base) from procurement.purchase_order_items i where i.order_id in (select o.id ${base})), 0)::numeric(18,4) as received,
              coalesce((select sum(i.accepted_base) from procurement.purchase_order_items i where i.order_id in (select o.id ${base})), 0)::numeric(18,4) as accepted,
              coalesce((select sum(i.rejected_base) from procurement.purchase_order_items i where i.order_id in (select o.id ${base})), 0)::numeric(18,4) as rejected
         ${base}`, params);
    const timing = await one<{ measured: number; on_time: number; avg_lead_days: string | null }>(this.db,
      `select count(*)::int as measured, count(*) filter (where first_receipt <= expected_date)::int as on_time, round(avg(first_receipt - order_date), 1)::text as avg_lead_days
         from (select o.order_date, o.expected_date, (select min(g.received_at)::date from procurement.goods_receipts g where g.purchase_order_id = o.id) as first_receipt ${base}) t
        where first_receipt is not null`, params);
    const spend = await one<{ v: string }>(this.db, `select coalesce(sum(i.total), 0)::numeric(18,4) as v from procurement.supplier_invoices i join procurement.purchase_orders o on o.id = i.purchase_order_id
        where i.supplier_id = $1 and i.status not in ('rejected', 'cancelled', 'pending_approval') and ($2::date is null or i.invoice_date >= $2) and ($3::date is null or i.invoice_date <= $3) and ${scope}`, params);
    const pct = (a: string, b: string) => (parse(b) === 0n ? null : (Number((parse(a) * 10000n) / parse(b)) / 100).toFixed(2));
    return {
      supplierId, supplierName: s.name, from: from ?? null, to: to ?? null, orders: orders.orders,
      fillRatePercent: pct(orders.accepted, orders.ordered), rejectionRatePercent: pct(orders.rejected, orders.received),
      onTimeDeliveryPercent: timing.measured ? ((timing.on_time * 100) / timing.measured).toFixed(2) : null, deliveriesMeasured: timing.measured,
      averageLeadTimeDays: timing.avg_lead_days, totalInvoiced: format(parse(spend.v)),
      quantities: { ordered: orders.ordered, received: orders.received, accepted: orders.accepted, rejected: orders.rejected },
    };
  }
}
