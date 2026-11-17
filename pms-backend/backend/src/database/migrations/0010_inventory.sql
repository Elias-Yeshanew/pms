-- Inventory core: batches, balances, the movement ledger, adjustments, disposals; generic approvals
create schema if not exists inventory;

create table inventory.stock_batches (
  id                     uuid primary key default public.uuid_v7(),
  product_id             uuid not null references catalog.products (id) on delete restrict,
  batch_ref              text not null check (length(trim(batch_ref)) > 0),
  expiry_date            date not null,
  manufacture_date       date,
  unit_cost              numeric(18, 4) not null check (unit_cost >= 0),   -- cost per BASE unit
  supplier_id            uuid references procurement.suppliers (id) on delete restrict,
  goods_receipt_item_id  uuid,                                              -- foreign key added with procurement
  created_at             timestamptz not null default now(),
  created_by             uuid,
  check (manufacture_date is null or manufacture_date <= expiry_date),
  -- the same lot received again at the same cost is the same batch; a different cost is a separate batch
  constraint uq_stock_batch unique nulls not distinct (product_id, batch_ref, supplier_id, unit_cost)
);
create index ix_batches_product_expiry on inventory.stock_batches (product_id, expiry_date);

create table inventory.stock_balances (
  id                 uuid primary key default public.uuid_v7(),
  branch_id          uuid not null references org.branches (id) on delete restrict,
  warehouse_id       uuid not null references org.warehouses (id) on delete restrict,
  location_id        uuid references org.storage_locations (id) on delete restrict,
  batch_id           uuid not null references inventory.stock_batches (id) on delete restrict,
  product_id         uuid not null references catalog.products (id) on delete restrict,
  status             text not null check (status in ('available', 'quarantined', 'damaged', 'expired')),
  quantity           numeric(18, 4) not null default 0,    -- base units; may only go below 0 under an explicit policy
  reserved_quantity  numeric(18, 4) not null default 0 check (reserved_quantity >= 0),
  updated_at         timestamptz not null default now(),
  constraint uq_stock_balance unique nulls not distinct (warehouse_id, location_id, batch_id, status)
);
create index ix_balances_branch_product on inventory.stock_balances (branch_id, product_id, status);
create index ix_balances_batch on inventory.stock_balances (batch_id);

-- Quantities may only be changed by the ledger, never by a direct UPDATE, INSERT or DELETE
create or replace function inventory.guard_balances() returns trigger as $$
begin
  if coalesce(current_setting('pms.ledger_post', true), '') <> 'on' then
    raise exception 'Stock balances can only change through a stock movement' using errcode = 'integrity_constraint_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;
create trigger trg_balances_guard before insert or update or delete on inventory.stock_balances
  for each row execute function inventory.guard_balances();

create table inventory.stock_movements (
  id              uuid primary key default public.uuid_v7(),
  reference_no    text not null,
  movement_type   text not null check (movement_type in (
                    'opening_balance', 'receipt', 'sale', 'sale_return', 'adjustment', 'count_adjustment', 'transfer_out', 'transfer_in',
                    'quarantine', 'release', 'damage', 'expiry', 'disposal', 'purchase_return', 'correction')),
  branch_id       uuid not null references org.branches (id) on delete restrict,
  warehouse_id    uuid not null references org.warehouses (id) on delete restrict,
  location_id     uuid references org.storage_locations (id) on delete restrict,
  batch_id        uuid not null references inventory.stock_batches (id) on delete restrict,
  product_id      uuid not null references catalog.products (id) on delete restrict,
  status          text not null check (status in ('available', 'quarantined', 'damaged', 'expired')),
  quantity_delta  numeric(18, 4) not null check (quantity_delta <> 0),
  unit_cost       numeric(18, 4) not null,
  balance_after   numeric(18, 4) not null,
  source_type     text not null,
  source_id       uuid,
  reason          text,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index ix_movements_batch on inventory.stock_movements (batch_id, created_at);
create index ix_movements_branch on inventory.stock_movements (branch_id, created_at);
create index ix_movements_product on inventory.stock_movements (product_id, created_at);
create index ix_movements_source on inventory.stock_movements (source_type, source_id);
create index ix_movements_reference on inventory.stock_movements (reference_no);
create trigger trg_movements_append_only before update or delete on inventory.stock_movements
  for each row execute function public.forbid_mutation();

-- Generic approvals (four-eyes): the person who asks can never be the person who approves
create table platform.approval_requests (
  id                   uuid primary key default public.uuid_v7(),
  action_code          text not null,
  source_type          text not null,
  source_id            uuid not null,
  branch_id            uuid references org.branches (id) on delete restrict,
  required_permission  text not null,
  summary              jsonb not null default '{}',
  status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by         uuid not null references iam.users (id) on delete restrict,
  requested_at         timestamptz not null default now(),
  decided_by           uuid references iam.users (id) on delete restrict,
  decided_at           timestamptz,
  comment              text,
  check (decided_by is null or status = 'cancelled' or decided_by <> requested_by)
);
create unique index uq_approval_pending_source on platform.approval_requests (source_type, source_id) where status = 'pending';
create index ix_approvals_status on platform.approval_requests (status, requested_at desc);

create table inventory.stock_adjustments (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  branch_id     uuid not null references org.branches (id) on delete restrict,
  warehouse_id  uuid not null references org.warehouses (id) on delete restrict,
  reason_code   text not null check (reason_code in ('opening_balance', 'count_correction', 'loss', 'found', 'data_entry_error', 'other')),
  reason        text not null check (length(trim(reason)) >= 3),
  status        text not null default 'pending' check (status in ('pending', 'posted', 'rejected', 'cancelled')),
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  decided_at    timestamptz,
  posted_at     timestamptz,
  version       integer not null default 1
);
create index ix_adjustments_branch on inventory.stock_adjustments (branch_id, requested_at desc);

create table inventory.stock_adjustment_items (
  id              uuid primary key default public.uuid_v7(),
  adjustment_id   uuid not null references inventory.stock_adjustments (id) on delete restrict,
  product_id      uuid not null references catalog.products (id) on delete restrict,
  batch_id        uuid references inventory.stock_batches (id) on delete restrict,
  new_batch       jsonb,
  location_id     uuid references org.storage_locations (id) on delete restrict,
  quantity_delta  numeric(18, 4) not null check (quantity_delta <> 0),
  note            text,
  check ((batch_id is not null) <> (new_batch is not null))
);
create index ix_adjustment_items_adj on inventory.stock_adjustment_items (adjustment_id);

create table inventory.stock_disposals (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  branch_id     uuid not null references org.branches (id) on delete restrict,
  warehouse_id  uuid not null references org.warehouses (id) on delete restrict,
  reason        text not null check (reason in ('expired', 'damaged', 'returned', 'other')),
  note          text,
  status        text not null default 'pending' check (status in ('pending', 'posted', 'rejected', 'cancelled')),
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  decided_at    timestamptz,
  posted_at     timestamptz,
  version       integer not null default 1
);

create table inventory.stock_disposal_items (
  id           uuid primary key default public.uuid_v7(),
  disposal_id  uuid not null references inventory.stock_disposals (id) on delete restrict,
  product_id   uuid not null references catalog.products (id) on delete restrict,
  batch_id     uuid not null references inventory.stock_batches (id) on delete restrict,
  location_id  uuid references org.storage_locations (id) on delete restrict,
  status       text not null check (status in ('quarantined', 'damaged', 'expired')),
  quantity     numeric(18, 4) not null check (quantity > 0)
);
create index ix_disposal_items_disposal on inventory.stock_disposal_items (disposal_id);
