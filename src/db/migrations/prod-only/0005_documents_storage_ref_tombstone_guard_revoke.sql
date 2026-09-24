-- prod-only; requires Supabase; never applied by db:migrate or the test harness
-- Trigger functions are not useful RPCs, but PostgreSQL grants EXECUTE to PUBLIC by default.
REVOKE ALL ON FUNCTION public.documents_storage_ref_tombstone_guard() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO leaked
    FROM (VALUES ('anon'), ('authenticated')) AS r (rolname)
   WHERE has_function_privilege(r.rolname, 'public.documents_storage_ref_tombstone_guard()', 'EXECUTE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'storage ref guard post-condition failed: Data API roles can execute function: %', leaked;
  END IF;
END;
$$;
