-- prod-only; requires Supabase; never applied by db:migrate or the test harness
--
-- Guest-expiry deletion and rate-limit/cache pruning, part 1 of 2, as plain SQL functions. Part 2
-- (0003_m4_pg_cron_pg_net_jobs.sql) schedules them with pg_cron and sends deleted storage refs to the
-- Storage-cleanup Edge Function with pg_net. This part uses neither extension, so the test suite can
-- exercise it against PGlite; that is a correctness check of the delete ordering, not a substitute for
-- running the jobs on Supabase.
--
-- Apply order: after 0001_m3_revoke_data_api_grants.sql.
--
-- LOCK ORDER (the guest→user claim, and anything else that writes several of these tables in one
-- transaction): the sweep takes row locks in the order comparisons → drafts → documents. A claim
-- transaction must touch its rows in that SAME order (comparisons first, documents last). The
-- opposite order can deadlock with a concurrent sweep; Postgres then aborts one of the two
-- transactions (no data is lost, the loser must retry), but it is avoidable by keeping the order.

-- Not in any schema the Data API exposes.
CREATE SCHEMA app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;

-- Deletes expired GUEST rows, leaf-first, in one transaction, and returns the storage_refs whose bytes
-- the caller must now delete (a row delete alone leaves the object): those of deleted documents that
-- no surviving document row still references.
--
-- Order: comparisons, then drafts, then documents, so no document is deleted while a row that
-- references it still exists (expiry timestamps are capped to tie, so ordering, not timestamps,
-- prevents the RESTRICT failures). Within a draft revision chain the order is NEWEST revision first:
-- parent_draft_id is ON DELETE RESTRICT, so deleting a parent while its child still exists fails.
-- Newest-first is the only order the RESTRICT permits.
--
-- Claim race: every DELETE re-checks expires_at < now() in its own WHERE, at delete time. Under READ
-- COMMITTED a row that a concurrent claim has just re-owned (expires_at cleared) is re-evaluated
-- against its new version and skipped, and so is its storage_ref.
--
-- owner_guest_session_id IS NOT NULL: TTL deletion never touches user-owned rows, even one that
-- carries an expires_at by mistake.
--
-- A document still referenced by a comparison that is not being deleted (a RESTRICT target) is
-- skipped and reported with a WARNING, so a comparison that already exists when the sweep runs cannot
-- abort it. Not covered: a comparison referencing an expired document that is INSERTed concurrently,
-- after the documents DELETE has chosen its rows. Its RESTRICT check then fails the sweep's
-- transaction, and the whole run rolls back (nothing is deleted and no bytes are purged). The next
-- scheduled run retries.
CREATE FUNCTION app_private.delete_expired_guest_rows() RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_refs text[];
  purge_refs text[];
  deleted_count integer;
  blocked_count integer;
BEGIN
  DELETE FROM public.comparisons
   WHERE expires_at < now()
     AND owner_guest_session_id IS NOT NULL;

  -- Each pass deletes the expired drafts that no remaining draft points at (the current leaves),
  -- until a pass deletes nothing.
  LOOP
    DELETE FROM public.drafts d
     WHERE d.expires_at < now()
       AND d.owner_guest_session_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.drafts child WHERE child.parent_draft_id = d.id);
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    EXIT WHEN deleted_count = 0;
  END LOOP;

  WITH deleted AS (
    DELETE FROM public.documents doc
     WHERE doc.expires_at < now()
       AND doc.owner_guest_session_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.comparisons c WHERE c.document_a_id = doc.id OR c.document_b_id = doc.id
       )
    RETURNING doc.storage_ref
  )
  SELECT coalesce(array_agg(storage_ref), '{}') INTO deleted_refs FROM deleted;

  -- Only purge bytes that NO surviving row (unexpired, claimed, or blocked above) still points at,
  -- compared case-insensitively. documents_storage_ref_key / documents_storage_ref_lower_key make
  -- this filter a no-op today; it is the second guard in case either is ever relaxed, because
  -- purging a claimed user's bytes is unrecoverable. This runs as a separate statement so it sees the
  -- deletes above.
  SELECT coalesce(array_agg(DISTINCT ref ORDER BY ref), '{}') INTO purge_refs
    FROM unnest(deleted_refs) AS ref
   WHERE NOT EXISTS (SELECT 1 FROM public.documents d WHERE lower(d.storage_ref) = lower(ref));

  SELECT count(*) INTO blocked_count
    FROM public.documents
   WHERE expires_at < now()
     AND owner_guest_session_id IS NOT NULL;
  IF blocked_count > 0 THEN
    RAISE WARNING 'guest TTL sweep: % expired guest document(s) kept because a live comparison still references them', blocked_count;
  END IF;

  RETURN purge_refs;
END;
$$;

-- analyzed_result_cache rows expire at or before their source document (a cache entry never outlives
-- the guest data it was derived from), so this runs on the same cadence as the expiry sweep.
-- Rate-limit rows are pruned by updated_at, not by parsing the text window_key; the retention must
-- exceed the longest window any limiter uses (a per-day provider quota is plausible), hence 2 days
-- rather than minutes.
CREATE FUNCTION app_private.prune_rate_limits_and_cache() RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM public.analyzed_result_cache WHERE expires_at < now();
  DELETE FROM public.rate_limit_buckets WHERE updated_at < now() - interval '2 days';
  DELETE FROM public.ip_rate_limit_buckets WHERE updated_at < now() - interval '2 days';
  DELETE FROM public.global_llm_rate_limit WHERE updated_at < now() - interval '2 days';
END;
$$;

REVOKE ALL ON FUNCTION app_private.delete_expired_guest_rows() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.prune_rate_limits_and_cache() FROM PUBLIC, anon, authenticated;
