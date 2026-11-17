-- Sales, point of sale, customers, prescriptions
create schema if not exists sales;

create table sales.payment_methods (
  id                  uuid primary key default public.uuid_v7(),
  code                text not null unique check (code ~ '^[a-z0-9_]{2,30}$'),
  name                text not null,
  is_cash             boolean not null default false,
  is_credit           boolean not null default false,   -- "on account": the customer owes the pharmacy
  requires_reference  boolean not null default false,
  is_active           boolean not null default true,
  sort_order          integer not null default 100,
  version             integer not null default 1,
  updated_by          uuid
);

create table sales.customers (
  id            uuid primary key default public.uuid_v7(),
  code          text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name          text not null check (length(trim(name)) > 0),
  phone         text,
  email         citext,
  address       text,
  notes         text,
  credit_limit  numeric(18, 4) not null default 0 check (credit_limit >= 0),   -- 0 means no credit sales
  balance       numeric(18, 4) not null default 0,                              -- what the customer owes; negative means prepaid
  status        text not null default 'active' check (status in ('active', 'inactive')),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  version       integer not null default 1
);
create index ix_customers_name_trgm on sales.customers using gin (name gin_trgm_ops);
create index ix_customers_phone on sales.customers (phone);
create trigger trg_customers_touch before update on sales.customers for each row execute function public.touch_row();

-- Every change to a customer's balance is a row here. The balance column is only ever changed together with a row.
create table sales.customer_ledger (
  id             uuid primary key default public.uuid_v7(),
  customer_id    uuid not null references sales.customers (id) on delete restrict,
  entry_type     text not null check (entry_type in ('credit_sale', 'payment', 'payment_reversal', 'return_credit', 'cancel_credit', 'adjustment')),
  amount         numeric(18, 4) not null check (amount <> 0),   -- positive: customer owes more
  balance_after  numeric(18, 4) not null,
  branch_id      uuid references org.branches (id) on delete restrict,
  source_type    text not null,
  source_id      uuid,
  reference_no   text,
  note           text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index ix_customer_ledger_customer on sales.customer_ledger (customer_id, created_at);
create trigger trg_customer_ledger_append_only before update or delete on sales.customer_ledger for each row execute function public.forbid_mutation();

create table sales.customer_payments (
  id               uuid primary key default public.uuid_v7(),
  reference_no     text not null unique,
  customer_id      uuid not null references sales.customers (id) on delete restrict,
  branch_id        uuid not null references org.branches (id) on delete restrict,
  register_id      uuid references org.cash_registers (id) on delete restrict,
  method_id        uuid not null references sales.payment_methods (id) on delete restrict,
  amount           numeric(18, 4) not null check (amount > 0),
  reference        text,
  status           text not null default 'posted' check (status in ('posted', 'reversed')),
  received_by      uuid not null references iam.users (id) on delete restrict,
  received_at      timestamptz not null default now(),
  reversed_by      uuid references iam.users (id) on delete restrict,
  reversed_at      timestamptz,
  reversal_reason  text
);

create table sales.prescriptions (
  id                    uuid primary key default public.uuid_v7(),
  reference_no          text not null unique,
  branch_id             uuid not null references org.branches (id) on delete restrict,
  customer_id           uuid references sales.customers (id) on delete restrict,
  patient_name          text not null check (length(trim(patient_name)) > 0),
  patient_birth_date    date,
  patient_phone         text,
  prescriber_name       text not null check (length(trim(prescriber_name)) > 0),
  prescriber_license_no text,
  facility              text,
  prescribed_date       date not null,
  notes                 text,
  status                text not null default 'pending_validation' check (status in ('pending_validation', 'valid', 'rejected', 'fulfilled', 'cancelled')),
  validated_by          uuid references iam.users (id) on delete restrict,
  validated_at          timestamptz,
  rejection_reason      text,
  attachment_path       text,
  attachment_mime       text,
  created_by            uuid not null references iam.users (id) on delete restrict,
  created_at            timestamptz not null default now(),
  version               integer not null default 1
);
create index ix_prescriptions_branch on sales.prescriptions (branch_id, created_at desc);
create index ix_prescriptions_customer on sales.prescriptions (customer_id);
create table sales.prescription_items (
  id                    uuid primary key default public.uuid_v7(),
  prescription_id       uuid not null references sales.prescriptions (id) on delete restrict,
  product_id            uuid not null references catalog.products (id) on delete restrict,
  dosage                text,
  frequency             text,
  duration              text,
  quantity_prescribed   numeric(18, 4) not null check (quantity_prescribed > 0),   -- base units
  quantity_dispensed    numeric(18, 4) not null default 0 check (quantity_dispensed >= 0),
  notes                 text,
  check (quantity_dispensed <= quantity_prescribed)
);
create index ix_rx_items_rx on sales.prescription_items (prescription_id);

create table sales.discount_requests (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  branch_id     uuid not null references org.branches (id) on delete restrict,
  register_id   uuid references org.cash_registers (id) on delete restrict,
  percent       numeric(7, 4) not null check (percent > 0 and percent <= 100),
  reason        text not null check (length(trim(reason)) >= 3),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used', 'cancelled')),
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  approved_at   timestamptz,
  sale_id       uuid
);

create table sales.sales (
  id                uuid primary key default public.uuid_v7(),
  reference_no      text not null unique,
  branch_id         uuid not null references org.branches (id) on delete restrict,
  register_id       uuid not null references org.cash_registers (id) on delete restrict,
  customer_id       uuid references sales.customers (id) on delete restrict,
  prescription_id   uuid references sales.prescriptions (id) on delete restrict,
  cashier_id        uuid not null references iam.users (id) on delete restrict,
  status            text not null default 'completed' check (status in ('completed', 'partially_returned', 'returned', 'cancelled')),
  subtotal          numeric(18, 4) not null,      -- net of tax, after discounts
  discount_total    numeric(18, 4) not null default 0,
  tax_total         numeric(18, 4) not null,
  total             numeric(18, 4) not null check (total >= 0),
  paid_total        numeric(18, 4) not null,      -- received now (cash and electronic)
  credit_total      numeric(18, 4) not null default 0,   -- put on the customer's account
  credit_returned   numeric(18, 4) not null default 0,
  change_given      numeric(18, 4) not null default 0,
  cogs_total        numeric(18, 4) not null,
  max_discount_percent numeric(7, 4) not null default 0,
  discount_request_id uuid references sales.discount_requests (id) on delete restrict,
  idempotency_key   text not null,
  request_hash      text not null,
  device_id         uuid,
  offline_ref       text,
  einvoice_status   text not null default 'not_required',
  sold_at           timestamptz not null default clock_timestamp(),
  synced_at         timestamptz,
  cancelled_at      timestamptz,
  cancelled_by      uuid references iam.users (id) on delete restrict,
  cancel_reason     text,
  version           integer not null default 1,
  constraint uq_sales_idempotency unique (idempotency_key),
  check (paid_total + credit_total = total)
);
create index ix_sales_branch on sales.sales (branch_id, sold_at desc);
create index ix_sales_cashier on sales.sales (cashier_id, sold_at desc);
create index ix_sales_customer on sales.sales (customer_id);
alter table sales.discount_requests add constraint fk_discount_sale foreign key (sale_id) references sales.sales (id) on delete restrict;

create table sales.sale_items (
  id                    uuid primary key default public.uuid_v7(),
  sale_id               uuid not null references sales.sales (id) on delete restrict,
  line_no               integer not null,
  product_id            uuid not null references catalog.products (id) on delete restrict,
  unit_id               uuid not null references catalog.units (id) on delete restrict,
  quantity              numeric(18, 4) not null check (quantity > 0),
  base_quantity         numeric(18, 4) not null check (base_quantity > 0),
  unit_price            numeric(18, 4) not null check (unit_price >= 0),
  line_gross            numeric(18, 4) not null,
  discount_percent      numeric(7, 4) not null default 0,
  discount_amount       numeric(18, 4) not null default 0,
  line_net              numeric(18, 4) not null,
  tax_rate              numeric(7, 4) not null default 0,
  tax_amount            numeric(18, 4) not null,
  line_total            numeric(18, 4) not null,
  cost_total            numeric(18, 4) not null,
  prescription_item_id  uuid references sales.prescription_items (id) on delete restrict,
  returned_base         numeric(18, 4) not null default 0 check (returned_base >= 0),
  unique (sale_id, line_no)
);
create index ix_sale_items_sale on sales.sale_items (sale_id);
create index ix_sale_items_product on sales.sale_items (product_id);

create table sales.sale_item_allocations (
  id             uuid primary key default public.uuid_v7(),
  sale_item_id   uuid not null references sales.sale_items (id) on delete restrict,
  batch_id       uuid not null references inventory.stock_batches (id) on delete restrict,
  warehouse_id   uuid not null references org.warehouses (id) on delete restrict,
  location_id    uuid references org.storage_locations (id) on delete restrict,
  base_quantity  numeric(18, 4) not null check (base_quantity > 0),
  unit_cost      numeric(18, 4) not null,
  returned_base  numeric(18, 4) not null default 0 check (returned_base >= 0 and returned_base <= base_quantity)
);
create index ix_allocations_item on sales.sale_item_allocations (sale_item_id);
create index ix_allocations_batch on sales.sale_item_allocations (batch_id);

create table sales.sale_payments (
  id            uuid primary key default public.uuid_v7(),
  sale_id       uuid not null references sales.sales (id) on delete restrict,
  method_id     uuid not null references sales.payment_methods (id) on delete restrict,
  amount        numeric(18, 4) not null check (amount > 0),
  tendered      numeric(18, 4),
  change_given  numeric(18, 4) not null default 0,
  reference     text,
  received_at   timestamptz not null default now()
);
create index ix_sale_payments_sale on sales.sale_payments (sale_id);

create table sales.sale_refunds (
  id           uuid primary key default public.uuid_v7(),
  sale_id      uuid not null references sales.sales (id) on delete restrict,
  return_id    uuid,
  kind         text not null check (kind in ('return', 'cancellation')),
  method_id    uuid references sales.payment_methods (id) on delete restrict,
  amount       numeric(18, 4) not null check (amount > 0),
  to_account   boolean not null default false,      -- true: reduced what the customer owes instead of paying out
  reference    text,
  created_by   uuid references iam.users (id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index ix_sale_refunds_sale on sales.sale_refunds (sale_id);
create trigger trg_sale_refunds_append_only before update or delete on sales.sale_refunds for each row execute function public.forbid_mutation();

create table sales.sales_returns (
  id             uuid primary key default public.uuid_v7(),
  reference_no   text not null unique,
  sale_id        uuid not null references sales.sales (id) on delete restrict,
  branch_id      uuid not null references org.branches (id) on delete restrict,
  status         text not null default 'pending_approval' check (status in ('pending_approval', 'posted', 'rejected', 'cancelled')),
  reason         text not null check (length(trim(reason)) >= 3),
  refund_method_id uuid references sales.payment_methods (id) on delete restrict,
  refund_reference text,
  refund_total   numeric(18, 4) not null default 0,
  requested_by   uuid not null references iam.users (id) on delete restrict,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references iam.users (id) on delete restrict,
  posted_at      timestamptz,
  version        integer not null default 1
);
alter table sales.sale_refunds add constraint fk_refund_return foreign key (return_id) references sales.sales_returns (id) on delete restrict;
create table sales.sales_return_items (
  id             uuid primary key default public.uuid_v7(),
  return_id      uuid not null references sales.sales_returns (id) on delete restrict,
  sale_item_id   uuid not null references sales.sale_items (id) on delete restrict,
  product_id     uuid not null references catalog.products (id) on delete restrict,
  quantity       numeric(18, 4) not null check (quantity > 0),
  base_quantity  numeric(18, 4) not null check (base_quantity > 0),
  refund_amount  numeric(18, 4) not null,
  disposition    text not null default 'pending' check (disposition in ('pending', 'resale', 'damaged')),
  inspected_by   uuid references iam.users (id) on delete restrict,
  inspected_at   timestamptz,
  note           text
);
create table sales.sales_return_allocations (
  id              uuid primary key default public.uuid_v7(),
  return_item_id  uuid not null references sales.sales_return_items (id) on delete restrict,
  allocation_id   uuid not null references sales.sale_item_allocations (id) on delete restrict,
  batch_id        uuid not null references inventory.stock_batches (id) on delete restrict,
  warehouse_id    uuid not null references org.warehouses (id) on delete restrict,
  location_id     uuid references org.storage_locations (id) on delete restrict,
  base_quantity   numeric(18, 4) not null check (base_quantity > 0)
);
create index ix_return_items_return on sales.sales_return_items (return_id);
