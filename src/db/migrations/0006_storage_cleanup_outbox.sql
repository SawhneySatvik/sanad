-- A delete transaction queues the storage ref before removing its document row, so a failed
-- object deletion leaves a durable retry target. The worker checks for a live document ref before
-- purging, because a ref can be reused while cleanup is pending.
CREATE TABLE storage_cleanup_outbox (
  storage_ref text CONSTRAINT storage_cleanup_outbox_pkey PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.storage_cleanup_outbox FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.storage_cleanup_outbox'::regclass
       AND c.conname = 'storage_cleanup_outbox_pkey'
       AND c.contype = 'p'
       AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (storage_ref)'
  ) THEN
    RAISE EXCEPTION 'storage cleanup outbox post-condition failed: storage_ref primary key missing';
  END IF;
END;
$$;
