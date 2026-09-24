-- Postgres-backed object store: on Vercel, each function instance has its own ephemeral disk, so an
-- upload's create-target/relay/analyse steps (each possibly a different instance) can't share
-- LocalFsStorageAdapter's filesystem. This table holds the same round trip's state and bytes durably,
-- one row per ref, so any instance can serve any step.
--
-- bytes is NULL until writeRelayed writes it once (application-level single-write, matching the local
-- adapter's exclusive-create semantics — enforced by an atomic conditional UPDATE, not a DB trigger).
-- confirmed_at is the one-shot marker: NULL until confirmUpload's atomic conditional UPDATE sets it,
-- and never again after.
--
-- filename/mime_type are nullable: writeRelayed can originate a row itself (the samples-open flow
-- mints a ref with buildRef and calls writeRelayed directly, never createUploadTarget — see
-- samples/open.ts), and such a row carries no declared filename/type. confirmUpload requires both
-- non-null, so a row never created through createUploadTarget can never be confirmed — matching the
-- local adapter, where confirmUpload fails without an upload-record sidecar file.
CREATE TABLE storage_objects (
  storage_ref text CONSTRAINT storage_objects_pkey PRIMARY KEY,
  owner_principal_key text NOT NULL,
  filename text,
  mime_type text,
  declared_size_bytes integer NOT NULL,
  bytes bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT storage_objects_declared_size_bytes_positive_check CHECK (declared_size_bytes > 0),
  -- canAccess-style blank guard (documents_owner_guest_session_id_not_blank_check's pattern): an
  -- empty owner_principal_key must never compare equal to another empty one.
  CONSTRAINT storage_objects_owner_principal_key_not_blank_check CHECK (owner_principal_key ~ '[^[:space:]]'),
  CONSTRAINT storage_objects_confirmed_requires_bytes_check CHECK (confirmed_at IS NULL OR bytes IS NOT NULL),
  CONSTRAINT storage_objects_filename_iff_mime_type_check CHECK ((filename IS NULL) = (mime_type IS NULL)),
  CONSTRAINT storage_objects_confirmed_requires_upload_record_check CHECK (confirmed_at IS NULL OR filename IS NOT NULL)
);

REVOKE ALL ON TABLE public.storage_objects FROM PUBLIC;

-- The TTL sweep's due-selection query for uploads never confirmed (PostgresStoragePurger.purgeUnconfirmedUploads).
CREATE INDEX storage_objects_unconfirmed_due_idx
  ON public.storage_objects (created_at)
  WHERE confirmed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.storage_objects'::regclass
       AND c.conname = 'storage_objects_pkey'
       AND c.contype = 'p'
       AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (storage_ref)'
  ) THEN
    RAISE EXCEPTION 'storage objects post-condition failed: storage_ref primary key missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'storage_objects_unconfirmed_due_idx'
       AND indexdef = 'CREATE INDEX storage_objects_unconfirmed_due_idx ON public.storage_objects USING btree (created_at) WHERE (confirmed_at IS NULL)'
  ) THEN
    RAISE EXCEPTION 'storage objects post-condition failed: unconfirmed-due index shape differs';
  END IF;
END;
$$;
