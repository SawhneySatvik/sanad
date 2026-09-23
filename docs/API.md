# HTTP API

Every route is a thin adapter built with `route()` from
[`handler.ts`](../src/server/http/handler.ts). It does four things:

1. validates the request against a zod contract;
2. resolves the caller's identity;
3. calls **exactly one** service-layer function;
4. maps the result through its response contract.

The contracts live in [`src/shared/contracts/`](../src/shared/contracts/). Route handlers and the
integration tests import the same definitions. A static check in
[`route-conventions.ts`](../tests/architecture/route-conventions.ts) keeps every route file to
this shape.

## Endpoints

"Principal" means a guest or a signed-in user. "User" means signed-in only. "LLM" marks routes that
call the model, which are charged against the per-principal and per-provider limits.

| Method | Path | Request | Response | Calls | Who | LLM |
|---|---|---|---|---|---|---|
| `POST` | `/api/uploads` | `CreateUploadTargetInput` | `UploadTargetOutput` | `storage.createUploadTarget` | principal | |
| `PUT` | `/api/uploads/relay` | `UploadRelayQuery` (signed token) + raw bytes | `UploadRelayOutput` | `storage.writeRelayed` (local relay only; production uploads go straight to a signed storage URL) | principal; the token's ref must belong to the caller | |
| `POST` | `/api/documents` | `AnalyzeDocumentInput` | `AnalyzeDocumentOutput` | `understand.analyze`: confirm the upload, extract, analyse, verify | principal | yes |
| `GET` | `/api/documents/:id` | — | `DocumentWithFindingsOutput` | `understand.get`: every quote re-verified | principal | |
| `POST` | `/api/documents/:id/analyze` | — | `DocumentWithFindingsOutput` | `understand.analyzeDocument`: idempotent retry of an incomplete analysis | principal | yes |
| `POST` | `/api/documents/:id/prepare` | `PrepareQuery` (optional `?lens=`) | `PrepareOutput` | `prepare.generate`: lawyer questions, checklist, Markdown export | principal | yes |
| `POST` | `/api/verify-batch` | `VerifyBatchInput` | `VerifyBatchOutput` | `verifyBatch.run`: fresh statuses for a reopened guest thread | principal, ownership checked per document | |
| `POST` | `/api/ask` | `AskGuestInput` (query, optional `documentIds` and bounded `history`) | event stream, then `AskMessageOutput` | `ask.ask`: an unsaved turn; nothing is persisted | principal | yes |
| `POST` | `/api/threads` | `CreateThreadInput` (optionally importing a guest thread) | `ThreadOutput` | `ask.createThread` | user | |
| `POST` | `/api/threads/:id/messages` | `AskMessageInput` | event stream, then `AskMessageOutput` | `ask.ask`: a turn on a saved thread | user, owner of the thread | yes |
| `GET` | `/api/threads/:id/messages` | `ListMessagesInput` (`?limit=`) | `MessagesOutput` | `ask.listRecentMessages`: citations re-verified | user, owner of the thread | |
| `POST` | `/api/comparisons` | `CreateComparisonInput` | `ComparisonOutput` | `compare.compare` | principal, owner of **both** documents | yes |
| `GET` | `/api/comparisons/:id` | — | `ComparisonWithChangesOutput` | `compare.get`: both sides re-verified | principal | |
| `POST` | `/api/drafts` | `CreateDraftInput` | `DraftOutput` | `draft.create` | principal; owner of the grounding document, if any | yes |
| `POST` | `/api/drafts/:id/revise` | `ReviseDraftInput` | `DraftOutput` | `draft.revise` | principal, owner of the parent draft | yes |
| `GET` | `/api/drafts/:id` | — | `DraftWithSectionsOutput` | `draft.get` | principal | |
| `POST` | `/api/projects` | `CreateProjectInput` | `ProjectOutput` | `projects.createProject` | user | |
| `GET` | `/api/projects` | — | `ProjectsListOutput` | `projects.listProjects` | principal (a guest gets an empty list) | |
| `GET` | `/api/projects/:id` | — | `ProjectDetailOutput` | `projects.getProject` | user, owner | |
| `POST` | `/api/documents/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the document and the project | |
| `POST` | `/api/comparisons/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the comparison and the project | |
| `POST` | `/api/drafts/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the draft's whole revision chain and the project | |
| `POST` | `/api/threads/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the thread and the project | |
| `POST` | `/api/auth/claim` | — (derived from the session) | `ClaimResultOutput` | `auth.claimGuestSession`: re-own guest documents, comparisons and drafts, then clear the guest cookie | signed-in user plus guest cookie; called once after sign-in | |
| `GET` | `/api/health` | — | `HealthOutput` | builds the providers and storage adapter to check configuration; no LLM call | anyone | |

### Guests and chat

An unsaved guest conversation exists only on the client, so there is no thread row to address. The
client calls `POST /api/ask` for each turn and sends a bounded recent history with it. Signing in
and saving imports the thread through `POST /api/threads`. The server discards any client-supplied
status and verifies again. Later turns use `POST /api/threads/:id/messages`. This asymmetry is
deliberate: guest chat never needs a server-side row.

### Upload flow

1. `POST /api/uploads` returns `{ method, uploadUrl, ref }`. Locally the method is `server-relay`.
2. The client sends the bytes to `uploadUrl`, which locally is `PUT /api/uploads/relay?token=…`.
3. `POST /api/documents` with `{ storageRef, filename, mimeType }` confirms the upload and starts
   the analysis.

The server reads the bytes through the storage ref and extracts the text itself. A client-supplied
string is never accepted as a document's text.

## Response conventions

- **Verification.** Every quote on the wire is a `VerificationOutput`:
  - `verified` carries `spanStart`, `spanEnd` and `spanText`, where `spanText` is cut from the
    document's own text;
  - `approximate` adds `claimedQuote`, the model's text;
  - `not_found` carries only `claimedQuote`.

  A verified passage never carries model text. Canonical text and storage refs never appear in a
  response.
- **AI text is labelled.** Every model-written field has a provenance sibling
  (`provenance: "ai_generated"`, or `"templated"` for fixed draft text). Streamed `token` events
  are an unlabelled live preview of the final message, which carries the label.
- **The model is always named.** Analyses, findings, assistant messages, comparisons, drafts and
  Prepare output carry `modelUsed`, so a fallback-model answer is always visible as one.
- **Not analysed is its own state.** A document with no analysis comes back as
  `analysisState: "not_analyzed"`, never as an empty findings list. Prepare has its own typed states
  for this: `not_analyzed` and `no_grounded_findings`.
- **Prepare's reader lens.** A `complete` Prepare result is written for one reader lens (role x
  stage — e.g. tenant, already signed) and echoes it as `lens: { id, role, stage }`, so the client
  can show who the output is for. The client picks it with `?lens=<id>` (for example
  `?lens=tenant_already_signed`); a lens that is not one of the document type's lenses is a 400.
  It defaults to the document's type's first lens, the same default
  Understand itself uses for a finding's own `explanation`. The Markdown export's header names the
  same perspective (`Prepared for: tenant, already signed`).
- **Streams.** `POST /api/ask` and `POST /api/threads/:id/messages` stream `token` events with
  answer text only, then one `final` event carrying the message with its verified citations. The
  first event is read before headers are sent, so an immediate failure is a real HTTP error status,
  never a 200 carrying an error. A failure after streaming has begun becomes a single `event: error`
  frame.

## Errors

Every error body has the same shape, `reason` and `retryAfterSeconds` both optional:

```json
{ "error": { "code": "INVALID_DOCUMENT", "message": "…fixed, per-code text…", "reason": "too_large" } }
```

```json
{ "error": { "code": "RATE_LIMITED", "message": "…fixed, per-code text…", "retryAfterSeconds": 12 } }
```

`reason` is set only on `INVALID_DOCUMENT`/`EXTRACTION_FAILED`; `retryAfterSeconds` appears whenever
a wait is known — always on `RATE_LIMITED`/`UPSTREAM_UNAVAILABLE`, and occasionally alongside another
retryable code (`TIMEOUT`) when the fallback chain's own per-tier circuit breakers name a longer wait
than the failure itself stated. No throw site sets both `reason` and `retryAfterSeconds` on the same
error, so the two never appear together. `retryAfterSeconds` mirrors the `Retry-After` header, rounded
up and omitted when it would be zero or negative — the body carries it too because an SSE error frame
has no headers of its own to read it from.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | The body or query fails its contract, the JSON content type is missing, or an input exceeds a cap |
| 403 | `FORBIDDEN` | A state-changing request with `Sec-Fetch-Site: cross-site`, refused before any cookie is read |
| 404 | `NOT_FOUND` | The resource is missing, **belongs to someone else**, or the id is malformed. All three responses are identical |
| 422 | `INVALID_DOCUMENT` / `EXTRACTION_FAILED` | Unsupported, oversized or unreadable upload — see the `reason` table below |
| 429 | `RATE_LIMITED` | A rate-limit tier is exhausted. Carries `retryAfterSeconds` |
| 502 | `SCHEMA_FAILED` | The model's answer failed its schema after one repair retry |
| 503 | `UPSTREAM_UNAVAILABLE` | Every model in the fallback chain failed. Provider exhaustion — every tier open or out of retries — is always this, never `429`: `429` stays exclusively for our own rate limiter. Carries `retryAfterSeconds` the same way `RATE_LIMITED` does |
| 504 | `TIMEOUT` | The operation's time budget ran out |
| 500 | `INTERNAL_ERROR` | Anything else, with a generic message |

For `POST /api/ask` and `POST /api/threads/:id/messages` (the streaming routes), a 429/503/504 that
fails before the first event is a normal HTTP response — status, `Retry-After` header and body all
present, exactly like any other route (see the Streams bullet below: the first event decides the
status, before anything is sent). A failure once streaming has begun has already committed its `200`,
so `retryAfterSeconds` reaches the client only in the `event: error` frame's own body — there is no
`Retry-After` header for a frame sent mid-stream.

### `reason` (set only on `INVALID_DOCUMENT`/`EXTRACTION_FAILED`)

A fixed, growing enum — every value is documented here, mapped by throw site rather than by
matching `Error#message` text:

| `reason` | When |
|---|---|
| `too_large` | An upload, a relay body, or a document's extracted/prompt text exceeds its cap (upload size, per-page or per-document char budget, a sandboxed parse's deadline/heap/memory limit) |
| `unsupported_type` | The declared mime type has no extractor (not a `.txt`/`.pdf`/`.docx`) |
| `type_mismatch` | The uploaded bytes don't match the declared mime type |
| `unreadable` | The bytes can't be parsed at all — invalid UTF-8, a corrupt PDF/DOCX, a crashed parser, a scanned document Understand can't transcribe |
| `empty` | Zero extractable characters, or a real zero-byte write past a positive declared size |
| `document_not_ready` | The document hasn't finished extraction (still `pending`) or extraction failed, and the request needs its `canonical_text` |
| `grounding_not_ready` | Draft's own grounding document isn't `ready` yet |
| `grounding_too_long` | The attached/grounding document(s) exceed the model's input budget |
| `sample_readonly` | A retry-analysis call targets a read-only sample document |

- **Nothing leaks.** The message text is fixed for each code. No error message, stack trace, SQL
  statement, zod issue or environment value reaches a response or a log line.
- **Correlation ids.** Every failure carries an `x-correlation-id` header that matches its
  server-side log line.
- **The retry handle.** When `POST /api/documents` fails after the caller's document row exists,
  the body adds `documentId`, so the analysis can be retried through
  `POST /api/documents/:id/analyze`.

## Rate limiting

Every route passes through `route()`, so no route can skip the limiter.

- **Per IP.** Charged once per request on **every** route (default 60/min).
- **Per principal.** Charged once per logical LLM call on the routes marked LLM above (default
  5/min). An Ask that uses two specialists plus synthesis costs three.
- **Global, per provider.** Charged for each tier the fallback chain actually calls.

The details are in [ADR 0005](adr/0005-three-tier-rate-limiting.md).
