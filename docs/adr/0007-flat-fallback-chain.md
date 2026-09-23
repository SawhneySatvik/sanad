# 0007. One flat fallback chain under one deadline, with a circuit breaker per tier

Status: Accepted

## Context

Free-tier LLM access is unreliable:

- Gemini allows about 20 requests per model per day, so a single validation run can exhaust it.
- Individual calls sometimes fail in transit and succeed on retry.
- The backup gateways are unreliable. The NVIDIA NIM endpoint has hung without response headers,
  and OpenRouter's free Gemma pool answers 429 when busy.

A naive fallback compounds these waits: the primary's timeout, then each backup's full timeout.
It then reports the last backup's error, not the real cause. Falling back on every error also hides
our own bugs, because a malformed request "succeeds" on a more lenient model.

## Decision

- **One chain.** A single `FallbackLlmClient` holds an ordered list of tiers:
  1. `gemini-2.5-flash`, the primary;
  2. `gemini-3.5-flash-lite`, which has its own quota and reads native documents;
  3. Gemma on Google AI Studio;
  4. Gemma on NVIDIA NIM;
  5. Gemma on OpenRouter.
- **One deadline.** The operation's `timeoutMs` bounds the whole chain. While a later tier could
  still run, a tier may spend at most 75% (`TIER_BUDGET_SHARE`) of what is left. No tier or retry
  starts with under 15 s (`MIN_FALLBACK_BUDGET_MS`) remaining.
- **Primary errors.** A retryable error falls through to the next tier: a timeout, a 5xx, a
  provider 429, or no HTTP response at all. A non-retryable error surfaces as is and stops the
  chain: a 4xx, or output that fails the schema, since both mean our request is wrong.
- **Fallback errors.** On a fallback tier, **any** failure moves the chain on. One retired or
  incompatible backup must not stop the rest.
- **One retry without a response.** A call that got no HTTP response is retried once on the same
  tier before the chain falls through.
- **Circuit breakers.** Each tier has a breaker. Three consecutive provider failures open it for
  60 s, during which the tier is skipped without a call. Then one trial call closes it or re-opens
  it, and a failed trial doubles the window, up to 10 minutes. A provider 429 that names a per-day
  quota opens it at once for the full 10 minutes, and one that states a retry delay opens it at once
  for that delay: a quota that is gone should not cost every request a round-trip. Any other 4xx,
  a schema failure, our own rate limit and a cancelled call never count as failures. When every
  tier is open, the call fails at once, with the shortest remaining window as its retry-after.
- **Native documents.** A request that carries a native document skips tiers that cannot read one.
- **The real cause surfaces.** When every tier fails, the error returned is the primary's. For a
  tier skipped by its breaker, that is the error that opened the breaker. The exception is a
  fallback tier that failed with a real answer of its own: our `RATE_LIMITED`, or `SCHEMA_FAILED`.
- **`modelUsed` stays true.** It is always the answering tier's own model, and it is persisted, so
  a degraded answer is recorded as one. Verification is identical whichever tier answered.

Code: [`fallback.ts`](../../src/server/llm/fallback.ts),
[`circuit-breaker.ts`](../../src/server/llm/circuit-breaker.ts),
[`providers.ts`](../../src/server/llm/providers.ts).

## Consequences

- A user waits for at most one operation budget, for example 120 s for Understand, rather than a
  sum of timeouts.
- Our own schema or request bugs stay loud on the primary.
- Breaker state is in memory and per server instance, so a new instance relearns a dead gateway at
  the cost of a few calls.
- All five tiers need their keys: `GEMINI_API_KEY`, `NVIDIA_API_KEY` and `OPENROUTER_API_KEY`.
  Gemma on Google shares the Gemini key.
- In live validation the Gemma tiers have not yet answered. The second Gemini model is the fallback
  that works today (see [the live-validation report](../live-validation-report.md)).
