-- Tax categories and effective-dated tax rules (country-specific values are data, not code)
create table finance.tax_categories (
  id           uuid primary key default public.uuid_v7(),
  name         citext not null unique,
  description  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  version      integer not null default 1
);
create trigger trg_tax_categories_touch before update on finance.tax_categories for each row execute function public.touch_row();

create table finance.tax_rules (
  id               uuid primary key default public.uuid_v7(),
  tax_category_id  uuid not null references finance.tax_categories (id) on delete restrict,
  tax_code         text not null check (tax_code ~ '^[A-Z0-9_-]{1,20}$'),
  name             text not null,
  rate             numeric(7, 4) not null check (rate >= 0 and rate <= 100),
  is_inclusive     boolean not null default false,
  rounding_rule    text not null default 'half_up' check (rounding_rule in ('half_up', 'half_even', 'down', 'up')),
  effective_from   date not null,
  effective_to     date,
  country_pack     text not null default 'ET',
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  version          integer not null default 1,
  check (effective_to is null or effective_to >= effective_from),
  -- one category cannot have two rules in force on the same day
  constraint ex_tax_rules_no_overlap exclude using gist (
    tax_category_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  )
);
create trigger trg_tax_rules_touch before update on finance.tax_rules for each row execute function public.touch_row();
