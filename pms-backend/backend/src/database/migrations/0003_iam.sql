-- Identity and access management
create table iam.users (
  id                    uuid primary key default public.uuid_v7(),
  employee_id           uuid unique references org.employees (id) on delete restrict,
  username              citext not null unique check (username ~ '^[A-Za-z0-9._-]{3,50}$'),
  email                 citext unique,
  password_hash         text not null,
  status                text not null default 'active' check (status in ('active', 'inactive')),
  must_change_password  boolean not null default false,
  two_factor_enabled    boolean not null default false,
  failed_login_count    integer not null default 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz,
  last_login_at         timestamptz,
  deactivated_at        timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid,
  updated_at            timestamptz not null default now(),
  updated_by            uuid,
  version               integer not null default 1
);
create trigger trg_users_touch before update on iam.users
  for each row execute function public.touch_row();

create table iam.roles (
  id           uuid primary key default public.uuid_v7(),
  name         citext not null unique,
  description  text,
  is_system    boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  version      integer not null default 1
);
create trigger trg_roles_touch before update on iam.roles
  for each row execute function public.touch_row();

create table iam.permissions (
  id           uuid primary key default public.uuid_v7(),
  code         text not null unique check (code ~ '^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$'),
  module       text not null,
  action       text not null,
  description  text
);

create table iam.role_permissions (
  role_id        uuid not null references iam.roles (id) on delete cascade,
  permission_id  uuid not null references iam.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

-- A role can be granted company-wide (branch_id null) or for one branch
create table iam.user_roles (
  id         uuid primary key default public.uuid_v7(),
  user_id    uuid not null references iam.users (id) on delete restrict,
  role_id    uuid not null references iam.roles (id) on delete restrict,
  branch_id  uuid references org.branches (id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint uq_user_roles unique nulls not distinct (user_id, role_id, branch_id)
);
create index ix_user_roles_user on iam.user_roles (user_id);

create table iam.user_permission_overrides (
  id             uuid primary key default public.uuid_v7(),
  user_id        uuid not null references iam.users (id) on delete restrict,
  permission_id  uuid not null references iam.permissions (id) on delete restrict,
  effect         text not null check (effect in ('allow', 'deny')),
  branch_id      uuid references org.branches (id) on delete restrict,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  constraint uq_user_permission_overrides unique nulls not distinct (user_id, permission_id, branch_id)
);
create index ix_user_overrides_user on iam.user_permission_overrides (user_id);

-- Branches a user is assigned to work in (used for sign-in branch selection)
create table iam.user_branch_access (
  user_id    uuid not null references iam.users (id) on delete restrict,
  branch_id  uuid not null references org.branches (id) on delete restrict,
  primary key (user_id, branch_id)
);

create table iam.sessions (
  id                          uuid primary key default public.uuid_v7(),
  user_id                     uuid not null references iam.users (id) on delete restrict,
  refresh_token_hash          text not null unique,
  previous_refresh_token_hash text,
  device_label                text,
  ip_address                  text,
  user_agent                  text,
  created_at                  timestamptz not null default now(),
  last_used_at                timestamptz not null default now(),
  expires_at                  timestamptz not null,
  revoked_at                  timestamptz,
  revoked_reason              text
);
create index ix_sessions_user on iam.sessions (user_id) where revoked_at is null;
create index ix_sessions_previous_hash on iam.sessions (previous_refresh_token_hash) where previous_refresh_token_hash is not null;

create table iam.login_history (
  id                 uuid primary key default public.uuid_v7(),
  user_id            uuid references iam.users (id) on delete restrict,
  username_attempted text not null,
  attempted_at       timestamptz not null default now(),
  ip_address         text,
  user_agent         text,
  success            boolean not null,
  failure_reason     text,
  session_id         uuid
);
create index ix_login_history_user on iam.login_history (user_id, attempted_at desc);
create index ix_login_history_attempted on iam.login_history (attempted_at desc);
create trigger trg_login_history_no_update before update or delete on iam.login_history
  for each row execute function public.forbid_mutation();

create table iam.password_reset_tokens (
  id          uuid primary key default public.uuid_v7(),
  user_id     uuid not null references iam.users (id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index ix_reset_tokens_user on iam.password_reset_tokens (user_id);
