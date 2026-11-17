-- Bulk product import jobs and bulk price update batches
create table catalog.import_jobs (
  id            uuid primary key default public.uuid_v7(),
  file_name     text not null,
  status        text not null default 'previewed' check (status in ('previewed', 'committed', 'cancelled')),
  row_count     integer not null,
  summary       jsonb not null default '{}',
  rows          jsonb not null,           -- the parsed rows exactly as uploaded
  auto_create   boolean not null default false,
  created_by    uuid not null references iam.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  committed_by  uuid references iam.users (id) on delete restrict,
  committed_at  timestamptz
);

create table catalog.price_update_batches (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  price_type    text not null check (price_type in ('purchase', 'selling', 'wholesale')),
  mode          text not null check (mode in ('set', 'percent', 'amount')),
  value         numeric(18, 4) not null,
  reason        text not null check (length(trim(reason)) >= 3),
  status        text not null default 'draft' check (status in ('draft', 'pending', 'applied', 'rejected', 'cancelled')),
  item_count    integer not null default 0,
  created_by    uuid not null references iam.users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict,
  decided_at    timestamptz,
  applied_at    timestamptz
);

create table catalog.price_update_items (
  id          uuid primary key default public.uuid_v7(),
  batch_id    uuid not null references catalog.price_update_batches (id) on delete restrict,
  product_id  uuid not null references catalog.products (id) on delete restrict,
  unit_id     uuid not null references catalog.units (id) on delete restrict,
  old_amount  numeric(18, 4),
  new_amount  numeric(18, 4) not null check (new_amount >= 0),
  warning     text
);
create index ix_price_update_items_batch on catalog.price_update_items (batch_id);
