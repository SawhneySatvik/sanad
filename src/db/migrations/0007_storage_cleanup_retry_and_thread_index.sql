-- Keep acknowledged refs as tombstones: a later document insert must not reuse bytes that are
-- being deleted or have been purged. Existing queued rows remain pending and immediately due.
ALTER TABLE public.storage_cleanup_outbox
  ADD COLUMN purged_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT storage_cleanup_outbox_attempt_count_check CHECK (attempt_count >= 0);

-- Due work can be selected in bounded batches without a failed oldest row starving later refs.
CREATE INDEX storage_cleanup_outbox_due_idx
  ON public.storage_cleanup_outbox (next_attempt_at, created_at, storage_ref)
  WHERE purged_at IS NULL;

-- Tombstones are retained, so the insert guard needs a direct lookup as the history grows.
CREATE INDEX storage_cleanup_outbox_storage_ref_lower_idx
  ON public.storage_cleanup_outbox (lower(storage_ref));

-- A row-level AFTER trigger sees the outbox after an insert has waited for a conflicting old
-- documents.storage_ref unique key to be deleted. It rejects both pending and purged refs.
CREATE FUNCTION public.documents_storage_ref_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.storage_cleanup_outbox
     WHERE lower(storage_ref) = lower(NEW.storage_ref)
  ) THEN
    RAISE EXCEPTION 'storage reference unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'documents_storage_ref_tombstone_guard';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.documents_storage_ref_tombstone_guard() FROM PUBLIC;

CREATE TRIGGER documents_storage_ref_tombstone_guard
  AFTER INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_storage_ref_tombstone_guard();

-- Thread keyset pages scan a single user's rows by activity and use id to break ties.
CREATE INDEX threads_owner_user_id_updated_at_id_idx
  ON public.threads (owner_user_id, updated_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'storage_cleanup_outbox_due_idx'
       AND indexdef = 'CREATE INDEX storage_cleanup_outbox_due_idx ON public.storage_cleanup_outbox USING btree (next_attempt_at, created_at, storage_ref) WHERE (purged_at IS NULL)'
  ) THEN
    RAISE EXCEPTION 'storage cleanup retry post-condition failed: due index shape differs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.documents'::regclass
       AND t.tgname = 'documents_storage_ref_tombstone_guard'
       AND t.tgfoid = 'public.documents_storage_ref_tombstone_guard()'::regprocedure
       AND t.tgtype = 5 AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'storage cleanup retry post-condition failed: after-insert guard missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'storage_cleanup_outbox_storage_ref_lower_idx'
       AND indexdef = 'CREATE INDEX storage_cleanup_outbox_storage_ref_lower_idx ON public.storage_cleanup_outbox USING btree (lower(storage_ref))'
  ) THEN
    RAISE EXCEPTION 'storage cleanup retry post-condition failed: tombstone lookup index shape differs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'threads_owner_user_id_updated_at_id_idx'
       AND indexdef = 'CREATE INDEX threads_owner_user_id_updated_at_id_idx ON public.threads USING btree (owner_user_id, updated_at DESC, id DESC)'
  ) THEN
    RAISE EXCEPTION 'storage cleanup retry post-condition failed: thread activity index shape differs';
  END IF;
END;
$$;
