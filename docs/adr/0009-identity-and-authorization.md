# 0009. Identity comes only from a signed cookie; every access goes through one chokepoint; foreign resources are 404

Status: Accepted

## Context

The product is guest-first: anyone can upload and analyse a document without signing in. Guest
identity is therefore the most exposed authentication surface. A client-supplied identity header,
such as `X-User-Id`, can be spoofed trivially.

Authorization spread across many repository methods eventually misses one. The most likely miss is
an operation that links two entities, such as comparing document A with document B, where only one
side is checked.

## Decision

- **Identity.** A guest principal comes only from an httpOnly, HMAC-signed session cookie holding
  a CSPRNG session id. A user principal comes only from the auth adapter's verified claim. No
  header, query parameter or body field sets identity. Rotating `GUEST_SESSION_SECRET` is
  supported through a verify-only `GUEST_SESSION_SECRET_PREVIOUS`.
- **One chokepoint.** `canAccess(principal, resource)` is pure and synchronous, with no I/O, so it
  cannot fail open on a database error. Every repository function takes `(db, principal, …)` and
  calls it. A row with no owner, or with two, is never accessible.
- **Every entity in an association is checked.** An operation that associates entities checks all
  of them (`assertCanAccessAll`): both documents of a comparison, the grounding document of a
  draft, the project and item in save-to-project.
- **404, never 403.** A foreign, missing or malformed id returns the same byte-identical
  `404 NOT_FOUND`, because a 403 would confirm the resource exists.
- **Cross-site refusal.** A state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) with
  `Sec-Fetch-Site: cross-site` is refused with a fixed 403 before any cookie is read or minted.
- **Claim is the only dual-identity route.** `POST /api/auth/claim` alone may see both identities,
  and a static route check enforces that no other route can.

Code: [`access.ts`](../../src/server/data/access.ts),
[`session.ts`](../../src/server/auth/session.ts),
[`handler.ts`](../../src/server/http/handler.ts).

## Consequences

- One function to audit. A third principal type, such as a team member or an API key, changes
  `canAccess`, not every call site.
- The IDOR suite (`npm run test:idor`) gives every principal-scoped route and repository the same
  test shape: a foreign id, a missing id and a malformed id are the same 404, and a positive control
  shows the owner succeeds.
- Outside production, a missing `GUEST_SESSION_SECRET` falls back to an ephemeral per-process
  secret with a one-time warning. In production, a missing or short secret is a startup error.
- Guest rows that have expired but not yet been swept are still readable by their own guest until
  the sweep runs. Writes that would create a child of an expired row are rejected.
