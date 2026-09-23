# 0005. Three rate-limit tiers: per principal per LLM call, per IP, and global per provider

Status: Accepted

## Context

Three constraints shape the rate limiting:

- **Anyone can mint a guest identity.** A script can drop its cookie and get a fresh
  per-principal quota.
- **The LLM quota is shared.** Several well-behaved users in the same minute can exhaust the
  provider's quota without any one of them abusing it.
- **One request can make several LLM calls.** An Ask with two specialists plus synthesis is three
  calls. A per-request limit would therefore let one guest spend several times their share.

## Decision

Three tiers, each a fixed one-minute window:

| Tier | Key | Charged | Default |
|---|---|---|---|
| Principal | `user:<id>` or `guest:<session>` | once per **logical LLM call**, outside the fallback chain, so a fallback is not charged twice | 5/min |
| IP | HMAC of the canonicalized client IP; raw IPs are never stored | once per inbound request, on **every** route | 60/min |
| Global | provider (`gemini`, `gemma`) | per tier the fallback chain actually calls; a retry is charged again, a tier skipped by its breaker is not | provider quota ÷ attempts per call |

- **Every increment is atomic.** Each is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`,
  autocommit, never read-then-write and never inside a transaction that spans an LLM call.
- **Principal below global.** The principal default sits below the global Gemini limit, so one
  principal cannot consume the shared quota alone.
- **Overrides.** Every default can be set through `RATE_LIMIT_*_PER_MINUTE`.
- **Client IP.** IPv4-mapped IPv6 addresses are canonicalized, and privacy-rotated IPv6 addresses
  are grouped, so neither lands in a fresh bucket. An unparseable IP shares a single fail-closed
  bucket. On Vercel, only `x-vercel-forwarded-for` is trusted.

Code: [`limiter.ts`](../../src/server/rate-limit/limiter.ts),
[`rate-limited-llm-client.ts`](../../src/server/rate-limit/rate-limited-llm-client.ts).

## Consequences

- An over-limit call fails fast with `RATE_LIMITED`, before the provider is contacted. JSON routes
  add a `retry-after` header; the streaming Ask routes return 429 without one.
- Fixed windows allow roughly 2× the nominal limit by timing requests across a window edge. This is
  accepted at this scale.
- A multi-call Ask that runs out of principal budget partway through fails as a whole. The calls it
  already made are spent.
- Many users behind one NAT, such as a demo room, may need `RATE_LIMIT_IP_PER_MINUTE` raised.
- The race tests (`npm run test:rate-limit`) run concurrent increments and assert that no request is
  double-counted and none is lost.
