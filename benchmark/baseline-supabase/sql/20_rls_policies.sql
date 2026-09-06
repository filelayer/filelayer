-- =====================================================================
-- 20_rls_policies.sql  --  APPLICATION CODE (counted)
-- =====================================================================
-- Authorization kernel + RLS policies.
--
-- Docs followed:
--   Storage access control  https://supabase.com/docs/guides/storage/security/access-control
--   Storage helper fns      https://supabase.com/docs/guides/storage/schema/helper-functions
--   Ownership               https://supabase.com/docs/guides/storage/security/ownership
--   RLS + SECURITY DEFINER  https://supabase.com/docs/guides/database/postgres/row-level-security
--   Custom claims / RBAC    https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac
--
-- DESIGN DECISION 1 -- role source of truth.
--   Supabase's headline RBAC guide puts the role in a JWT custom claim via a
--   Custom Access Token Auth Hook. That is one round-trip cheaper, but the JWT
--   is issued at login and is stale until refresh (default access-token TTL is
--   1 hour), so demoting or removing a member does NOT take effect for up to
--   an hour. For a scenario that demands "permission change is audited and
--   effective", we read the role from public.org_members through a
--   SECURITY DEFINER function instead. Slower, always fresh, fails closed.
--   (See tests/rbac_staleness.test for a measurement of both.)
--
-- DESIGN DECISION 2 -- single source of truth for object access.
--   storage.objects policies could re-derive authorization from the path
--   alone. Instead they JOIN public.documents so there is ONE authorization
--   rule, not two that can drift. The path check is kept as cheap
--   defence-in-depth. Cost: documents rows must exist before upload, and
--   public.documents(storage_path) must be indexed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Authorization kernel. SECURITY DEFINER, so these functions see through
-- RLS on public.org_members / public.documents. They are therefore the
-- trusted core: a bug in ANY of them is a silent cross-tenant leak.
-- `set search_path = ''` per Supabase guidance; everything is qualified.
-- ---------------------------------------------------------------------

create or replace function public.org_role_of(p_org uuid)
returns public.org_role
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.org_members m
  where m.org_id = p_org
    and m.user_id = (select auth.uid());
$$;

create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.org_role_of(p_org) is not null;
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.org_role_of(p_org) in ('owner','admin');
$$;

create or replace function public.can_write_org(p_org uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select public.org_role_of(p_org) in ('owner','admin','member');
$$;

-- Read = any member of the owning org (viewers included), doc not deleted.
create or replace function public.can_read_document(p_doc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.id = p_doc
      and d.deleted_at is null
      and public.is_org_member(d.org_id)
  );
$$;

-- Manage = org owner/admin for any doc, or the uploader for their own.
create or replace function public.can_manage_document(p_doc uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.id = p_doc
      and d.deleted_at is null
      and ( public.is_org_admin(d.org_id)
            or d.uploader_id = (select auth.uid()) )
  );
$$;

-- Object-name -> document resolution used by the storage.objects policies.
create or replace function public.can_read_object(p_name text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.storage_path = p_name
      and d.deleted_at is null
      and public.is_org_member(d.org_id)
      -- defence in depth: path org segment must match the document's org
      and (storage.foldername(p_name))[1] = d.org_id::text
  );
$$;

create or replace function public.can_manage_object(p_name text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.documents d
    where d.storage_path = p_name
      and d.deleted_at is null
      and (storage.foldername(p_name))[1] = d.org_id::text
      and ( public.is_org_admin(d.org_id)
            or d.uploader_id = (select auth.uid()) )
  );
$$;

grant execute on function
  public.org_role_of(uuid), public.is_org_member(uuid), public.is_org_admin(uuid),
  public.can_write_org(uuid), public.can_read_document(uuid),
  public.can_manage_document(uuid), public.can_read_object(text),
  public.can_manage_object(text)
to authenticated, service_role;
-- anon gets nothing: share-link redemption goes through the gateway, which
-- uses the service key. An anon caller has zero reach into storage.objects.
revoke execute on function
  public.can_read_object(text), public.can_manage_object(text)
from anon, public;

-- =====================================================================
-- POLICIES ON storage.objects   (bucket `vault` is PRIVATE)
-- =====================================================================

-- P1. READ. Covers listing, authenticated GET, and signing.
--     `allow_any_operation` is what stops a user who may download an object
--     from also enumerating the bucket, per the helper-functions doc; here we
--     deliberately allow list too, because listing is scoped to the org by
--     can_read_object anyway.
create policy "vault_read"
on storage.objects for select to authenticated
using (
  bucket_id = 'vault'
  and storage.allow_any_operation(array[
        'object.list',
        'object.get_authenticated',
        'object.get_info',
        'object.sign'
      ])
  and public.can_read_object(name)
);

-- P2. UPLOAD. The document row must already exist and name it; the caller
--     must be owner/admin/member (NOT viewer) of that document's org.
create policy "vault_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'vault'
  and owner_id = (select auth.uid())::text
  and exists (
    select 1 from public.documents d
    where d.storage_path = storage.objects.name
      and d.deleted_at is null
      and (storage.foldername(storage.objects.name))[1] = d.org_id::text
      and (storage.foldername(storage.objects.name))[2] = d.id::text
      and d.uploader_id = (select auth.uid())
      and public.can_write_org(d.org_id)
  )
);

-- P3. UPDATE (overwrite / move). USING gates the old row, WITH CHECK the new
--     one. Omitting WITH CHECK would let a member move an object out of their
--     org's prefix -- a silent cross-tenant write.
create policy "vault_update"
on storage.objects for update to authenticated
using      ( bucket_id = 'vault' and public.can_manage_object(name) )
with check ( bucket_id = 'vault' and public.can_manage_object(name) );

-- P4. DELETE.
create policy "vault_delete"
on storage.objects for delete to authenticated
using ( bucket_id = 'vault' and public.can_manage_object(name) );

-- No policy exists for `anon` on storage.objects, and none for any other
-- bucket. RLS denies by default, so both are closed.

-- =====================================================================
-- POLICIES ON public.*
-- =====================================================================

create policy "orgs_read" on public.orgs
  for select to authenticated using ( public.is_org_member(id) );

create policy "members_read" on public.org_members
  for select to authenticated using ( public.is_org_member(org_id) );

-- Admins may add/change/remove members, but may not mint an `owner`; only an
-- existing owner can do that. Without this WITH CHECK an admin can escalate.
create policy "members_write_admin" on public.org_members
  for insert to authenticated
  with check (
    public.is_org_admin(org_id)
    and ( role <> 'owner' or public.org_role_of(org_id) = 'owner' )
  );

create policy "members_update_admin" on public.org_members
  for update to authenticated
  using ( public.is_org_admin(org_id) )
  with check (
    public.is_org_admin(org_id)
    and ( role <> 'owner' or public.org_role_of(org_id) = 'owner' )
  );

create policy "members_delete_admin" on public.org_members
  for delete to authenticated
  using (
    public.is_org_admin(org_id)
    and ( role <> 'owner' or public.org_role_of(org_id) = 'owner' )
  );

-- NOTE, and this cost real debugging time: the `deleted_at is null` clause
-- cannot live here alone. Under FORCE ROW LEVEL SECURITY, Postgres applies the
-- SELECT policy to the POST-UPDATE row, so a policy that hides soft-deleted
-- rows makes `update ... set deleted_at = now()` fail with
-- "new row violates row-level security policy for table documents" -- an error
-- raised by a policy the developer was not editing. Whoever may soft-delete a
-- row must still be able to see it afterwards. Note the failure direction: it
-- errored. RLS surprises here fail CLOSED.
create policy "documents_read" on public.documents
  for select to authenticated
  using (
    public.is_org_member(org_id)
    and ( deleted_at is null
          or public.is_org_admin(org_id)
          or uploader_id = (select auth.uid()) )
  );

create policy "documents_insert" on public.documents
  for insert to authenticated
  with check (
    public.can_write_org(org_id)
    and uploader_id = (select auth.uid())
  );

create policy "documents_update" on public.documents
  for update to authenticated
  using ( public.is_org_admin(org_id) or uploader_id = (select auth.uid()) )
  with check ( public.is_org_admin(org_id) or uploader_id = (select auth.uid()) );

create policy "documents_delete" on public.documents
  for delete to authenticated
  using ( public.is_org_admin(org_id) or uploader_id = (select auth.uid()) );

create policy "share_read" on public.share_links
  for select to authenticated using ( public.is_org_member(org_id) );

-- "Any member can create a share link for a document they can read."
create policy "share_insert" on public.share_links
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and public.can_read_document(document_id)
    and exists (select 1 from public.documents d
                where d.id = document_id and d.org_id = share_links.org_id)
  );

-- Revocation: creator or org admin. Column grants (10_app_schema.sql) restrict
-- this to the revoked_at column only.
create policy "share_revoke" on public.share_links
  for update to authenticated
  using ( public.is_org_admin(org_id) or created_by = (select auth.uid()) )
  with check ( public.is_org_admin(org_id) or created_by = (select auth.uid()) );

create policy "share_delete" on public.share_links
  for delete to authenticated
  using ( public.is_org_admin(org_id) or created_by = (select auth.uid()) );

-- Audit trail is readable by org admins only. There is no INSERT, UPDATE or
-- DELETE policy and no UPDATE/DELETE grant, so all three are denied for every
-- authenticated user. Writes happen only through public.audit_append below.
create policy "audit_read_admin" on public.audit_log
  for select to authenticated using ( public.is_org_admin(org_id) );

create policy "users_read_self_or_coworker" on public.app_users
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.org_members m
      where m.user_id = public.app_users.id
        and public.is_org_member(m.org_id))
  );
