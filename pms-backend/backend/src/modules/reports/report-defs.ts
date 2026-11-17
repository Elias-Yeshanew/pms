import { many } from '../../database/database.service';
import { Params, ReportCtx, ReportDef } from './report-types';

const SOLD = `s.status <> 'cancelled'`;
const P = (c: ReportCtx) => new Params(c.from, c.to, c.tz);
const branchSql = (c: ReportCtx, p: Params, perm: string, col: string) => {
  let w = c.auth.scopeFor(perm).sql(col, p.values);
  if (c.branchId) w += ` and ${col} = ${p.add(c.branchId)}`;
  return w;
};
const lim = (c: ReportCtx) => Math.min(Math.max(c.limit, 1), 1000);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const run = <T extends Record<string, unknown>>(c: ReportCtx, sql: string, p: Params) => many<T>(c.db, sql, p.values);
const NAME = `coalesce(e.full_name, u.username::text)`;

export const REPORTS: ReportDef[] = [
  // ====================== SALES ======================
  {
    code: 'sales_by_day', title: 'Sales by day', description: 'Receipts, discounts, tax and takings for each day', group: 'sales', permission: 'sales.read', ranged: true,
    columns: [
      { key: 'day', label: 'Date', type: 'date' }, { key: 'sales', label: 'Sales', type: 'int', sum: true }, { key: 'net', label: 'Net sales', type: 'money', sum: true },
      { key: 'discounts', label: 'Discounts', type: 'money', sum: true }, { key: 'tax', label: 'Tax', type: 'money', sum: true }, { key: 'total', label: 'Total', type: 'money', sum: true },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run(c, `select to_char((s.sold_at at time zone $3)::date, 'YYYY-MM-DD') as day, count(*) as sales, sum(s.subtotal) as net, sum(s.discount_total) as discounts, sum(s.tax_total) as tax, sum(s.total) as total
        from sales.sales s where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by 1 order by 1`, p);
      return rows.map((r) => ({ ...r, sales: num(r.sales) })) as never;
    },
  },
  {
    code: 'branch_comparison', title: 'Branch comparison', description: 'Sales, discounts and average receipt for each branch', group: 'management', permission: 'sales.read', ranged: true,
    columns: [
      { key: 'branch', label: 'Branch', type: 'text' }, { key: 'sales', label: 'Sales', type: 'int', sum: true }, { key: 'net', label: 'Net sales', type: 'money', sum: true },
      { key: 'discounts', label: 'Discounts', type: 'money', sum: true }, { key: 'average', label: 'Average receipt', type: 'money' }, { key: 'total', label: 'Total', type: 'money', sum: true },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run(c, `select b.name as branch, count(*) as sales, sum(s.subtotal) as net, sum(s.discount_total) as discounts, round(avg(s.total), 4) as average, sum(s.total) as total
        from sales.sales s join org.branches b on b.id = s.branch_id where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by b.name order by total desc`, p);
      return rows.map((r) => ({ ...r, sales: num(r.sales) })) as never;
    },
  },
  {
    code: 'sales_by_product', title: 'Sales by product', description: 'Quantity sold, returned and revenue per product', group: 'sales', permission: 'sales.read', ranged: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' }, { key: 'sold', label: 'Sold (base units)', type: 'qty', sum: true },
      { key: 'returned', label: 'Returned', type: 'qty', sum: true }, { key: 'net_quantity', label: 'Net quantity', type: 'qty', sum: true },
      { key: 'revenue', label: 'Net revenue', type: 'money', sum: true }, { key: 'discounts', label: 'Discounts', type: 'money', sum: true },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      return run(c, `select pr.sku, pr.name as product, sum(i.base_quantity) as sold, sum(i.returned_base) as returned, sum(i.base_quantity - i.returned_base) as net_quantity, sum(i.line_net) as revenue, sum(i.discount_amount) as discounts
        from sales.sale_items i join sales.sales s on s.id = i.sale_id join catalog.products pr on pr.id = i.product_id
        where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by pr.sku, pr.name order by revenue desc limit ${lim(c)}`, p) as never;
    },
  },
  {
    code: 'top_products', title: 'Top selling products', description: 'The products that earned the most in the period', group: 'sales', permission: 'sales.read', ranged: true,
    columns: [{ key: 'rank', label: '#', type: 'int' }, { key: 'product', label: 'Product', type: 'text' }, { key: 'sold', label: 'Sold (base units)', type: 'qty' }, { key: 'revenue', label: 'Net revenue', type: 'money' }, { key: 'share', label: 'Share of sales', type: 'percent' }],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run<Record<string, unknown>>(c, `select pr.name as product, sum(i.base_quantity - i.returned_base) as sold, sum(i.line_net) as revenue,
          round(100 * sum(i.line_net) / nullif(sum(sum(i.line_net)) over (), 0), 2) as share
        from sales.sale_items i join sales.sales s on s.id = i.sale_id join catalog.products pr on pr.id = i.product_id
        where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by pr.name order by revenue desc limit ${Math.min(lim(c), 50)}`, p);
      return rows.map((r, i) => ({ rank: i + 1, ...r })) as never;
    },
  },
  {
    code: 'payment_methods', title: 'Payment method breakdown', description: 'How customers paid', group: 'sales', permission: 'sales.read', ranged: true,
    columns: [{ key: 'method', label: 'Method', type: 'text' }, { key: 'payments', label: 'Payments', type: 'int', sum: true }, { key: 'amount', label: 'Amount', type: 'money', sum: true }, { key: 'share', label: 'Share', type: 'percent' }],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run(c, `select m.name as method, count(*) as payments, sum(sp.amount) as amount, round(100 * sum(sp.amount) / nullif(sum(sum(sp.amount)) over (), 0), 2) as share
        from sales.sale_payments sp join sales.sales s on s.id = sp.sale_id join sales.payment_methods m on m.id = sp.method_id
        where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by m.name order by amount desc`, p);
      return rows.map((r) => ({ ...r, payments: num(r.payments) })) as never;
    },
  },
  {
    code: 'cashier_performance', title: 'Employee performance', description: 'Sales made by each cashier or dispenser', group: 'management', permission: 'sales.read', ranged: true,
    columns: [
      { key: 'employee', label: 'Employee', type: 'text' }, { key: 'sales', label: 'Sales', type: 'int', sum: true }, { key: 'total', label: 'Total', type: 'money', sum: true },
      { key: 'average', label: 'Average receipt', type: 'money' }, { key: 'discounts', label: 'Discounts given', type: 'money', sum: true }, { key: 'cancelled', label: 'Cancelled', type: 'int', sum: true },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run(c, `select ${NAME} as employee, count(*) filter (where s.status <> 'cancelled') as sales, coalesce(sum(s.total) filter (where s.status <> 'cancelled'), 0) as total,
          coalesce(round(avg(s.total) filter (where s.status <> 'cancelled'), 4), 0) as average, coalesce(sum(s.discount_total) filter (where s.status <> 'cancelled'), 0) as discounts, count(*) filter (where s.status = 'cancelled') as cancelled
        from sales.sales s join iam.users u on u.id = s.cashier_id left join org.employees e on e.id = u.employee_id
        where ${p.range('s.sold_at')} and ${w} group by 1 order by total desc`, p);
      return rows.map((r) => ({ ...r, sales: num(r.sales), cancelled: num(r.cancelled) })) as never;
    },
  },
  {
    code: 'discount_analysis', title: 'Discount analysis', description: 'Who gives discounts, how often and how deep', group: 'management', permission: 'sales.read', ranged: true,
    columns: [
      { key: 'employee', label: 'Employee', type: 'text' }, { key: 'sales', label: 'Sales', type: 'int', sum: true }, { key: 'discounted', label: 'Sales with discount', type: 'int', sum: true },
      { key: 'discounts', label: 'Discount value', type: 'money', sum: true }, { key: 'share', label: 'Discount as % of gross', type: 'percent' }, { key: 'max_percent', label: 'Deepest discount %', type: 'percent' },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'sales.read', 's.branch_id');
      const rows = await run(c, `select ${NAME} as employee, count(*) as sales, count(*) filter (where s.discount_total > 0) as discounted, sum(s.discount_total) as discounts,
          round(100 * sum(s.discount_total) / nullif(sum(s.subtotal + s.discount_total), 0), 2) as share, max(s.max_discount_percent) as max_percent
        from sales.sales s join iam.users u on u.id = s.cashier_id left join org.employees e on e.id = u.employee_id
        where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by 1 order by discounts desc`, p);
      return rows.map((r) => ({ ...r, sales: num(r.sales), discounted: num(r.discounted) })) as never;
    },
  },
  {
    code: 'product_profitability', title: 'Product profitability', description: 'Revenue, cost of goods and margin per product', group: 'management', permission: 'finance.read', ranged: true,
    columns: [
      { key: 'product', label: 'Product', type: 'text' }, { key: 'sold', label: 'Sold (base units)', type: 'qty', sum: true }, { key: 'revenue', label: 'Net revenue', type: 'money', sum: true },
      { key: 'cost', label: 'Cost of goods', type: 'money', sum: true }, { key: 'profit', label: 'Gross profit', type: 'money', sum: true }, { key: 'margin', label: 'Margin %', type: 'percent' },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'finance.read', 's.branch_id');
      return run(c, `select pr.name as product, sum(i.base_quantity) as sold, sum(i.line_net) as revenue, sum(i.cost_total) as cost, sum(i.line_net - i.cost_total) as profit,
          round(100 * sum(i.line_net - i.cost_total) / nullif(sum(i.line_net), 0), 2) as margin
        from sales.sale_items i join sales.sales s on s.id = i.sale_id join catalog.products pr on pr.id = i.product_id
        where ${SOLD} and ${p.range('s.sold_at')} and ${w} group by pr.name order by profit desc limit ${lim(c)}`, p) as never;
    },
  },

  // ====================== INVENTORY ======================
  {
    code: 'stock_valuation', title: 'Stock valuation', description: 'Saleable stock on hand, valued at cost', group: 'inventory', permission: 'inventory.read', ranged: false,
    columns: [{ key: 'sku', label: 'SKU', type: 'text' }, { key: 'product', label: 'Product', type: 'text' }, { key: 'quantity', label: 'On hand (base units)', type: 'qty', sum: true }, { key: 'value', label: 'Value at cost', type: 'money', sum: true, cost: true }],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'inventory.read', 'b.branch_id');
      return run(c, `select pr.sku, pr.name as product, sum(b.quantity) as quantity, round(sum(b.quantity * sb.unit_cost), 4) as value
        from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id join catalog.products pr on pr.id = b.product_id
        where b.status = 'available' and b.quantity > 0 and ${p.keep()} and ${w} group by pr.sku, pr.name order by value desc limit ${lim(c)}`, p) as never;
    },
  },
  {
    code: 'expiry_exposure', title: 'Expiry exposure', description: 'Stock grouped by how soon it expires', group: 'inventory', permission: 'inventory.read', ranged: false,
    columns: [{ key: 'bucket', label: 'Expires', type: 'text' }, { key: 'batches', label: 'Batches', type: 'int', sum: true }, { key: 'quantity', label: 'Quantity (base units)', type: 'qty', sum: true }, { key: 'value', label: 'Value at cost', type: 'money', sum: true, cost: true }],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'inventory.read', 'b.branch_id'); const t = p.add(c.today);
      const rows = await run(c, `with d as (select b.batch_id, sb.expiry_date, (sb.expiry_date - (${t}::date)) as days, b.quantity, sb.unit_cost
          from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id where b.quantity > 0 and b.status in ('available', 'expired', 'quarantined') and ${p.keep()} and ${w})
        select case when days < 0 then '1. Already expired' when days <= 30 then '2. Within 30 days' when days <= 90 then '3. 31 to 90 days' when days <= 180 then '4. 91 to 180 days' else '5. More than 180 days' end as bucket,
          count(distinct batch_id) as batches, sum(quantity) as quantity, round(sum(quantity * unit_cost), 4) as value from d group by 1 order by 1`, p);
      return rows.map((r) => ({ ...r, bucket: String(r.bucket).replace(/^\d\. /, ''), batches: num(r.batches) })) as never;
    },
  },
  {
    code: 'slow_movers', title: 'Slow moving stock', description: 'Products with stock on hand that sold little or nothing in the period', group: 'inventory', permission: 'inventory.read', ranged: true,
    columns: [{ key: 'product', label: 'Product', type: 'text' }, { key: 'on_hand', label: 'On hand (base units)', type: 'qty' }, { key: 'sold', label: 'Sold in period', type: 'qty' }, { key: 'value', label: 'Value at cost', type: 'money', cost: true }],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'inventory.read', 'b.branch_id');
      const sw = c.auth.scopeFor('sales.read').sql('s.branch_id', p.values) + (c.branchId ? ` and s.branch_id = ${p.add(c.branchId)}` : '');
      return run(c, `with stock as (select b.product_id, sum(b.quantity) as on_hand, round(sum(b.quantity * sb.unit_cost), 4) as value from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id where b.status = 'available' and b.quantity > 0 and ${w} group by b.product_id),
          sold as (select i.product_id, sum(i.base_quantity - i.returned_base) as sold from sales.sale_items i join sales.sales s on s.id = i.sale_id where ${SOLD} and ${p.range('s.sold_at')} and ${sw} group by i.product_id)
        select pr.name as product, st.on_hand, coalesce(so.sold, 0)::numeric(18,4) as sold, st.value from stock st join catalog.products pr on pr.id = st.product_id left join sold so on so.product_id = st.product_id
        order by coalesce(so.sold, 0) asc, st.value desc limit ${lim(c)}`, p) as never;
    },
  },
  {
    code: 'stock_turnover', title: 'Stock turnover and cover', description: 'How fast each product sells against what is on the shelf', group: 'inventory', permission: 'inventory.read', ranged: true,
    columns: [
      { key: 'product', label: 'Product', type: 'text' }, { key: 'sold', label: 'Sold in period', type: 'qty' }, { key: 'on_hand', label: 'On hand', type: 'qty' },
      { key: 'days_of_cover', label: 'Days of cover', type: 'qty' }, { key: 'turnover', label: 'Turnover (cost ÷ stock value)', type: 'qty', cost: true },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'inventory.read', 'b.branch_id');
      const sw = c.auth.scopeFor('sales.read').sql('s.branch_id', p.values) + (c.branchId ? ` and s.branch_id = ${p.add(c.branchId)}` : '');
      const days = p.add(c.days);
      return run(c, `with stock as (select b.product_id, sum(b.quantity) as on_hand, sum(b.quantity * sb.unit_cost) as value from inventory.stock_balances b join inventory.stock_batches sb on sb.id = b.batch_id where b.status = 'available' and ${w} group by b.product_id),
          sold as (select i.product_id, sum(i.base_quantity - i.returned_base) as sold, sum(i.cost_total) as cost from sales.sale_items i join sales.sales s on s.id = i.sale_id where ${SOLD} and ${p.range('s.sold_at')} and ${sw} group by i.product_id)
        select pr.name as product, coalesce(so.sold, 0)::numeric(18,4) as sold, coalesce(st.on_hand, 0)::numeric(18,4) as on_hand,
          case when coalesce(so.sold, 0) > 0 then round(coalesce(st.on_hand, 0) / (so.sold / ${days}::numeric), 1) end as days_of_cover,
          case when coalesce(st.value, 0) > 0 then round(coalesce(so.cost, 0) / st.value, 2) end as turnover
        from catalog.products pr left join stock st on st.product_id = pr.id left join sold so on so.product_id = pr.id
        where coalesce(so.sold, 0) > 0 or coalesce(st.on_hand, 0) > 0 order by coalesce(so.sold, 0) desc limit ${lim(c)}`, p) as never;
    },
  },

  // ====================== PROCUREMENT ======================
  {
    code: 'supplier_performance', title: 'Supplier performance', description: 'Orders, lead time, on-time delivery and rejected goods per supplier', group: 'procurement', permission: 'procurement.read', ranged: true,
    columns: [
      { key: 'supplier', label: 'Supplier', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'ordered', label: 'Ordered value', type: 'money', sum: true },
      { key: 'lead_days', label: 'Average lead time (days)', type: 'qty' }, { key: 'on_time', label: 'On time %', type: 'percent' }, { key: 'rejected', label: 'Rejected %', type: 'percent' },
    ],
    async run(c) {
      const p = P(c); const w = branchSql(c, p, 'procurement.read', 'po.branch_id');
      const rows = await run(c, `with po as (select po.id, po.supplier_id, po.total, po.order_date, po.expected_date from procurement.purchase_orders po
            where po.status not in ('draft', 'cancelled', 'rejected') and po.order_date between $1::date and $2::date and ${w}),
          first_gr as (select gr.purchase_order_id, min(gr.received_at) as at from procurement.goods_receipts gr group by gr.purchase_order_id),
          rej as (select gr.supplier_id, sum(i.received_base) as received, sum(coalesce(i.rejected_base, 0)) as rejected from procurement.goods_receipt_items i join procurement.goods_receipts gr on gr.id = i.receipt_id
            where gr.status = 'completed' and gr.purchase_order_id in (select id from po) group by gr.supplier_id)
        select s.name as supplier, count(*) as orders, sum(po.total) as ordered,
          round(avg((f.at at time zone $3)::date - po.order_date) filter (where f.at is not null), 1) as lead_days,
          round(100.0 * count(*) filter (where f.at is not null and po.expected_date is not null and (f.at at time zone $3)::date <= po.expected_date) / nullif(count(*) filter (where f.at is not null and po.expected_date is not null), 0), 1) as on_time,
          round(100 * max(r.rejected) / nullif(max(r.received), 0), 2) as rejected
        from po join procurement.suppliers s on s.id = po.supplier_id left join first_gr f on f.purchase_order_id = po.id left join rej r on r.supplier_id = po.supplier_id
        group by s.name order by ordered desc`, p);
      return rows.map((r) => ({ ...r, orders: num(r.orders) })) as never;
    },
  },
];

export const REPORT_BY_CODE = new Map(REPORTS.map((r) => [r.code, r]));
