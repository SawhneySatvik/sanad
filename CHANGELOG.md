# Changelog

There are no numbered releases yet. This groups what has shipped by capability, drawn from the
commit history — read [docs/PRODUCT.md](docs/PRODUCT.md) for scope and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it holds together.

## Analysis and verification (Understand)

- Server-side document extraction (PDF/DOCX/plain text), document-type detection and clause
  segmentation — all model-independent.
- `verify()`, the One Guarantee's own matcher: a quote is only ever labelled verified against the
  document's own stored text, re-checked on every read.
- A deterministic standard-clause checklist that flags a document type's normally-expected
  protections when Understand's own findings don't already cover them.
- A document-type confidence score that counts distinct concepts rather than raw keyword hits, so
  thin evidence doesn't force a commitment to the wrong type.
- Five pre-analysed sample documents, replayed through the real pipeline rather than served as
  static fixtures.
- A document-text endpoint and a stored text hash on every verification, so a stale document can
  never be shown as freshly verified.
- The analysis workspace screen, and a verification UI kit shared across every screen that shows a
  verified/approximate/not-found badge.

## Ask

- A deterministic classifier with a capped specialist fan-out and one final, verified synthesis per
  turn.
- The classifier redirects a question to "not legal" only on positive evidence, rather than by
  default.
- A fallback chain (a second model tier, then a further provider via two gateways) that answers
  instead of failing outright, with a circuit breaker per tier and a per-operation timeout budget.
- The chat screen, with fixes for a working Retry action, answers that used to hang, and an honest
  verifier throttle.

## Compare

- A hybrid design: deterministic clause alignment between two documents, with one model call per
  pair to explain each change in plain language.
- Compare stopped reporting a clause as removed when it is, in fact, still present elsewhere in the
  new document.
- The Compare screen: pick two documents, see every change bound to its own side.

## Prepare

- Grounded lawyer questions and a checklist generated only from a document's own already-verified
  findings, with a Markdown export.
- Output written for the reader's actual situation (about to sign vs. already signed), not a
  generic template.
- The Prepare screen: questions and a checklist to take to a lawyer.

## Draft

- Template-backed drafting with a revision chain and a provenance label on every section, so an
  AI-written passage is never visually identical to a templated one.
- Every draft section states what it is, and its contract names exactly one governing forum.

## Library and projects

- A projects repository, save-to-project, and a guest-to-account claim flow that preserves
  ownership.
- A storage-cleanup outbox: a deleted file's bytes stay queued until they are actually purged,
  never left dangling.
- Postgres-backed file storage for serverless deployment, alongside the local filesystem adapter.
- A guest-data expiry sweep that deletes a guest's stored bytes in the same transaction as their
  rows.
- The library screens and their APIs, upload components, and the app shell and landing page.

## Security hardening

- Guest identity as a signed, httpOnly, CSPRNG-generated cookie, checked through one `canAccess`
  chokepoint everywhere.
- Three independent rate-limit tiers (per principal per model call, per IP, and a global
  per-provider cap), each an atomic increment.
- Cross-site state-changing requests are refused before any cookie is read or minted.
- Document extraction runs isolated and bounded (byte/page/decompression caps, a resource-limited
  worker thread), and bidirectional-control characters are stripped from model text.
- HTTP edge and configuration hardening: security headers on every response, explicit
  trusted-proxy configuration, and fixed, honest error reasons instead of leaked exception detail.
- A per-IP call limit and daily provider caps, so a single caller — or a quota outage — can't
  exhaust the shared budget silently.
- A fixed reason on every document-rejection error, and a 503 (rather than a misleading success)
  when every provider tier is exhausted.

## Accessibility

- An axe-core-backed Playwright harness (`npm run test:a11y`), with specs tagged `@a11y` alongside
  the ordinary end-to-end suite.
