-- Stock transfers (request, approve, dispatch, receive, discrepancies) and physical counts
create table inventory.stock_transfers (
  id                 uuid primary key default public.uuid_v7(),
  reference_no       text not null unique,
  from_branch_id     uuid not null references org.branches (id) on delete restrict,
  to_branch_id       uuid not null references org.branches (id) on delete restrict,
  from_warehouse_id  uuid not null references org.warehouses (id) on delete restrict,
  to_warehouse_id    uuid not null references org.warehouses (id) on delete restrict,
  status             text not null default 'pending_approval' check (status in
                       ('pending_approval', 'approved', 'dispatched', 'received', 'received_with_discrepancy', 'closed', 'rejected', 'cancelled')),
  note               text,
  requested_by       uuid not null references iam.users (id) on delete restrict,
  requested_at       timestamptz not null default now(),
  approved_by        uuid references iam.users (id) on delete restrict,
  approved_at        timestamptz,
  dispatched_by      uuid references iam.users (id) on delete restrict,
  dispatched_at      timestamptz,
  received_by        uuid references iam.users (id) on delete restrict,
  received_at        timestamptz,
  resolved_by        uuid references iam.users (id) on delete restrict,
  resolved_at        timestamptz,
  resolution_note    text,
  version            integer not null default 1,
  check (from_warehouse_id <> to_warehouse_id)
);
create index ix_transfers_from on inventory.stock_transfers (from_branch_id, requested_at desc);
create index ix_transfers_to on inventory.stock_transfers (to_branch_id, requested_at desc);
create index ix_transfers_status on inventory.stock_transfers (status);

create table inventory.stock_transfer_items (
  id                    uuid primary key default public.uuid_v7(),
  transfer_id           uuid not null references inventory.stock_transfers (id) on delete restrict,
  product_id            uuid not null references catalog.products (id) on delete restrict,
  batch_id              uuid not null references inventory.stock_batches (id) on delete restrict,
  from_location_id      uuid references org.storage_locations (id) on delete restrict,
  to_location_id        uuid references org.storage_locations (id) on delete restrict,
  quantity_requested    numeric(18, 4) not null check (quantity_requested > 0),
  quantity_sent         numeric(18, 4) check (quantity_sent >= 0),
  quantity_received     numeric(18, 4) check (quantity_received >= 0),
  received_status       text check (received_status in ('available', 'quarantined', 'damaged')),
  discrepancy_reason    text,
  check (quantity_sent is null or quantity_sent <= quantity_requested),
  check (quantity_received is null or quantity_sent is null or quantity_received <= quantity_sent)
);
create index ix_transfer_items_transfer on inventory.stock_transfer_items (transfer_id);

create table inventory.stock_counts (
  id              uuid primary key default public.uuid_v7(),
  reference_no    text not null unique,
  branch_id       uuid not null references org.branches (id) on delete restrict,
  warehouse_id    uuid not null references org.warehouses (id) on delete restrict,
  location_id     uuid references org.storage_locations (id) on delete restrict,
  status          text not null default 'counting' check (status in ('counting', 'submitted', 'posted', 'cancelled')),
  note            text,
  review_comment  text,
  created_by      uuid not null references iam.users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  submitted_by    uuid references iam.users (id) on delete restrict,
  submitted_at    timestamptz,
  decided_by      uuid references iam.users (id) on delete restrict,
  posted_at       timestamptz,
  version         integer not null default 1
);
-- only one open count per warehouse at a time
create unique index uq_open_count_per_warehouse on inventory.stock_counts (warehouse_id) where status in ('counting', 'submitted');

create table inventory.stock_count_items (
  id                uuid primary key default public.uuid_v7(),
  count_id          uuid not null references inventory.stock_counts (id) on delete restrict,
  product_id        uuid not null references catalog.products (id) on delete restrict,
  batch_id          uuid not null references inventory.stock_batches (id) on delete restrict,
  location_id       uuid references org.storage_locations (id) on delete restrict,
  system_quantity   numeric(18, 4) not null,
  counted_quantity  numeric(18, 4) check (counted_quantity >= 0),
  variance          numeric(18, 4)
);
create index ix_count_items_count on inventory.stock_count_items (count_id);
