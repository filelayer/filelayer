-- =====================================================================
-- 30_audit.sql  --  APPLICATION CODE (counted)
-- =====================================================================
-- Tamper-EVIDENT audit trail. Per-org hash chain:
--     hash_n = sha256( hash_{n-1} || canonical(entry_n) )
--
-- What this does and does not buy you, stated plainly:
--   * Detects any edit, deletion or reordering of past entries, because the
--     chain no longer verifies. -> tamper-EVIDENT.
--   * Does NOT prevent tampering. The table is in your own Postgres. Anything
--     holding the service_role key (which has BYPASSRLS) or the postgres role
--     can rewrite rows AND recompute every downstream hash. To make it
--     tamper-RESISTANT you must ship the head hash somewhere you do not
--     control -- a second account, a notary, a WORM bucket. Not done here;
--     see REPORT.md "Could not be implemented".
--
-- Concurrency: the chain is a serialization point. One advisory lock per org
-- per append. Ceiling is roughly one audit write per org per transaction
-- round-trip.
-- =====================================================================

create or replace function public.audit_append(
  p_org        uuid,
  p_actor      uuid,
  p_actor_kind text,
  p_action     text,
  p_subject    jsonb
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_seq  bigint;
  v_prev text;
  v_hash text;
  v_ts   timestamptz := clock_timestamp();
begin
  -- Serialize appends for this org so the chain cannot fork.
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 0));

  select a.seq, a.hash into v_seq, v_prev
  from public.audit_log a
  where a.org_id = p_org
  order by a.seq desc
  limit 1;

  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, repeat('0', 64));

  v_hash := encode(sha256(convert_to(
      v_prev
      || '|' || p_org::text
      || '|' || v_seq::text
      || '|' || coalesce(p_actor::text, '')
      || '|' || p_actor_kind
      || '|' || p_action
      || '|' || to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USZ')
      || '|' || (p_subject #>> '{}')          -- jsonb text, key-sorted by pg
    , 'utf8')), 'hex');

  insert into public.audit_log
    (org_id, seq, actor_id, actor_kind, action, subject, occurred_at, prev_hash, hash)
  values
    (p_org, v_seq, p_actor, p_actor_kind, p_action, p_subject, v_ts, v_prev, v_hash);

  return v_seq;
end;
$$;

-- Only the server (service key) appends. Authenticated users must never be
-- able to write their own audit records.
revoke execute on function
  public.audit_append(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant  execute on function
  public.audit_append(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.audit_verify(p_org uuid)
returns table (ok boolean, broken_at bigint, checked bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  r      record;
  v_prev text := repeat('0', 64);
  v_calc text;
  v_n    bigint := 0;
  v_exp  bigint := 0;
begin
  for r in
    select * from public.audit_log a where a.org_id = p_org order by a.seq asc
  loop
    v_exp := v_exp + 1;
    if r.seq <> v_exp then                      -- a row was deleted outright
      return query select false, r.seq, v_n; return;
    end if;
    v_calc := encode(sha256(convert_to(
        v_prev
        || '|' || r.org_id::text
        || '|' || r.seq::text
        || '|' || coalesce(r.actor_id::text, '')
        || '|' || r.actor_kind
        || '|' || r.action
        || '|' || to_char(r.occurred_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.USZ')
        || '|' || (r.subject #>> '{}')
      , 'utf8')), 'hex');
    if v_calc <> r.hash or r.prev_hash <> v_prev then
      return query select false, r.seq, v_n; return;
    end if;
    v_prev := r.hash;
    v_n := v_n + 1;
  end loop;
  return query select true, null::bigint, v_n;
end;
$$;

grant execute on function public.audit_verify(uuid) to authenticated, service_role;

-- Head hash for external anchoring. An operator who publishes this value
-- somewhere they do not control turns tamper-evidence into something a
-- service-key holder cannot quietly defeat.
create or replace function public.audit_head(p_org uuid)
returns table (seq bigint, hash text)
language sql stable security definer set search_path = '' as $$
  select a.seq, a.hash from public.audit_log a
  where a.org_id = p_org order by a.seq desc limit 1;
$$;
grant execute on function public.audit_head(uuid) to authenticated, service_role;
