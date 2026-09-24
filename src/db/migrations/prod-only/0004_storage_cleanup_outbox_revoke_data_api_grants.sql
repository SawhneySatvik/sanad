-- prod-only; requires Supabase; never applied by db:migrate or the test harness
-- The outbox is created after the existing named table revokes, so it needs its own explicit
-- denial even when the platform's default privileges change.
REVOKE ALL ON TABLE public.storage_cleanup_outbox FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO leaked
    FROM (VALUES ('anon'), ('authenticated')) AS r (rolname)
   WHERE has_table_privilege(r.rolname, 'public.storage_cleanup_outbox',
                             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(r.rolname, 'public.storage_cleanup_outbox',
                                  'SELECT, INSERT, UPDATE, REFERENCES');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'storage cleanup outbox post-condition failed: Data API roles still hold privileges: %', leaked;
  END IF;
END;
$$;
