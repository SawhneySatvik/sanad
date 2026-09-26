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
| `GET` | `/api/documents` | `ListQuery` (`?cursor=&limit=`, ≤ 50) | `DocumentListOutput` (`{ items, nextCursor }`) | `library.list`: newest-activity first | principal | |
| `POST` | `/api/documents` | `AnalyzeDocumentInput` | `AnalyzeDocumentOutput` | `understand.analyze`: confirm the upload, extract, analyse, verify | principal | yes |
| `GET` | `/api/documents/:id` | — | `DocumentWithFindingsOutput` | `understand.get`: every quote re-verified | principal | |
| `PATCH` | `/api/documents/:id` | `RenameInput` `{ title }` (≤ 120 chars, server-enforced) | `DocumentListRowOutput` | `library.rename` | owner | |
| `DELETE` | `/api/documents/:id` | — | `204` | `library.remove`: cascades comparisons that reference it; queues its storage object for cleanup | owner | |
| `DELETE` | `/api/documents/:id/project` | — | `DocumentListRowOutput` | `library.unassign`: detaches from its project, never restores a TTL | owner | |
| `GET` | `/api/documents/:id/delete-impact` | — | `DeleteImpactOutput` `{ comparisons, draftsUngrounded, threadsUnlinked }` | `library.deleteImpact`: dry-run count for a delete confirmation | owner | |
| `GET` | `/api/documents/:id/text` | — | `DocumentTextOutput` `{ documentId, text, textHash, inputMode, sampleId }` | `documentText.getText`: the document's own `canonical_text`, byte-exact | owner | |
| `POST` | `/api/documents/:id/analyze` | — | `DocumentWithFindingsOutput` | `understand.analyzeDocument`: idempotent retry of an incomplete analysis; refuses on a sample document | principal | yes |
| `POST` | `/api/documents/:id/prepare` | `PrepareQuery` (optional `?lens=`) | `PrepareOutput` | `prepare.generate`: lawyer questions, checklist, Markdown export | principal | yes |
| `POST` | `/api/samples/:sampleId/open` | `SampleIdParams` (a fixed registry id) | `SampleOpenOutput` `{ documentId }` | `samples.openSample`: replays one of five recorded analyses, no model call | principal | |
| `POST` | `/api/verify-batch` | `VerifyBatchInput` | `VerifyBatchOutput` | `verifyBatch.run`: fresh statuses for a reopened guest thread | principal, ownership checked per document | |
| `POST` | `/api/ask` | `AskGuestInput` (query, optional `documentIds` and bounded `history`) | event stream, then `AskMessageOutput` | `ask.ask`: an unsaved turn; nothing is persisted | principal | yes |
| `GET` | `/api/threads` | `ListQuery` | `ThreadListOutput` (a guest gets an empty list) | `library.list` | principal | |
| `POST` | `/api/threads` | `CreateThreadInput` (optionally importing a guest thread) | `ThreadOutput` | `ask.createThread` | user | |
| `PATCH` | `/api/threads/:id` | `RenameInput` `{ title }` | `ThreadListRowOutput` | `library.rename` | owner | |
| `DELETE` | `/api/threads/:id` | — | `204` | `library.remove`: messages and citations cascade | owner | |
| `DELETE` | `/api/threads/:id/project` | — | `ThreadListRowOutput` | `library.unassign` | owner | |
| `POST` | `/api/threads/:id/messages` | `AskMessageInput` | event stream, then `AskMessageOutput` | `ask.ask`: a turn on a saved thread | user, owner of the thread | yes |
| `GET` | `/api/threads/:id/messages` | `ListMessagesInput` (`?limit=`) | `MessagesOutput` | `ask.listRecentMessages`: citations re-verified | user, owner of the thread | |
| `GET` | `/api/comparisons` | `ListQuery` | `ComparisonListOutput` | `library.list` | principal | |
| `POST` | `/api/comparisons` | `CreateComparisonInput` | `ComparisonOutput` | `compare.compare` | principal, owner of **both** documents | yes |
| `GET` | `/api/comparisons/:id` | — | `ComparisonWithChangesOutput` | `compare.get`: both sides re-verified | principal | |
| `PATCH` | `/api/comparisons/:id` | `RenameInput` `{ title }` | `ComparisonListRowOutput` | `library.rename` | owner | |
| `DELETE` | `/api/comparisons/:id` | — | `204` | `library.remove`: changes cascade; the two documents are untouched | owner | |
| `DELETE` | `/api/comparisons/:id/project` | — | `ComparisonListRowOutput` | `library.unassign` | owner | |
| `GET` | `/api/drafts` | `ListQuery` | `DraftListOutput` (one row per revision chain: its latest revision) | `library.list` | principal | |
| `POST` | `/api/drafts` | `CreateDraftInput` | `DraftOutput` | `draft.create` | principal; owner of the grounding document, if any | yes |
| `GET` | `/api/drafts/:id` | — | `DraftWithSectionsOutput` | `draft.get` | principal | |
| `PATCH` | `/api/drafts/:id` | `RenameInput` `{ title }` | `DraftListRowOutput` | `library.rename`: writes the title to **every row in the chain** | owner | |
| `DELETE` | `/api/drafts/:id` | — | `204` | `library.remove`: deletes the **whole revision chain**, leaf first | owner | |
| `DELETE` | `/api/drafts/:id/project` | — | `DraftListRowOutput` | `library.unassign`: applies to the whole chain | owner | |
| `GET` | `/api/drafts/:id/revisions` | — | `DraftRevisionsOutput` `{ items }` | `library.revisions`: every revision in the chain, creation-ordered, `isCurrent`/`isLatest` flags | owner | |
| `POST` | `/api/drafts/:id/revise` | `ReviseDraftInput` | `DraftOutput` | `draft.revise` | principal, owner of the parent draft | yes |
| `POST` | `/api/projects` | `CreateProjectInput` | `ProjectOutput` | `projects.createProject` | user | |
| `GET` | `/api/projects` | — | `ProjectsListOutput` (`{ projects }` — the one list route that predates, and keeps, the older envelope) | `projects.listProjects` | principal (a guest gets an empty list) | |
| `GET` | `/api/projects/:id` | — | `ProjectDetailOutput` | `projects.getProject` | user, owner | |
| `PATCH` | `/api/projects/:id` | `RenameProjectInput` `{ name }` (≤ 255 chars, server-enforced) | `ProjectOutput` | `library.rename` | owner | |
| `DELETE` | `/api/projects/:id` | — | `204` | `library.remove`: items are unassigned (`project_id` set null), never deleted | owner | |
| `POST` | `/api/documents/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the document and the project | |
| `POST` | `/api/comparisons/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the comparison and the project | |
| `POST` | `/api/drafts/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the draft's whole revision chain and the project | |
| `POST` | `/api/threads/:id/save-to-project` | `SaveToProjectInput` | `SaveToProjectOutput` | `projects.saveToProject` | user, owner of the thread and the project | |
| `DELETE` | `/api/me/data` | — | `DeleteAllOutput` `{ deleted: { documents, comparisons, drafts, threads, projects } }` | `library.deleteAll`: everything the principal owns, across all five types; a guest's cookie is cleared after | principal | |
| `POST` | `/api/auth/claim` | — (derived from the session) | `ClaimResultOutput` | `auth.claimGuestSession`: re-own guest documents, comparisons and drafts, then clear the guest cookie | signed-in user plus guest cookie; called once after sign-in | |
| `GET` | `/api/session` | — | `SessionOutput` `{ kind, displayName?, signInAvailable, guestTtlHours }` | `session.getSession`: no ids, emails or tokens on the wire | principal | |
| `POST` | `/api/session/sign-out` | — | `SessionOutput` | `session.signOut`: clears the user-session cookie; a fresh guest session is minted lazily on the next request | principal | |
| `POST` | `/api/auth/dev-sign-in` | `DevSignInInput` `{ displayName }` | `SessionOutput` | `session.devSignIn`: dev-only stand-in for a real OAuth sign-in; **404s in production** | principal | |
| `GET` | `/api/health` | — | `HealthOutput` | builds the providers and storage adapter to check configuration; no LLM call | anyone | |
| `GET` | `/api/e2e/ping` | — | `HealthOutput` | `e2e.ping`: the e2e harness's own readiness probe; **404s outside `SABOOT_E2E=1`, and that flag is itself refused in production** | anyone, e2e harness only | |
| `GET` | `/api/e2e/throw` | — | — (always throws) | `e2e.forceThrow`: a deliberate failure for error-boundary tests; same dev/e2e-only refusal as `/api/e2e/ping` | anyone, e2e harness only | |

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

### List responses, rename and delete

Every `GET` that returns a collection (documents, comparisons, drafts, threads) answers
`{ items: T[], nextCursor: string | null }`, newest-activity first (`updatedAt` desc, `id` as the
tiebreak); the cursor is an opaque token, not a page number. `GET /api/projects` is the one
pre-existing exception, and keeps its own `{ projects: ProjectOutput[] }` shape. **A list row never
carries a verification status, a quote, a span or model text** — an exact-key contract test pins
this (a field like `processingStatus` is legal; a bare `status`/`verification`/`spanText` key is
not).

Rename (`PATCH`) is server-capped independently of each contract's outer sanity bound: documents,
comparisons, drafts and threads at 120 characters; projects at 255 — both trimmed, with control and
bidi characters stripped, same as everywhere else user text is stored. A draft's rename writes the
new title onto **every row in its revision chain**, in one transaction, because the library only
ever shows a chain's latest revision under one shared title.

Delete cascades follow the FK behaviour in [docs/SCHEMA.md](SCHEMA.md#delete-behaviour): deleting a
document first deletes every comparison that references it; deleting a draft deletes its whole
revision chain; deleting a project only unassigns its items (`project_id` set to null) and never
deletes them or restores a TTL. `GET /api/documents/:id/delete-impact` is the dry-run companion a
delete confirmation needs before the user commits to it; the other three types use fixed
confirmation copy client-side instead (a draft's dialog states its revision count from
`DraftListRowOutput.revisionCount`).

## Response conventions

- **Verification.** Every quote on the wire is a `VerificationOutput`:
  - `verified` carries `spanStart`, `spanEnd` and `spanText`, where `spanText` is cut from the
    document's own text;
  - `approximate` adds `claimedQuote`, the model's text;
  - `not_found` carries only `claimedQuote`.
  - **`textHash`** is set on all three: the source document's `canonical_text_hash` when a real
    document backs the verification, or the fixed anti-oracle sentinel `sha256("")` =
    `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` whenever there is no real
    document at all (an unlinked citation, a foreign or deleted source) — never a distinguishable
    value that would let a client tell "no document" apart from "a document I can't read."

  A verified passage never carries model text. Canonical text and storage refs never appear in a
  response, with one exception: `GET /api/documents/:id/text`'s `DocumentTextOutput.text`, which
  *is* the document's `canonical_text`, byte-for-byte — the one field the wire-contract lint allows
  to carry it, because the client-side highlighter (`bindSpan()`) needs the exact text `verify()`
  matched against, not a sanitised copy of it.
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

## Samples

`POST /api/samples/:sampleId/open` accepts only a fixed registry id (`lease`, `offer_letter`, `nda`,
`privacy_policy`, `freelance`) — never a file, text or a model output — and can never become an
analysis cache or a content oracle. It replays one of five recordings of a real, previously-captured
model response through the real Understand service, so the resulting findings are persisted and
re-verified exactly like a live analysis; the only difference is that no model is called. Opening a
sample the caller already holds, unexpired, returns that same copy rather than creating a second one.
An unknown or not-yet-recorded sample id (the Compare sample, `lease_v2`, is deferred) returns `404`.
`sampleId` is echoed on `DocumentOutput`, so the client can honestly label a recorded analysis;
`POST /api/documents/:id/analyze` on a sample document refuses with `422 INVALID_DOCUMENT` /
`sample_readonly` rather than silently turning a recorded analysis into a live one still labelled
"recorded."

## Session and dev sign-in

`GET /api/session` returns a client-facing summary only — `kind` (`"guest" | "user"`), an optional
`displayName`, `signInAvailable` and `guestTtlHours` — never an id, email or token; identity itself
stays server-side in the signed cookie. `signInAvailable` is `false` in a production build, because
`POST /api/auth/dev-sign-in` is a **development stand-in for real OAuth**, not a production sign-in
path: it throws at construction and 404s when `NODE_ENV === "production"`, and a cookie signed with
its non-production fallback secret is refused by the resolver even if one somehow reached a
production request. `POST /api/session/sign-out` clears the user-session cookie; a fresh guest
session is minted lazily on the next principal-resolving request, not by this route itself. Sign-in,
sign-out, claim and delete-all are broadcast to every open tab over `BroadcastChannel("saboot:session")`
(a client-side contract, not a route), so a session change in one tab is reflected in every other tab
without a reload.

## Document text, caching and the anti-oracle sentinel

`GET /api/documents/:id/text` answers `Cache-Control: no-store`, with **no `ETag` and no `304`
path at all** — a stale `If-None-Match` on an otherwise-valid request changes nothing, and `canAccess`
runs on every request because there's no conditional-GET short-circuit that could bypass it. A
document that hasn't finished extraction (`pending` or `extraction_failed`) answers `422
INVALID_DOCUMENT` / `document_not_ready` rather than a 200 with an empty string. A scanned
(`native_document`) document's text is the model's own transcription, not independent evidence; the
response says so through `inputMode`, and the client is expected to label it accordingly rather than
treat it as ordinary document text.

## Rate limiting

Every route passes through `route()`, so no route can skip the limiter.

- **Per IP.** Charged once per request on **every** route (default 60/min).
- **Per principal.** Charged once per logical LLM call on the routes marked LLM above (default
  5/min). An Ask that uses two specialists plus synthesis costs three.
- **Global, per provider.** Charged for each tier the fallback chain actually calls.

The details are in [ADR 0005](adr/0005-three-tier-rate-limiting.md).
