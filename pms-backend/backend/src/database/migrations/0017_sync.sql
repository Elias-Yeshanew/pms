-- Offline sync: registered devices, a change feed for reference data, and offline sales that could not be accepted.
create schema if not exists sync;

create table sync.devices (
  id            uuid primary key default public.uuid_v7(),
  branch_id     uuid not null references org.branches (id) on delete restrict,
  register_id   uuid references org.cash_registers (id) on delete restrict,
  name          text not null check (length(trim(name)) > 0),
  platform      text,
  status        text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at  timestamptz,
  last_sync_at  timestamptz,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  revoked_at    timestamptz,
  revoked_by    uuid
);
create index ix_devices_branch on sync.devices (branch_id);

-- Every change to data a register keeps a copy of. seq only ever grows; a device remembers the last one it saw.
create table sync.change_log (
  seq         bigint generated always as identity primary key,
  entity      text not null,
  entity_id   uuid not null,
  op          text not null check (op in ('upsert', 'delete')),
  changed_at  timestamptz not null default clock_timestamp()
);
create index ix_change_log_entity on sync.change_log (entity, entity_id);

create or replace function sync.log_change() returns trigger as $$
declare v_entity text := tg_argv[0]; v_id uuid;
begin
  if tg_op = 'DELETE' then v_id := old.id; else v_id := new.id; end if;
  insert into sync.change_log (entity, entity_id, op) values (v_entity, v_id, case when tg_op = 'DELETE' then 'delete' else 'upsert' end);
  return null;
end $$ language plpgsql;

create trigger trg_sync_products   after insert or update or delete on catalog.products         for each row execute function sync.log_change('product');
create trigger trg_sync_units      after insert or update or delete on catalog.units            for each row execute function sync.log_change('unit');
create trigger trg_sync_pu         after insert or update or delete on catalog.product_units    for each row execute function sync.log_change('product_unit');
create trigger trg_sync_barcodes   after insert or update or delete on catalog.product_barcodes for each row execute function sync.log_change('barcode');
create trigger trg_sync_prices     after insert or update or delete on catalog.product_prices   for each row execute function sync.log_change('price');
create trigger trg_sync_taxrules   after insert or update or delete on finance.tax_rules        for each row execute function sync.log_change('tax_rule');
create trigger trg_sync_taxcats    after insert or update or delete on finance.tax_categories   for each row execute function sync.log_change('tax_category');
create trigger trg_sync_methods    after insert or update or delete on sales.payment_methods    for each row execute function sync.log_change('payment_method');
create trigger trg_sync_customers  after insert or update or delete on sales.customers          for each row execute function sync.log_change('customer');
create trigger trg_sync_registers  after insert or update or delete on org.cash_registers       for each row execute function sync.log_change('register');

-- Offline sales the server refused (no stock, expired, too old...). Kept whole so a manager can fix the cause and retry.
create table sync.conflicts (
  id             uuid primary key default public.uuid_v7(),
  device_id      uuid not null references sync.devices (id) on delete restrict,
  branch_id      uuid not null references org.branches (id) on delete restrict,
  offline_ref    text not null,
  payload        jsonb not null,
  error_code     text not null,
  error_message  text not null,
  error_details  jsonb,
  cashier_id     uuid not null,
  status         text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  sale_id        uuid,
  resolution_note text,
  resolved_by    uuid,
  resolved_at    timestamptz,
  attempts       int not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (device_id, offline_ref)
);
create index ix_conflicts_open on sync.conflicts (branch_id) where status = 'open';
