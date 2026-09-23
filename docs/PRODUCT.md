# Lawyer Up V3: product scope

Lawyer Up helps people in India understand, compare and respond to the legal documents in their
lives: rental agreements, offer letters, NDAs, privacy policies and freelance contracts. It
explains what a document says and shows exactly where it says it. It does not replace a lawyer and
never gives legal advice.

The product's name is **Saboot** (सबूत, "proof"): every claim it makes comes with proof from the
user's own document. The repository keeps its working name, `lawyer-up-v3`.

The backend is built: the domain core, data layer, LLM layer, orchestrator and HTTP API. The web
frontend is being built now, against the contracts in [API.md](API.md).

## Who it is for

Indian consumers, tenants, employees and freelancers. Jurisdiction is national (`IN`); state-level
detail is out of scope for now.

Five document types are deeply tuned:

- leave-and-license (rental) agreement;
- job offer letter;
- NDA;
- privacy policy;
- freelance service agreement.

Anything else is detected as `generic` and still analysed. Drafting adds a sixth category,
`grounded_response`: a reply grounded in a document the user uploaded, such as a response to a
notice. Detection is deterministic and keyword-based
([`detect-type.ts`](../src/server/deterministic/detect-type.ts)), driven by one
[document-type registry](../src/server/deterministic/document-type-registry.ts).

## Pillars

| Pillar | What the user gets | Backend status |
|---|---|---|
| **Understand** | Upload a PDF, DOCX or pasted text. The server extracts the text and returns findings: obligations, deadlines, penalties, ambiguities and missing clauses. Each finding quotes the document, and the quote is checked word for word. Every finding is explained from 2–4 reader perspectives ("lenses", for example a tenant before or after signing). All lenses come from one model call. | Built |
| **Ask** | Chat about a document, grounded with verified citations, or ask general legal questions, which get no citations and carry a clear "general information" label. A non-LLM classifier routes each question to at most two specialists (tenancy, employment, contracts/NDA, privacy, freelance, general legal) and synthesizes their answers. Questions with no legal angle get a polite redirect without a model call. | Built |
| **Compare** | Two versions of a document, aligned clause by clause. Each change is marked added, removed or changed, explained in plain language, and quoted from both sides, each quote verified against its own document. | Built |
| **Prepare** | Questions to ask a lawyer and a before-you-sign checklist, generated only from the document's verified findings, plus a deterministic Markdown export. | Built. Output is not persisted; it is regenerated on request. |
| **Draft** | A first draft of any of the five tuned types, or a grounded response, written from scratch or grounded in an uploaded document, with revisions kept as a chain. Each section is labelled either "templated" (fixed text) or "AI-generated". | Built |
| **Projects** | An optional workspace per matter. Any document, comparison, draft or saved thread can be saved into one. | Built. Projects require a signed-in user. |

**Guest first.** Everything except projects and saved threads works without an account. Guest
documents, comparisons and drafts expire after a few hours. Guest chat threads live in the browser.
When a guest signs in, their documents, comparisons and drafts move to the new account in one
transaction.

## Product principles

- **Verified means verified.** A quote carries a `verified` badge only if the server has just
  checked that the exact text is in the document, at the place shown. See
  [How the solution works](../README.md#how-the-solution-works).
- **Information, not advice.** Findings have categories but no severity score or priority ranking,
  and neither do Compare changes or Draft sections. AI-written text is labelled as such.
- **Honest about the model.** Every persisted output records the model that produced it, so an
  answer from a fallback model is never presented as one from the primary.
- **Honest about gaps.** "Not analysed yet" is never shown as "no issues found". A missing clause
  is reported as a gap and never given a quote it does not have.

## Out of scope for now

These are decisions, not oversights:

- **Deployment.** No hosted instance. `npm run build` must pass, but nothing is deployed.
- **Supabase.** Local development uses PGlite, the filesystem and guest-only auth. The Postgres
  connection path (a Supavisor pooler URL, `prepare: false`) exists in
  [`client.ts`](../src/db/client.ts). The Supabase Storage and Auth adapters are not written yet,
  and the prod-only migrations have not yet been applied to a live project.
- **Real sign-in.** No Google OAuth flow yet. User-principal code paths, such as claim and
  save-to-project, are tested with constructed user principals.
- **Project-scoped RAG.** The `document_embeddings` migration is written but pending, because
  local PGlite does not bundle pgvector.
- **Languages and jurisdictions.** English only, and national-level jurisdiction only.
- **Analytics and outside links.** No third-party scripts of any kind, and no links out to lawyers,
  directories or legal-aid services: reaching a lawyer happens through Prepare's own export.
- **Share links.** Nothing about anyone's document is reachable by URL. Work leaves the product as
  Markdown, a printout or PDF, or copied text.

## Brand and design commitments

- **The category standard, played straight.** Saboot looks and behaves like a familiar AI assistant,
  built to the craft level of Claude.ai and Harvey, with no novelty for its own sake. It sits
  alongside those products and never imitates their names, marks or palettes.
- **Calm, trustworthy, professional.** The look is warm and near-monochrome, with one restrained
  accent for actions. Verification has its own colour, icon and label, and nothing else uses them.
- **It must never read as** a government portal (dense bureaucratic forms, official seals) or a
  generic AI chatbot (purple gradients, sparkles, glowing orbs).
- **Desktop and phone are both first-class,** and every screen meets WCAG 2.2 AA in light and dark
  mode.
- **Marketing proves, it doesn't claim.** The landing page shows the verifier working on a sample
  document. It carries no statistics, testimonials or user counts.

## Quality bars

Engineering bars, which the test suite enforces:

- `npm test` passes on a bare clone with no `.env` and no external services, and never calls a
  live model.
- Every One-Guarantee channel has a positive and a negative test inside the `verify` suite.
- Every association of two or more entities returns 404 for a foreign id and succeeds for the
  owner. This covers comparisons, a draft's grounding document and save-to-project.
- Every route in [API.md](API.md) has an integration test that drives the real handler.

Model-quality bars, which `npm run validate:live` measures against curated fixtures:

| Measure | Bar |
|---|---|
| Understand quotes that verify word for word | ≥ 90% |
| Answer-key clauses Understand finds (recall) | ≥ 80% |
| Injected Compare changes detected and explained | 100% |
| Required Draft sections present and non-blank | 100% |
| Ask routing to the right specialist | ≥ 80% |

A result below a bar does not fail the build; it is flagged in the report. Current results are in
the [live-validation report](live-validation-report.md).
