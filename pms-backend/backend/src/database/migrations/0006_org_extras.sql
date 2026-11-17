-- Warehouses, storage locations, cash registers
create table org.warehouses (
  id          uuid primary key default public.uuid_v7(),
  branch_id   uuid not null references org.branches (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9_-]{1,20}$'),
  name        text not null check (length(trim(name)) > 0),
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1,
  unique (branch_id, code)
);
create trigger trg_warehouses_touch before update on org.warehouses for each row execute function public.touch_row();

create table org.storage_locations (
  id                uuid primary key default public.uuid_v7(),
  warehouse_id      uuid not null references org.warehouses (id) on delete restrict,
  code              text not null check (code ~ '^[A-Z0-9_-]{1,20}$'),
  name              text not null check (length(trim(name)) > 0),
  temperature_zone  text not null default 'ambient' check (temperature_zone in ('ambient', 'cool', 'cold', 'frozen')),
  status            text not null default 'active' check (status in ('active', 'inactive')),
  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),
  updated_by        uuid,
  version           integer not null default 1,
  unique (warehouse_id, code)
);
create trigger trg_locations_touch before update on org.storage_locations for each row execute function public.touch_row();

create table org.cash_registers (
  id            uuid primary key default public.uuid_v7(),
  branch_id     uuid not null references org.branches (id) on delete restrict,
  code          text not null check (code ~ '^[A-Z0-9_-]{1,20}$'),
  name          text not null check (length(trim(name)) > 0),
  status        text not null default 'active' check (status in ('active', 'inactive')),
  offline_mode  text not null default 'online_only' check (offline_mode in ('online_only', 'offline_capable', 'hybrid')),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  version       integer not null default 1,
  unique (branch_id, code)
);
create trigger trg_registers_touch before update on org.cash_registers for each row execute function public.touch_row();
