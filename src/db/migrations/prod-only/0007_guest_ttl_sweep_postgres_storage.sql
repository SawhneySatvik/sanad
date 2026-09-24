-- prod-only; requires Supabase; never applied by db:migrate or the test harness
--
-- Guest-expiry deletion when stored bytes live in public.storage_objects (the Postgres storage
-- adapter, used on serverless hosts). Apply INSTEAD of 0003_m4_pg_cron_pg_net_jobs.sql: that file
-- ships deleted refs to an external Edge Function through pg_net and refuses to apply without its
-- Vault secrets. Here the bytes are rows in the same database, so they are deleted in the same
-- transaction as the rows that referenced them, and nothing leaves the database.
--
-- Apply order: after 0002, 0004, 0005 and 0006. Idempotent: CREATE OR REPLACE and cron.schedule
-- (which upserts by job name) make a re-run safe, including over a database that did apply 0003.

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

CREATE OR REPLACE FUNCTION app_private.run_guest_ttl_sweep() RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  refs text[];
BEGIN
  refs := app_private.delete_expired_guest_rows();

  DELETE FROM public.storage_objects WHERE storage_ref = ANY (refs);

  -- Bytes no document row references any more: files the owner deleted (their refs wait in the
  -- cleanup outbox, and no worker runs on a serverless host) and uploads abandoned before confirm.
  -- The one-hour floor leaves an upload in flight alone, since its document row is written only
  -- after the bytes arrive.
  DELETE FROM public.storage_objects so
   WHERE so.created_at < now() - interval '1 hour'
     AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.storage_ref = so.storage_ref);

  DELETE FROM public.storage_cleanup_outbox o
   WHERE NOT EXISTS (SELECT 1 FROM public.storage_objects so WHERE so.storage_ref = o.storage_ref)
     AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.storage_ref = o.storage_ref);
END;
$$;

REVOKE ALL ON FUNCTION app_private.run_guest_ttl_sweep() FROM PUBLIC, anon, authenticated;

-- Every 5 minutes: guest data lives 2-4 hours, so a row outlives its expiry by at most one interval.
SELECT cron.schedule('guest-ttl-sweep', '*/5 * * * *', 'SELECT app_private.run_guest_ttl_sweep()');
SELECT cron.schedule('rate-limit-and-cache-prune', '*/5 * * * *', 'SELECT app_private.prune_rate_limits_and_cache()');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'guest-ttl-sweep' AND schedule = '*/5 * * * *'
                   AND command = 'SELECT app_private.run_guest_ttl_sweep()' AND active) THEN
    RAISE EXCEPTION 'post-condition failed: cron job guest-ttl-sweep is not scheduled as written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rate-limit-and-cache-prune' AND schedule = '*/5 * * * *'
                   AND command = 'SELECT app_private.prune_rate_limits_and_cache()' AND active) THEN
    RAISE EXCEPTION 'post-condition failed: cron job rate-limit-and-cache-prune is not scheduled as written';
  END IF;
END;
$$;
