-- =====================================================================
-- 10_app_schema.sql  --  APPLICATION CODE (counted)
-- =====================================================================
-- Vault: B2B document workspace on Supabase Postgres + Supabase Storage.
--
-- Layout in Storage:  bucket `vault`, object name `{org_id}/{document_id}/{filename}`
--   (storage.foldername(name))[1] = org_id
--   (storage.foldername(name))[2] = document_id
-- =====================================================================

create type public.org_role as enum ('owner', 'admin', 'member', 'viewer');

-- Stand-in for auth.users, which Supabase provides.
create table public.app_users (
  id    uuid primary key default gen_random_uuid(),
  email text unique not null
);

create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  role       public.org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index on public.org_members (user_id);

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  uploader_id  uuid not null references public.app_users(id),
  filename     text not null,
  -- Authoritative object name in the `vault` bucket. Mutable: rotating it is
  -- the only project-level way to invalidate outstanding signed URLs.
  storage_path text not null unique,
  size_bytes   bigint,
  mime_type    text,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index on public.documents (org_id);
-- Required: the storage.objects RLS policies join on this column on every
-- single object request. Without it every download does a seq scan.
create index on public.documents (storage_path);

create table public.share_links (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.orgs(id) on delete cascade,
  document_id    uuid not null references public.documents(id) on delete cascade,
  created_by     uuid not null references public.app_users(id),
  token          text not null unique,      -- opaque public identifier
  expires_at     timestamptz not null,
  password_hash  text,                      -- null = no password
  password_salt  text,
  max_downloads  integer,                   -- null = unlimited
  download_count integer not null default 0,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index on public.share_links (document_id);
create index on public.share_links (org_id);

-- Tamper-EVIDENT audit trail: append-only hash chain, one chain per org.
create table public.audit_log (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references public.orgs(id) on delete cascade,
  seq        bigint not null,
  actor_id   uuid,            -- null for anonymous share-link redemptions
  actor_kind text not null,   -- 'user' | 'share_link' | 'system'
  action     text not null,   -- view|download|share|revoke|permission_change|upload|delete
  subject    jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  prev_hash  text not null,
  hash       text not null,
  unique (org_id, seq)
);
create index on public.audit_log (org_id, seq desc);

alter table public.orgs        enable row level security;
alter table public.org_members enable row level security;
alter table public.documents   enable row level security;
alter table public.share_links enable row level security;
alter table public.audit_log   enable row level security;
alter table public.app_users   enable row level security;

alter table public.orgs        force row level security;
alter table public.org_members force row level security;
alter table public.documents   force row level security;
alter table public.share_links force row level security;
alter table public.audit_log   force row level security;
alter table public.app_users   force row level security;

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete
  on public.orgs, public.org_members, public.documents, public.app_users
  to authenticated;
grant select, insert, delete on public.share_links to authenticated;
-- COLUMN-LEVEL grant. RLS can gate *which rows* you may update but not *which
-- columns*. Without this, any policy that lets a user revoke a share link also
-- lets them reset download_count to 0 or push expires_at into 2099.
grant update (revoked_at) on public.share_links to authenticated;
-- Deliberately NO update/delete grant on audit_log for authenticated.
grant select on public.audit_log to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role, authenticated;
