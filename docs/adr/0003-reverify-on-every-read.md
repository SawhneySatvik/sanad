# 0003. Stored statuses are audit fields; every read re-verifies against the live canonical text

Status: Accepted

## Context

A status stored at write time can go stale. Four things can make it wrong later:

- the verifier's rules change;
- a row is edited directly;
- a cached model response is replayed;
- a guest's browser returns a status it saved earlier.

If any read path trusts a stored or client-held status, the guarantee that `verified` means "checked
just now against the text shown" no longer holds.

## Decision

- `findings.verification_status`, `message_citations.verification_status` and
  `comparison_changes.verification_status_{a,b}` are written, along with their spans and
  `verifier_version`, **for audit only**. No read path returns them.
- Every read that returns a status (`GET /api/documents/:id`, `GET /api/comparisons/:id`,
  `GET /api/threads/:id/messages`, Prepare) runs `verify()` again against the document's current
  `canonical_text` and returns only that fresh result.
- `analyzed_result_cache` stores the model's **raw, pre-verification output only**. Its table has
  no status column. A cache hit skips the LLM call; it never skips `verify()`.
- A reopened guest thread sends its quotes to `POST /api/verify-batch` and renders only the
  statuses it gets back. The service checks ownership before it reads any text. For a document the
  caller cannot use, it answers `not_found` and adds a fixed response floor, so the endpoint cannot
  be used to probe whether a document contains a given string.
- On guest-thread import, the server discards every client-supplied status and verifies again.

Code: [`understand.ts`](../../src/server/services/understand.ts) (`get`),
[`verify-batch.ts`](../../src/server/services/verify-batch.ts).

## Consequences

- A verifier upgrade takes effect on the next read, with no backfill. Nothing can go stale,
  because nothing stored is trusted.
- Reads cost CPU. Ask bounds this by re-verifying at most 100 citations per read, oldest whole
  messages dropped first. `verify-batch` caps each batch at 50 quotes across 5 documents.
- Tests prove the rule in both directions:
  - a verified row tampered to `not_found` with raw SQL still reads `verified`;
  - a fabricated quote the model marks verified is stored and returned `not_found`.
