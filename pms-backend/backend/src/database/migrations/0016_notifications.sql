-- In-app notifications, per-user preferences and the record of scheduled job runs
create table platform.notifications (
  id            uuid primary key default public.uuid_v7(),
  type          text not null,                       -- low_stock, expiry, ...
  severity      text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  branch_id     uuid references org.branches (id) on delete restrict,
  permission    text not null,                       -- who may see it: holders of this permission, within the branch
  title         text not null,
  body          text not null default '',
  data          jsonb not null default '{}',
  entity_type   text,
  entity_id     uuid,
  dedupe_key    text unique,                         -- one open notification per condition; raised again after it clears
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  email_pending boolean not null default false,
  emailed_at    timestamptz
);
create index ix_notifications_open on platform.notifications (permission, branch_id, created_at desc) where resolved_at is null;
create index ix_notifications_email on platform.notifications (created_at) where email_pending;

create table platform.notification_reads (
  user_id          uuid not null references iam.users (id) on delete cascade,
  notification_id  uuid not null references platform.notifications (id) on delete cascade,
  read_at          timestamptz not null default now(),
  primary key (user_id, notification_id)
);

create table platform.notification_preferences (
  user_id  uuid not null references iam.users (id) on delete cascade,
  type     text not null,
  in_app   boolean not null default true,
  email    boolean not null default true,
  primary key (user_id, type)
);

create table platform.job_runs (
  id           uuid primary key default public.uuid_v7(),
  job          text not null,
  started_at   timestamptz not null default clock_timestamp(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'ok', 'failed')),
  result       jsonb,
  error        text
);
create index ix_job_runs_job on platform.job_runs (job, started_at desc);
