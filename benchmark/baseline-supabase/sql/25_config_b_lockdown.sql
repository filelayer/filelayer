-- =====================================================================
-- 25_config_b_lockdown.sql  --  APPLICATION CODE (counted, Config B only)
-- =====================================================================
-- CONFIGURATION B -- "every byte through the gateway".
--
-- In Configuration A (20_rls_policies.sql alone) any signed-in member can call
-- supabase.storage.from('vault').download(path) or .createSignedUrl(path, ...)
-- straight from the browser. RLS correctly allows it -- they ARE entitled to
-- read that object. But your application never sees the request, so it never
-- lands in the audit trail, and any signed URL they mint themselves is outside
-- your revocation model entirely.
--
-- If "every view and download is recorded" is a hard requirement, the only way
-- to get it is to stop `authenticated` from reading objects at all, and route
-- 100% of reads through server code holding the service key.
--
-- The trade is stark and worth stating plainly:
--   Config A: RLS is the enforcement point. Audit trail is incomplete.
--   Config B: audit trail is complete. RLS on storage.objects is now dead code
--             for reads -- the service key bypasses it -- so the security
--             property has moved from a declarative policy back into
--             imperative application code.
-- =====================================================================

drop policy "vault_read" on storage.objects;

-- Listing metadata is still fine (it leaks no bytes and the app UI needs it).
-- Fetching bytes and minting signed URLs are not.
create policy "vault_read_listing_only"
on storage.objects for select to authenticated
using (
  bucket_id = 'vault'
  and storage.allow_only_operation('object.list')
  and public.can_read_object(name)
);
