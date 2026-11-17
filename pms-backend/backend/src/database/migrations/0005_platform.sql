-- Platform: settings, document numbering, seed bookkeeping
create extension if not exists btree_gist;
create schema if not exists finance;
create schema if not exists procurement;
create schema if not exists catalog;

-- Remembers which built-in role grants were applied, so later admin removals are never undone by re-seeding
create table platform.seed_grants (
  role_name        citext not null,
  permission_code  text not null,
  applied_at       timestamptz not null default now(),
  primary key (role_name, permission_code)
);

create table platform.settings (
  id          uuid primary key default public.uuid_v7(),
  key         text not null check (key ~ '^[a-z_]+\.[a-z_]+$'),
  branch_id   uuid references org.branches (id) on delete restrict,
  value       jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1,
  constraint uq_settings unique nulls not distinct (key, branch_id)
);
create trigger trg_settings_touch before update on platform.settings
  for each row execute function public.touch_row();

create table platform.settings_history (
  id          uuid primary key default public.uuid_v7(),
  key         text not null,
  branch_id   uuid,
  old_value   jsonb,
  new_value   jsonb not null,
  reason      text,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index ix_settings_history_key on platform.settings_history (key, changed_at desc);
create trigger trg_settings_history_append_only before update or delete on platform.settings_history
  for each row execute function public.forbid_mutation();

-- Reference-number sequences. A branch-specific row overrides the company-wide row for that document type.
create table platform.document_sequences (
  id               uuid primary key default public.uuid_v7(),
  doc_type         text not null check (doc_type ~ '^[a-z_]+$'),
  branch_id        uuid references org.branches (id) on delete restrict,
  prefix           text not null default '' check (prefix ~ '^[A-Z0-9_-]{0,12}$'),
  padding          integer not null default 6 check (padding between 1 and 12),
  reset_rule       text not null default 'never' check (reset_rule in ('never', 'yearly')),
  next_value       bigint not null default 1 check (next_value >= 1),
  last_reset_year  integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  constraint uq_sequence_scope unique nulls not distinct (doc_type, branch_id),
  -- two sequences of the same document type may never produce the same reference
  constraint uq_sequence_prefix unique (doc_type, prefix)
);
create trigger trg_sequences_touch before update on platform.document_sequences
  for each row execute function public.touch_row();
