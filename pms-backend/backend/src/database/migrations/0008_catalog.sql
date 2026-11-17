-- Product master data
create table catalog.units (
  id          uuid primary key default public.uuid_v7(),
  code        text not null unique check (code ~ '^[a-z0-9_]{1,30}$'),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create trigger trg_units_touch before update on catalog.units for each row execute function public.touch_row();

create table catalog.dosage_forms (
  id          uuid primary key default public.uuid_v7(),
  name        citext not null unique,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create trigger trg_dosage_forms_touch before update on catalog.dosage_forms for each row execute function public.touch_row();

create table catalog.categories (
  id          uuid primary key default public.uuid_v7(),
  parent_id   uuid references catalog.categories (id) on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1,
  constraint uq_category_name unique nulls not distinct (parent_id, name),
  check (parent_id <> id)
);
create trigger trg_categories_touch before update on catalog.categories for each row execute function public.touch_row();

create table catalog.manufacturers (
  id          uuid primary key default public.uuid_v7(),
  name        citext not null unique,
  country     text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create trigger trg_manufacturers_touch before update on catalog.manufacturers for each row execute function public.touch_row();

create table catalog.products (
  id                    uuid primary key default public.uuid_v7(),
  sku                   text not null unique check (sku ~ '^[A-Za-z0-9._-]{1,40}$'),
  name                  text not null check (length(trim(name)) > 0),
  generic_name          text,
  brand_name            text,
  category_id           uuid references catalog.categories (id) on delete restrict,
  manufacturer_id       uuid references catalog.manufacturers (id) on delete restrict,
  dosage_form_id        uuid references catalog.dosage_forms (id) on delete restrict,
  strength              text,
  base_unit_id          uuid not null references catalog.units (id) on delete restrict,
  requires_prescription boolean not null default false,
  is_controlled         boolean not null default false,
  registration_no       text,
  description           text,
  image_path            text,
  min_stock             numeric(18, 4) check (min_stock >= 0),
  max_stock             numeric(18, 4) check (max_stock >= 0),
  reorder_level         numeric(18, 4) check (reorder_level >= 0),
  tax_category_id       uuid references finance.tax_categories (id) on delete restrict,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  created_by            uuid,
  updated_at            timestamptz not null default now(),
  updated_by            uuid,
  version               integer not null default 1,
  check (max_stock is null or min_stock is null or max_stock >= min_stock),
  check (reorder_level is null or max_stock is null or reorder_level <= max_stock),
  check (reorder_level is null or min_stock is null or reorder_level >= min_stock)
);
create index ix_products_category on catalog.products (category_id);
create index ix_products_manufacturer on catalog.products (manufacturer_id);
create index ix_products_name_trgm on catalog.products using gin (name gin_trgm_ops);
create index ix_products_generic_trgm on catalog.products using gin (generic_name gin_trgm_ops);
create index ix_products_brand_trgm on catalog.products using gin (brand_name gin_trgm_ops);
create trigger trg_products_touch before update on catalog.products for each row execute function public.touch_row();

-- Every product has its base unit (factor 1) plus any larger packs, e.g. strip = 10, box = 100, carton = 1000 base units
create table catalog.product_units (
  id              uuid primary key default public.uuid_v7(),
  product_id      uuid not null references catalog.products (id) on delete restrict,
  unit_id         uuid not null references catalog.units (id) on delete restrict,
  factor_to_base  numeric(18, 4) not null check (factor_to_base > 0),
  is_sellable     boolean not null default true,
  is_purchasable  boolean not null default true,
  unique (product_id, unit_id)
);

create table catalog.product_barcodes (
  id          uuid primary key default public.uuid_v7(),
  product_id  uuid not null references catalog.products (id) on delete restrict,
  unit_id     uuid not null references catalog.units (id) on delete restrict,
  barcode     text not null unique check (barcode ~ '^[A-Za-z0-9._/-]{4,64}$'),
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  foreign key (product_id, unit_id) references catalog.product_units (product_id, unit_id) on delete restrict
);
create index ix_barcodes_product on catalog.product_barcodes (product_id);
create unique index uq_barcode_primary on catalog.product_barcodes (product_id) where is_primary;

create table catalog.product_prices (
  id              uuid primary key default public.uuid_v7(),
  product_id      uuid not null,
  unit_id         uuid not null,
  price_type      text not null check (price_type in ('purchase', 'selling', 'wholesale')),
  amount          numeric(18, 4) not null check (amount >= 0),
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid,
  foreign key (product_id, unit_id) references catalog.product_units (product_id, unit_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  -- history is kept; only one price per product, unit and type may be in force at any moment
  constraint ex_product_prices_no_overlap exclude using gist (
    product_id with =, unit_id with =, price_type with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  )
);
create index ix_product_prices_lookup on catalog.product_prices (product_id, price_type) where effective_to is null;

create table catalog.price_change_log (
  id          uuid primary key default public.uuid_v7(),
  product_id  uuid not null references catalog.products (id) on delete restrict,
  unit_id     uuid not null references catalog.units (id) on delete restrict,
  price_type  text not null,
  old_amount  numeric(18, 4),
  new_amount  numeric(18, 4) not null,
  reason      text not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index ix_price_log_product on catalog.price_change_log (product_id, changed_at desc);
create trigger trg_price_log_append_only before update or delete on catalog.price_change_log
  for each row execute function public.forbid_mutation();
