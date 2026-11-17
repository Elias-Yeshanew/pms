-- Organization: branches, departments, employees
create table org.branches (
  id          uuid primary key default public.uuid_v7(),
  code        text not null unique check (code ~ '^[A-Z0-9_-]{2,20}$'),
  name        text not null check (length(trim(name)) > 0),
  address     text,
  phone       text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  is_central  boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create trigger trg_branches_touch before update on org.branches
  for each row execute function public.touch_row();

create table org.departments (
  id          uuid primary key default public.uuid_v7(),
  name        citext not null unique,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  version     integer not null default 1
);
create trigger trg_departments_touch before update on org.departments
  for each row execute function public.touch_row();

create table org.employees (
  id                 uuid primary key default public.uuid_v7(),
  branch_id          uuid not null references org.branches (id) on delete restrict,
  department_id      uuid references org.departments (id) on delete restrict,
  full_name          text not null check (length(trim(full_name)) > 0),
  job_title          text,
  hire_date          date,
  employment_status  text not null default 'active' check (employment_status in ('active', 'on_leave', 'terminated')),
  phone              text,
  email              citext,
  created_at         timestamptz not null default now(),
  created_by         uuid,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  version            integer not null default 1
);
create index ix_employees_branch on org.employees (branch_id);
create trigger trg_employees_touch before update on org.employees
  for each row execute function public.touch_row();
