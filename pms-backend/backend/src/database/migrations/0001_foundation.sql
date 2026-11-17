-- Foundation: extensions, schemas, helper functions
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

create schema if not exists iam;
create schema if not exists org;
create schema if not exists audit;
create schema if not exists platform;

-- Time-ordered UUID (v7) so primary keys index well and sort by creation time
create or replace function public.uuid_v7() returns uuid as $$
  select encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
                from 1 for 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ language sql volatile;

-- Keeps updated_at honest regardless of what the application sends
create or replace function public.touch_row() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

-- Used on append-only tables
create or replace function public.forbid_mutation() returns trigger as $$
begin
  raise exception 'Table %.% is append-only: % is not allowed', tg_table_schema, tg_table_name, tg_op
    using errcode = 'integrity_constraint_violation';
end;
$$ language plpgsql;
