create table procurement.suppliers (
  id                  uuid primary key default public.uuid_v7(),
  code                text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name                text not null check (length(trim(name)) > 0),
  contact_person      text,
  phone               text,
  email               citext,
  address             text,
  tax_id              text,
  registration_no     text,
  payment_terms_days  integer not null default 0 check (payment_terms_days between 0 and 365),
  credit_limit        numeric(18, 4) not null default 0 check (credit_limit >= 0),
  bank_details        text,
  status              text not null default 'active' check (status in ('active', 'inactive', 'blocked')),
  rating              numeric(3, 2) check (rating between 0 and 5),
  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  version             integer not null default 1
);
create index ix_suppliers_name_trgm on procurement.suppliers using gin (name gin_trgm_ops);
create trigger trg_suppliers_touch before update on procurement.suppliers for each row execute function public.touch_row();

create table catalog.product_suppliers (
  id            uuid primary key default public.uuid_v7(),
  product_id    uuid not null references catalog.products (id) on delete restrict,
  supplier_id   uuid not null references procurement.suppliers (id) on delete restrict,
  supplier_sku  text,
  last_price    numeric(18, 4) check (last_price >= 0),
  created_at    timestamptz not null default now(),
  unique (product_id, supplier_id)
);
