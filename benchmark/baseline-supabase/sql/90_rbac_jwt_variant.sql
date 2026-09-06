-- =====================================================================
-- 90_rbac_jwt_variant.sql  --  MEASUREMENT ARTEFACT (excluded from LOC)
-- =====================================================================
-- Not part of the Vault implementation. This exists so the test suite can
-- measure the alternative that Supabase's own RBAC guide recommends -- putting
-- the role in a JWT custom claim via a Custom Access Token Auth Hook --
-- side by side with the table-lookup approach Vault actually uses.
--   https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac
--
-- The point being measured: a claim baked into an access token does not change
-- when the underlying membership row changes. Until the token is refreshed
-- (default access-token lifetime: 1 hour) a removed or demoted member keeps
-- their old rights. That is a fail-OPEN window and it is invisible.
-- =====================================================================

create or replace function public.org_role_of_jwt(p_org uuid)
returns public.org_role
language sql stable as $$
  select nullif(auth.jwt() -> 'org_roles' ->> p_org::text, '')::public.org_role;
$$;
grant execute on function public.org_role_of_jwt(uuid) to authenticated, service_role;

create table public.documents_jwt_demo (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  label  text not null
);
alter table public.documents_jwt_demo enable row level security;
alter table public.documents_jwt_demo force row level security;
grant select, insert on public.documents_jwt_demo to authenticated;
grant all on public.documents_jwt_demo to service_role;

create policy "jwt_demo_read" on public.documents_jwt_demo
  for select to authenticated
  using ( public.org_role_of_jwt(org_id) is not null );
