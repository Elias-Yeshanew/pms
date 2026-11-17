-- Procurement: requests, orders, receiving with inspection, supplier invoices, payments, returns and credits

create table procurement.purchase_requests (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  branch_id     uuid not null references org.branches (id) on delete restrict,
  warehouse_id  uuid not null references org.warehouses (id) on delete restrict,
  status        text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected', 'cancelled', 'converted')),
  needed_by     date,
  note          text,
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  decided_at    timestamptz,
  version       integer not null default 1
);
create table procurement.purchase_request_items (
  id             uuid primary key default public.uuid_v7(),
  request_id     uuid not null references procurement.purchase_requests (id) on delete restrict,
  product_id     uuid not null references catalog.products (id) on delete restrict,
  unit_id        uuid not null references catalog.units (id) on delete restrict,
  quantity       numeric(18, 4) not null check (quantity > 0),
  base_quantity  numeric(18, 4) not null check (base_quantity > 0),
  note           text
);
create index ix_pr_items_request on procurement.purchase_request_items (request_id);

create table procurement.purchase_orders (
  id                   uuid primary key default public.uuid_v7(),
  reference_no         text not null unique,
  branch_id            uuid not null references org.branches (id) on delete restrict,
  warehouse_id         uuid not null references org.warehouses (id) on delete restrict,
  supplier_id          uuid not null references procurement.suppliers (id) on delete restrict,
  purchase_request_id  uuid references procurement.purchase_requests (id) on delete restrict,
  status               text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'closed', 'cancelled', 'rejected')),
  order_date           date not null,
  expected_date        date,
  subtotal             numeric(18, 4) not null default 0,
  tax_total            numeric(18, 4) not null default 0,
  total                numeric(18, 4) not null default 0,
  payment_terms_days   integer not null default 0,
  note                 text,
  cancel_reason        text,
  revision             integer not null default 1,
  created_by           uuid not null references iam.users (id) on delete restrict,
  created_at           timestamptz not null default now(),
  approved_by          uuid references iam.users (id) on delete restrict,
  approved_at          timestamptz,
  updated_at           timestamptz not null default now(),
  version              integer not null default 1
);
create index ix_po_supplier on procurement.purchase_orders (supplier_id, status);
create index ix_po_branch on procurement.purchase_orders (branch_id, order_date desc);
create trigger trg_po_touch before update on procurement.purchase_orders for each row execute function public.touch_row();

create table procurement.purchase_order_items (
  id             uuid primary key default public.uuid_v7(),
  order_id       uuid not null references procurement.purchase_orders (id) on delete restrict,
  product_id     uuid not null references catalog.products (id) on delete restrict,
  unit_id        uuid not null references catalog.units (id) on delete restrict,
  quantity       numeric(18, 4) not null check (quantity > 0),           -- in the ordered pack
  base_quantity  numeric(18, 4) not null check (base_quantity > 0),
  unit_price     numeric(18, 4) not null check (unit_price >= 0),         -- per pack
  tax_rate       numeric(7, 4) not null default 0,
  line_net       numeric(18, 4) not null,
  tax_amount     numeric(18, 4) not null,
  line_total     numeric(18, 4) not null,
  received_base  numeric(18, 4) not null default 0 check (received_base >= 0),
  accepted_base  numeric(18, 4) not null default 0 check (accepted_base >= 0),
  rejected_base  numeric(18, 4) not null default 0 check (rejected_base >= 0),
  unique (order_id, product_id, unit_id)
);
create index ix_po_items_order on procurement.purchase_order_items (order_id);

create table procurement.purchase_order_revisions (
  id            uuid primary key default public.uuid_v7(),
  order_id      uuid not null references procurement.purchase_orders (id) on delete restrict,
  revision_no   integer not null,
  reason        text not null,
  items         jsonb not null,
  status        text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'cancelled')),
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  unique (order_id, revision_no)
);

create table procurement.goods_receipts (
  id                uuid primary key default public.uuid_v7(),
  reference_no      text not null unique,
  branch_id         uuid not null references org.branches (id) on delete restrict,
  warehouse_id      uuid not null references org.warehouses (id) on delete restrict,
  purchase_order_id uuid not null references procurement.purchase_orders (id) on delete restrict,
  supplier_id       uuid not null references procurement.suppliers (id) on delete restrict,
  delivery_note_no  text,
  status            text not null default 'pending_inspection' check (status in ('pending_inspection', 'completed')),
  note              text,
  received_by       uuid not null references iam.users (id) on delete restrict,
  received_at       timestamptz not null default now(),
  inspected_by      uuid references iam.users (id) on delete restrict,
  inspected_at      timestamptz,
  version           integer not null default 1
);
create index ix_receipts_po on procurement.goods_receipts (purchase_order_id);
create table procurement.goods_receipt_items (
  id                uuid primary key default public.uuid_v7(),
  receipt_id        uuid not null references procurement.goods_receipts (id) on delete restrict,
  order_item_id     uuid not null references procurement.purchase_order_items (id) on delete restrict,
  product_id        uuid not null references catalog.products (id) on delete restrict,
  unit_id           uuid not null references catalog.units (id) on delete restrict,
  batch_id          uuid references inventory.stock_batches (id) on delete restrict,
  batch_ref         text not null,
  expiry_date       date not null,
  manufacture_date  date,
  location_id       uuid references org.storage_locations (id) on delete restrict,
  received_qty      numeric(18, 4) not null check (received_qty > 0),
  received_base     numeric(18, 4) not null check (received_base > 0),
  accepted_base     numeric(18, 4) check (accepted_base >= 0),
  rejected_base     numeric(18, 4) check (rejected_base >= 0),
  rejection_reason  text,
  unit_cost         numeric(18, 4) not null check (unit_cost >= 0)       -- per base unit, net of tax
);
create index ix_receipt_items_receipt on procurement.goods_receipt_items (receipt_id);
alter table inventory.stock_batches add constraint fk_batches_receipt_item
  foreign key (goods_receipt_item_id) references procurement.goods_receipt_items (id) on delete restrict;

create table procurement.supplier_invoices (
  id                 uuid primary key default public.uuid_v7(),
  reference_no       text not null unique,
  supplier_id        uuid not null references procurement.suppliers (id) on delete restrict,
  branch_id          uuid not null references org.branches (id) on delete restrict,
  purchase_order_id  uuid references procurement.purchase_orders (id) on delete restrict,
  invoice_no         text not null,
  invoice_date       date not null,
  due_date           date not null,
  subtotal           numeric(18, 4) not null check (subtotal >= 0),
  tax_total          numeric(18, 4) not null check (tax_total >= 0),
  total              numeric(18, 4) not null check (total > 0),
  paid_total         numeric(18, 4) not null default 0 check (paid_total >= 0),
  credited_total     numeric(18, 4) not null default 0 check (credited_total >= 0),
  status             text not null default 'open' check (status in ('pending_approval', 'open', 'partially_paid', 'paid', 'rejected', 'cancelled')),
  variance           numeric(18, 4),
  note               text,
  created_by         uuid not null references iam.users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  version            integer not null default 1,
  constraint uq_supplier_invoice_no unique (supplier_id, invoice_no),
  check (total = subtotal + tax_total),
  check (paid_total + credited_total <= total)
);
create index ix_invoices_supplier on procurement.supplier_invoices (supplier_id, status);
create index ix_invoices_due on procurement.supplier_invoices (due_date) where status in ('open', 'partially_paid');

create table procurement.supplier_payments (
  id               uuid primary key default public.uuid_v7(),
  reference_no     text not null unique,
  supplier_id      uuid not null references procurement.suppliers (id) on delete restrict,
  payment_date     date not null,
  amount           numeric(18, 4) not null check (amount > 0),
  method           text not null check (method in ('cash', 'bank_transfer', 'cheque', 'mobile_money', 'other')),
  external_ref     text,
  note             text,
  status           text not null default 'posted' check (status in ('posted', 'reversed')),
  created_by       uuid not null references iam.users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  reversed_by      uuid references iam.users (id) on delete restrict,
  reversed_at      timestamptz,
  reversal_reason  text
);
create index ix_payments_supplier on procurement.supplier_payments (supplier_id, payment_date);
create table procurement.supplier_payment_allocations (
  id          uuid primary key default public.uuid_v7(),
  payment_id  uuid not null references procurement.supplier_payments (id) on delete restrict,
  invoice_id  uuid not null references procurement.supplier_invoices (id) on delete restrict,
  amount      numeric(18, 4) not null check (amount > 0)
);
create index ix_alloc_invoice on procurement.supplier_payment_allocations (invoice_id);

create table procurement.purchase_returns (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  supplier_id   uuid not null references procurement.suppliers (id) on delete restrict,
  branch_id     uuid not null references org.branches (id) on delete restrict,
  warehouse_id  uuid not null references org.warehouses (id) on delete restrict,
  receipt_id    uuid references procurement.goods_receipts (id) on delete restrict,
  reason        text not null check (length(trim(reason)) >= 3),
  note          text,
  status        text not null default 'pending_approval' check (status in ('pending_approval', 'posted', 'rejected', 'cancelled')),
  credit_amount numeric(18, 4) not null default 0,
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  decided_at    timestamptz,
  posted_at     timestamptz,
  version       integer not null default 1
);
create table procurement.purchase_return_items (
  id             uuid primary key default public.uuid_v7(),
  return_id      uuid not null references procurement.purchase_returns (id) on delete restrict,
  product_id     uuid not null references catalog.products (id) on delete restrict,
  batch_id       uuid not null references inventory.stock_batches (id) on delete restrict,
  location_id    uuid references org.storage_locations (id) on delete restrict,
  status         text not null check (status in ('quarantined', 'damaged')),
  quantity       numeric(18, 4) not null check (quantity > 0),
  unit_cost      numeric(18, 4) not null,
  credit_amount  numeric(18, 4) not null
);
create index ix_return_items_return on procurement.purchase_return_items (return_id);

create table procurement.supplier_credits (
  id              uuid primary key default public.uuid_v7(),
  supplier_id     uuid not null references procurement.suppliers (id) on delete restrict,
  return_id       uuid unique references procurement.purchase_returns (id) on delete restrict,
  amount          numeric(18, 4) not null check (amount > 0),
  applied_amount  numeric(18, 4) not null default 0 check (applied_amount >= 0),
  created_at      timestamptz not null default now(),
  check (applied_amount <= amount)
);
create table procurement.supplier_credit_applications (
  id          uuid primary key default public.uuid_v7(),
  credit_id   uuid not null references procurement.supplier_credits (id) on delete restrict,
  invoice_id  uuid not null references procurement.supplier_invoices (id) on delete restrict,
  amount      numeric(18, 4) not null check (amount > 0),
  applied_by  uuid not null references iam.users (id) on delete restrict,
  applied_at  timestamptz not null default now()
);
