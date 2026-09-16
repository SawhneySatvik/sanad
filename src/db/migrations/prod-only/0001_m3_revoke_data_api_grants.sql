-- prod-only; requires Supabase; never applied by db:migrate or the test harness
--
-- Deny-all Data API posture, defense-in-depth on top of the platform's own opt-out default. App tables
-- are reached only through Drizzle from server code as the owning role; the anon/authenticated roles
-- that PostgREST uses must hold nothing on them.
--
-- Apply order: after every file in src/db/migrations/ (and after pending/ files once they are moved
-- up). Re-runnable: revoking a privilege that is not held is a no-op. Never applied by db:migrate or
-- createTestDb (PGlite has no anon/authenticated roles and no Data API).
--
-- The per-table list is the reviewable statement of intent; a test fails when it stops matching the
-- migrated tables. The ALL TABLES sweep and the default-privilege changes below
-- catch anything the list misses and every table created later by the postgres role.
-- A function added later needs its own REVOKE EXECUTE ... FROM PUBLIC: EXECUTE-to-PUBLIC is a global
-- default that a per-schema ALTER DEFAULT PRIVILEGES cannot remove.
--
-- Acceptance check, which needs a live Supabase project and cannot run locally: an anon-key
-- PostgREST request against any app table returns a denial.

-- Core tables
REVOKE ALL ON TABLE public.users FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.projects FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.analyses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.findings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.finding_lens_explanations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.comparisons FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.comparison_changes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.threads FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.thread_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_citations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.drafts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.draft_sections FROM PUBLIC, anon, authenticated;
-- Rate-limit and cache tables
REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ip_rate_limit_buckets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.global_llm_rate_limit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.analyzed_result_cache FROM PUBLIC, anon, authenticated;
-- migration runner's tracking table
REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, anon, authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Trigger functions. Not callable as RPCs anyway (a trigger function errors outside a trigger);
-- revoked so the post-condition below can be stated without exceptions.
REVOKE ALL ON FUNCTION public.findings_verified_ceiling() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.comparison_changes_verified_ceiling() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.message_citations_verified_ceiling() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.documents_input_mode_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.comparisons_document_pair_immutable() FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Positive post-condition: fail the migration (and roll it back) if either Data API role can still
-- touch any table, column, or app function in public — directly or through PUBLIC.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(format('%I.%I', r.rolname, c.relname), ', ' ORDER BY c.relname, r.rolname)
    INTO leaked
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r (rolname)
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
          OR has_any_column_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'M3 post-condition failed: Data API roles still hold table privileges: %', leaked;
  END IF;

  SELECT string_agg(format('%I.%s', r.rolname, p.oid::regprocedure), ', ')
    INTO leaked
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r (rolname)
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'M3 post-condition failed: Data API roles can still execute app functions: %', leaked;
  END IF;
END;
$$;
