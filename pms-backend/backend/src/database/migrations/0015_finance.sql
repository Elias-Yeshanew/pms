-- Finance: chart of accounts, fiscal periods, double-entry journal, expenses, other income, register sessions
create table finance.accounts (
  id          uuid primary key default public.uuid_v7(),
  code        text not null unique check (code ~ '^[0-9A-Za-z.-]{2,20}$'),
  name        text not null,
  type        text not null check (type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  is_system   boolean not null default false,        -- referenced by posting rules; can be renamed but not deactivated
  is_active   boolean not null default true,
  note        text,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create trigger trg_accounts_touch before update on finance.accounts for each row execute function public.touch_row();

-- Which account each kind of posting uses ("cash", "inventory", "payment.mobile_money", ...). Administrators can re-point them.
create table finance.account_mappings (
  key         text primary key check (key ~ '^[a-z0-9_.]{2,60}$'),
  account_id  uuid not null references finance.accounts (id) on delete restrict,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table finance.fiscal_periods (
  id          uuid primary key default public.uuid_v7(),
  name        text not null unique,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  closed_by   uuid references iam.users (id) on delete restrict,
  closed_at   timestamptz,
  reopen_note text,
  version     integer not null default 1,
  check (end_date >= start_date),
  constraint ex_periods_no_overlap exclude using gist (daterange(start_date, end_date, '[]') with &&)
);

create table finance.journal_entries (
  id            uuid primary key default public.uuid_v7(),
  entry_no      text not null unique,
  entry_date    date not null,
  branch_id     uuid references org.branches (id) on delete restrict,
  event_code    text not null,                         -- e.g. sale.revenue, stock.receipt, manual
  source_type   text,
  source_id     uuid,
  description   text not null,
  reverses_id   uuid unique references finance.journal_entries (id) on delete restrict,
  created_by    uuid references iam.users (id) on delete restrict,
  created_at    timestamptz not null default clock_timestamp()
);
create index ix_journal_date on finance.journal_entries (entry_date);
create index ix_journal_source on finance.journal_entries (source_type, source_id);
create index ix_journal_branch on finance.journal_entries (branch_id, entry_date);

create table finance.journal_lines (
  id          uuid primary key default public.uuid_v7(),
  entry_id    uuid not null references finance.journal_entries (id) on delete restrict,
  line_no     integer not null,
  account_id  uuid not null references finance.accounts (id) on delete restrict,
  branch_id   uuid references org.branches (id) on delete restrict,
  debit       numeric(18, 4) not null default 0 check (debit >= 0),
  credit      numeric(18, 4) not null default 0 check (credit >= 0),
  memo        text,
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
  unique (entry_id, line_no)
);
create index ix_lines_account on finance.journal_lines (account_id);
create index ix_lines_entry on finance.journal_lines (entry_id);

create trigger trg_entries_append_only before update or delete on finance.journal_entries for each row execute function public.forbid_mutation();
create trigger trg_lines_append_only before update or delete on finance.journal_lines for each row execute function public.forbid_mutation();

-- An entry must balance and have at least two lines; checked when the transaction commits
create function finance.check_entry_balanced() returns trigger language plpgsql as $$
declare d numeric; c numeric; n integer;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) into d, c, n from finance.journal_lines where entry_id = new.entry_id;
  if n < 2 or d <> c then
    raise exception 'Journal entry % is not balanced (debit %, credit %, % lines)', new.entry_id, d, c, n using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger trg_lines_balanced after insert on finance.journal_lines
  deferrable initially deferred for each row execute function finance.check_entry_balanced();

-- Expenses and other income
create table finance.expense_categories (
  id          uuid primary key default public.uuid_v7(),
  code        text not null unique check (code ~ '^[a-z0-9_]{2,30}$'),
  name        text not null,
  account_id  uuid not null references finance.accounts (id) on delete restrict,
  is_active   boolean not null default true,
  version     integer not null default 1,
  updated_by  uuid
);
create table finance.income_categories (
  id          uuid primary key default public.uuid_v7(),
  code        text not null unique check (code ~ '^[a-z0-9_]{2,30}$'),
  name        text not null,
  account_id  uuid not null references finance.accounts (id) on delete restrict,
  is_active   boolean not null default true,
  version     integer not null default 1,
  updated_by  uuid
);

create table finance.expenses (
  id              uuid primary key default public.uuid_v7(),
  reference_no    text not null unique,
  branch_id       uuid not null references org.branches (id) on delete restrict,
  category_id     uuid not null references finance.expense_categories (id) on delete restrict,
  expense_date    date not null,
  amount          numeric(18, 4) not null check (amount > 0),
  method_code     text not null,                       -- a sales payment method code: cash, mobile_money, bank_transfer, ...
  payee           text,
  description     text not null,
  external_ref    text,
  register_id     uuid references org.cash_registers (id) on delete restrict,
  status          text not null default 'posted' check (status in ('pending_approval', 'posted', 'rejected', 'cancelled', 'reversed')),
  entry_id        uuid references finance.journal_entries (id) on delete restrict,
  created_by      uuid not null references iam.users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  decided_by      uuid references iam.users (id) on delete restrict,
  reversed_by     uuid references iam.users (id) on delete restrict,
  reversed_at     timestamptz,
  reversal_reason text,
  version         integer not null default 1
);
create index ix_expenses_branch_date on finance.expenses (branch_id, expense_date);
create index ix_expenses_status on finance.expenses (status);

create table finance.incomes (
  id              uuid primary key default public.uuid_v7(),
  reference_no    text not null unique,
  branch_id       uuid not null references org.branches (id) on delete restrict,
  category_id     uuid not null references finance.income_categories (id) on delete restrict,
  income_date     date not null,
  amount          numeric(18, 4) not null check (amount > 0),
  method_code     text not null,
  payer           text,
  description     text not null,
  external_ref    text,
  register_id     uuid references org.cash_registers (id) on delete restrict,
  status          text not null default 'posted' check (status in ('posted', 'reversed')),
  entry_id        uuid references finance.journal_entries (id) on delete restrict,
  created_by      uuid not null references iam.users (id) on delete restrict,
  created_at      timestamptz not null default now(),
  reversed_by     uuid references iam.users (id) on delete restrict,
  reversed_at     timestamptz,
  reversal_reason text,
  version         integer not null default 1
);
create index ix_incomes_branch_date on finance.incomes (branch_id, income_date);

-- A cashier's shift on one register: opening float, counted closing cash, variance
create table finance.register_sessions (
  id              uuid primary key default public.uuid_v7(),
  reference_no    text not null unique,
  register_id     uuid not null references org.cash_registers (id) on delete restrict,
  branch_id       uuid not null references org.branches (id) on delete restrict,
  business_date   date not null,
  opened_by       uuid not null references iam.users (id) on delete restrict,
  opened_at       timestamptz not null default clock_timestamp(),
  opening_amount  numeric(18, 4) not null check (opening_amount >= 0),
  status          text not null default 'open' check (status in ('open', 'closed')),
  closed_by       uuid references iam.users (id) on delete restrict,
  closed_at       timestamptz,
  counted_amount  numeric(18, 4) check (counted_amount >= 0),
  expected_amount numeric(18, 4),
  variance        numeric(18, 4),
  close_note      text,
  entry_id        uuid references finance.journal_entries (id) on delete restrict,
  version         integer not null default 1
);
create unique index uq_one_open_session_per_register on finance.register_sessions (register_id) where status = 'open';
create index ix_sessions_branch_date on finance.register_sessions (branch_id, business_date);

-- Manual journal entries are requested by one person and posted when a second person approves
create table finance.manual_journals (
  id            uuid primary key default public.uuid_v7(),
  reference_no  text not null unique,
  branch_id     uuid references org.branches (id) on delete restrict,
  entry_date    date not null,
  description   text not null,
  lines         jsonb not null,
  status        text not null default 'pending_approval' check (status in ('pending_approval', 'posted', 'rejected', 'cancelled')),
  entry_id      uuid references finance.journal_entries (id) on delete restrict,
  requested_by  uuid not null references iam.users (id) on delete restrict,
  requested_at  timestamptz not null default now(),
  decided_by    uuid references iam.users (id) on delete restrict
);
