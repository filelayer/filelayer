-- =====================================================================
-- 00_platform_emulation.sql
-- =====================================================================
-- *** THIS FILE IS NOT APPLICATION CODE. IT IS EXCLUDED FROM ALL LOC COUNTS. ***
--
-- This file recreates, inside PGlite, the parts of a real Supabase project
-- that Supabase itself provides: the `auth` schema helper functions, the
-- `storage` schema (buckets/objects), and the `storage` RLS helper functions.
--
-- A developer building on Supabase writes NONE of this. It exists here only
-- so that the RLS policies in 20_rls_policies.sql -- which ARE application
-- code -- can be executed and attacked for real.
--
-- Fidelity notes (each mirrors documented Supabase behaviour):
--   * auth.uid() / auth.jwt() / auth.role() read the `request.jwt.claims`
--     GUC. This is exactly how Supabase implements them: PostgREST and the
--     Storage API set `request.jwt.claims` and `SET LOCAL ROLE` per request.
--     https://supabase.com/docs/guides/database/postgres/row-level-security
--   * storage.objects columns match the documented storage schema:
--     https://supabase.com/docs/guides/storage/schema/design
--   * storage.foldername/filename/extension match:
--     https://supabase.com/docs/guides/storage/schema/helper-functions
--   * storage.allow_only_operation/allow_any_operation match the same page;
--     the "current operation" is carried in a GUC, mirroring how the Storage
--     service sets it per request.
--   * Roles anon / authenticated / service_role match a real project.
--     service_role has BYPASSRLS, matching "Service keys entirely bypass RLS
--     policies": https://supabase.com/docs/guides/storage/security/access-control
-- =====================================================================

create role anon           nologin;
create role authenticated  nologin;
create role service_role   nologin bypassrls;

create schema auth;
create schema storage;

-- ---------------------------------------------------------------------
-- auth helpers (Supabase-provided)
-- ---------------------------------------------------------------------
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select auth.jwt() ->> 'role';
$$;

-- ---------------------------------------------------------------------
-- storage schema (Supabase-provided)
-- ---------------------------------------------------------------------
create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner_id           text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text not null references storage.buckets(id),
  name        text not null,
  owner_id    text,
  version     text,
  metadata    jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

-- The Storage service owns these tables; user requests arrive as
-- `authenticated`/`anon`, so RLS applies. FORCE makes PGlite behave the same
-- way even when a statement is run by the table owner.
alter table storage.objects force row level security;

grant usage on schema storage, auth to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects
  to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name,'/'),1) - 1];
$$;

create or replace function storage.filename(name text) returns text
language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name,'/'),1)];
$$;

create or replace function storage.extension(name text) returns text
language sql immutable as $$
  select (string_to_array(storage.filename(name), '.'))[
           array_length(string_to_array(storage.filename(name), '.'),1)];
$$;

-- Current Storage API operation, e.g. 'object.list', 'object.get_authenticated'.
create or replace function storage.operation() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('storage.operation', true), ''), '');
$$;

create or replace function storage.normalize_operation(op text) returns text
language sql immutable as $$
  select case when op like 'storage.%' then substring(op from 9) else op end;
$$;

create or replace function storage.allow_only_operation(op text) returns boolean
language sql stable as $$
  select case
    when coalesce(op,'') = '' or storage.operation() = '' then false
    else storage.normalize_operation(storage.operation())
         = storage.normalize_operation(op)
  end;
$$;

create or replace function storage.allow_any_operation(ops text[]) returns boolean
language sql stable as $$
  select case
    when ops is null or array_length(ops,1) is null or storage.operation() = ''
      then false
    else exists (
      select 1 from unnest(ops) o
      where storage.normalize_operation(o)
            = storage.normalize_operation(storage.operation()))
  end;
$$;

grant execute on all functions in schema storage to anon, authenticated, service_role;
grant execute on all functions in schema auth    to anon, authenticated, service_role;
