# 0010. Guest data expires on a TTL, guest threads stay client-side, and claim locks in the sweep's order

Status: Accepted

## Context

Guests get the full product without an account, but their data must not outlive the promise that
unsaved guest data is deleted. When a guest signs in, their work should move to the new account.

Two jobs touch the same rows concurrently:

- the TTL sweep, which deletes expired guest rows;
- the claim, which re-owns rows to a user.

Taking row locks in different orders deadlocks them. The deletion rules add constraints of their
own: a comparison's documents are `RESTRICT`, and so is a draft's parent revision.

## Decision

- **Guest rows expire.** Documents, comparisons and drafts are database rows from creation, with a
  guest owner and an `expires_at` (a CHECK requires it for guest rows). A dependent row expires no
  later than what it references:
  - a comparison at `LEAST(documentA.expires_at, documentB.expires_at)`;
  - a grounded draft at its grounding document's expiry;
  - every draft revision at its chain root's expiry.
- **Guest threads are client-held.** They never exist as rows (`threads.owner_user_id` is NOT
  NULL). The client sends a bounded recent history with each `POST /api/ask`. Saving a thread
  imports it through `POST /api/threads`. The server discards every client-supplied status and
  verifies again. A citation whose source document is foreign, missing or malformed is imported
  unlinked, as `not_found`.
- **The sweep deletes leaves first.** It deletes comparisons, then drafts newest revision first,
  then documents, all in one transaction. It re-checks `expires_at < now()` at delete time.
- **Claim uses the same order.** It runs in one transaction. It re-checks expiry, then locks the
  guest's comparisons, then drafts leaf-first, then documents, in the sweep's own order, before any
  `UPDATE`. Each row's owner is set and `expires_at` is cleared in a single statement. A comparison
  is claimed only together with both its documents, and a revision only with its parent. Claim
  retries once on a deadlock error.
- **Saving clears the expiry.** Saving an item into a project clears its `expires_at` the same way,
  taking it out of the sweep's scope.
- **Storage refs keep their prefix.** A claimed document's storage ref keeps its `guest:<id>/`
  prefix. Access follows the row's current owner through `canAccess`, never the ref's name.

Code: [`claim.ts`](../../src/server/auth/claim.ts),
[`guest-thread-store.ts`](../../src/lib/guest-thread-store.ts),
[`prod-only/0002_m4_ttl_and_cleanup_functions.sql`](../../src/db/migrations/prod-only/0002_m4_ttl_and_cleanup_functions.sql).

## Consequences

- Claim and sweep cannot deadlock on well-formed data. One residual deadlock needs malformed data
  and is absorbed by the retry.
- PGlite runs one transaction at a time, so the tests committed here check lock order, not true
  interleaving. `scripts/pg-race-claim.ts` reproduces real interleavings against a local Postgres,
  on demand.
- The sweep runs as a `pg_cron` job that reaches Storage through `pg_net`. It is a prod-only
  migration and has not yet been applied to a live database.
- A claimed draft whose guest grounding document is later swept survives with its grounding set to
  NULL, which is a supported state.
