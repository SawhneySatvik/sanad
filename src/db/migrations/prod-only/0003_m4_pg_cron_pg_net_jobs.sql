-- prod-only; requires Supabase; never applied by db:migrate or the test harness
--
-- Guest-expiry deletion, part 2 of 2: pg_cron schedules plus pg_net delivery of deleted storage refs.
-- pg_cron can only run SQL, so it reaches the Storage API through pg_net calling a small Edge Function
-- that deletes the objects with the service-role key. That Edge Function is not in this repository
-- yet. Cannot run on PGlite (no pg_cron, pg_net or Vault), so nothing checks this file locally.
--
-- Apply order: after 0002_m4_ttl_and_cleanup_functions.sql.
--
-- PREREQUISITE, before applying: two Supabase Vault secrets (the DO block at the end refuses to
-- finish without them). Nothing secret is written in this file.
--   guest_storage_cleanup_url     the Edge Function URL
--   guest_storage_cleanup_secret  a bearer token the Edge Function checks

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Rows are deleted and the storage refs queued in the SAME transaction. pg_net only sends requests
-- after commit, so a rolled-back sweep never deletes bytes whose rows survived. If the cleanup URL is
-- missing the sweep fails loudly (visible in cron.job_run_details) instead of deleting rows and
-- orphaning their stored bytes, which would silently break the promise that guest data is not kept.
-- Known gap: an Edge Function failure after commit orphans those objects; a storage-vs-rows
-- reconciliation pass does not exist yet.
CREATE FUNCTION app_private.run_guest_ttl_sweep() RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  refs text[];
  cleanup_url text;
  cleanup_secret text;
BEGIN
  SELECT decrypted_secret INTO cleanup_url FROM vault.decrypted_secrets WHERE name = 'guest_storage_cleanup_url';
  SELECT decrypted_secret INTO cleanup_secret FROM vault.decrypted_secrets WHERE name = 'guest_storage_cleanup_secret';
  IF cleanup_url IS NULL OR cleanup_secret IS NULL THEN
    RAISE EXCEPTION 'guest TTL sweep: Vault secrets guest_storage_cleanup_url / guest_storage_cleanup_secret are not set';
  END IF;

  refs := app_private.delete_expired_guest_rows();

  IF cardinality(refs) > 0 THEN
    PERFORM net.http_post(
      url := cleanup_url,
      body := jsonb_build_object('storage_refs', to_jsonb(refs)),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cleanup_secret)
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_private.run_guest_ttl_sweep() FROM PUBLIC, anon, authenticated;

-- Every 5 minutes: guest data lives 2-4 hours, so a row outlives its expiry by at most one interval.
-- The prune job runs on the same cadence because it also expires analyzed_result_cache rows, whose
-- retention is tied to the guest document's.
SELECT cron.schedule('guest-ttl-sweep', '*/5 * * * *', 'SELECT app_private.run_guest_ttl_sweep()');
SELECT cron.schedule('rate-limit-and-cache-prune', '*/5 * * * *', 'SELECT app_private.prune_rate_limits_and_cache()');

-- Positive post-conditions: both extensions present, both Vault secrets present, and both jobs
-- scheduled exactly as written (cron.schedule upserts by name, so a re-run cannot duplicate them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'M4 post-condition failed: pg_cron is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE EXCEPTION 'M4 post-condition failed: pg_net is not installed';
  END IF;
  IF (SELECT count(*) FROM vault.decrypted_secrets
       WHERE name IN ('guest_storage_cleanup_url', 'guest_storage_cleanup_secret') AND decrypted_secret IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'M4 post-condition failed: Vault secrets guest_storage_cleanup_url / guest_storage_cleanup_secret are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'guest-ttl-sweep' AND schedule = '*/5 * * * *'
                   AND command = 'SELECT app_private.run_guest_ttl_sweep()' AND active) THEN
    RAISE EXCEPTION 'M4 post-condition failed: cron job guest-ttl-sweep is not scheduled as written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rate-limit-and-cache-prune' AND schedule = '*/5 * * * *'
                   AND command = 'SELECT app_private.prune_rate_limits_and_cache()' AND active) THEN
    RAISE EXCEPTION 'M4 post-condition failed: cron job rate-limit-and-cache-prune is not scheduled as written';
  END IF;
END;
$$;
