-- prod-only; requires Supabase; never applied by db:migrate or the test harness
-- The object store holds every uploaded document's raw bytes; Data API roles must never read or
-- write it directly, same posture as storage_cleanup_outbox's own revoke (0004).
REVOKE ALL ON TABLE public.storage_objects FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO leaked
    FROM (VALUES ('anon'), ('authenticated')) AS r (rolname)
   WHERE has_table_privilege(r.rolname, 'public.storage_objects',
                             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(r.rolname, 'public.storage_objects',
                                  'SELECT, INSERT, UPDATE, REFERENCES');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'storage objects post-condition failed: Data API roles still hold privileges: %', leaked;
  END IF;
END;
$$;
