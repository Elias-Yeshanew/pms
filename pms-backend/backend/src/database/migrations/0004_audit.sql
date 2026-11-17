-- Append-only audit log, partitioned by month
create table audit.audit_logs (
  id           uuid not null default public.uuid_v7(),
  occurred_at  timestamptz not null default now(),
  user_id      uuid,
  branch_id    uuid,
  device_id    uuid,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  old_value    jsonb,
  new_value    jsonb,
  ip_address   text,
  request_id   text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

create table audit.audit_logs_default partition of audit.audit_logs default;

create index ix_audit_entity on audit.audit_logs (entity_type, entity_id);
create index ix_audit_user on audit.audit_logs (user_id, occurred_at desc);
create index ix_audit_branch on audit.audit_logs (branch_id, occurred_at desc);

create trigger trg_audit_logs_append_only before update or delete on audit.audit_logs
  for each row execute function public.forbid_mutation();

-- Creates the monthly partition that contains the given date (idempotent)
create or replace function audit.ensure_partition(p_date date) returns void as $$
declare
  start_d date := date_trunc('month', p_date)::date;
  end_d   date := (date_trunc('month', p_date) + interval '1 month')::date;
  part    text := format('audit_logs_%s', to_char(start_d, 'YYYY_MM'));
begin
  if to_regclass(format('audit.%I', part)) is null then
    execute format('create table audit.%I partition of audit.audit_logs for values from (%L) to (%L)',
                   part, start_d, end_d);
  end if;
end;
$$ language plpgsql;

select audit.ensure_partition(current_date);
select audit.ensure_partition((current_date + interval '1 month')::date);
