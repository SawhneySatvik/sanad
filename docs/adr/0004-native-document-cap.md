# 0004. Scanned documents can never reach `verified`

Status: Accepted

## Context

A scanned or image-only PDF has no text layer. Its `canonical_text` is the model's own
transcription (`input_mode = 'native_document'`). If `verify()` checked a quote against that
transcription, it would be checking the model against itself: the result is not independent
evidence.

## Decision

- `verify()` takes the document's input mode as a required argument. An exact match against
  anything other than `text` returns `approximate`, never `verified`. This cap lives inside
  `verify()`, so it applies to every render and every re-verification, not only to writes.
- The database adds a second layer. `BEFORE INSERT OR UPDATE` triggers on `findings`,
  `comparison_changes` and `message_citations` reject `verified` unless the source document is
  `processing_status = 'ready'` and `input_mode = 'text'`.
- Two more triggers stop a verified row from moving onto a different document afterwards:
  - `documents.input_mode` is immutable once set;
  - a comparison's document pair is immutable.
- `VerifyResult` records the input mode (see [0001](0001-branded-verify-result.md)), so a caller
  cannot pass `"text"` for a scanned document and persist the result.
- A service checks the LLM client's `nativeDocumentInput` capability before it sends a file. The
  fallback chain skips tiers that cannot read one.

Code: [`verify.ts`](../../src/server/deterministic/verify/verify.ts),
[`0001_core_schema.sql`](../../src/db/migrations/0001_core_schema.sql).

## Consequences

- Scanned documents still get findings with highlighted spans, labelled `approximate`.
- Every call site has to pass the input mode. The type system requires it, so it cannot be
  forgotten.
- One case is not covered. A PDF whose text layer came from third-party OCR, or that carries
  invisible text, extracts as `text` and can reach `verified`. Detecting PDF text render mode 3 and
  capping those documents is the candidate fix.
