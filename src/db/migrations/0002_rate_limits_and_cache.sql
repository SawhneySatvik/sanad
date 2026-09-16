-- Rate-limit buckets (per principal, per IP, global per LLM provider) and the analyzed-result cache.
-- Hand-written.
--
-- All three bucket tables are written ONLY with the atomic
--   INSERT ... ON CONFLICT (<pk>) DO UPDATE SET request_count = <table>.request_count + 1 ... RETURNING
-- pattern, never read-then-write, so concurrent requests can neither lose nor double-count an
-- increment. The composite PK is the conflict target and the lookup index; no other index is needed.
-- The prod-only cleanup job prunes these rows by updated_at.

CREATE TABLE rate_limit_buckets (
  principal_key text NOT NULL,
  window_key text NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (principal_key, window_key)
);

-- ip_key is a hash of the client IP, never the raw address.
CREATE TABLE ip_rate_limit_buckets (
  ip_key text NOT NULL,
  window_key text NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ip_rate_limit_buckets_pkey PRIMARY KEY (ip_key, window_key)
);

CREATE TABLE global_llm_rate_limit (
  provider_key text NOT NULL,
  window_key text NOT NULL,
  request_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_llm_rate_limit_pkey PRIMARY KEY (provider_key, window_key)
);

-- Raw PRE-verification model output only; there is deliberately no status column: a cache hit is
-- verified again against the live canonical_text on every read, so a cached result can never carry a
-- trusted status.
-- expires_at is NOT NULL: every row must carry an expiry, capped by the writer to the source
-- document's own expires_at for guest uploads, so a cache entry never outlives the guest data it was
-- derived from. A forgotten expiry fails the insert instead of silently retaining a guest's document
-- excerpts forever.
CREATE TABLE analyzed_result_cache (
  cache_key text PRIMARY KEY,
  raw_model_output text NOT NULL,
  model_used text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX analyzed_result_cache_expires_at_idx ON analyzed_result_cache (expires_at);
