# Lawyer Up

A legal-document AI assistant for Indian tenants, employees and freelancers: chat, document
analysis, comparison, lawyer-prep output and drafting. It explains what a document says and shows
exactly where it says it — it never gives legal advice.

## The One Guarantee

A finding, quote or answer is never displayed as `verified` unless `verify()` has, at that moment,
confirmed the exact text exists in the canonical source document, against the same text the UI
displays. No code path — model response, cache, fallback model, orchestrator synthesis,
guest-import, or error recovery — may set a verified status without passing through `verify()`.
Every change is scanned against all ten channels this holds across, listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How to work here

Write the simplest thing that works. Match the surrounding style; read a file before you edit it.
Comments explain why, not what — the non-obvious reason, what breaks if you change it — never a
restatement of the code, and never a ticket, decision or review reference. Delete code rather than
commenting it out. Say what you did and did not do; never claim a test passes without running it.
**Never read or print the contents of `.env`.** Reference variable names only.

## Commands

```bash
npm run dev              # local dev server, against PGlite
npm run lint
npm run typecheck        # tsc --noEmit
npm test                 # vitest run — the full suite: no API keys, no network, no services
npm run test:unit         # tests/unit only
npm run test:integration  # tests/integration only
npm run test:property     # tests/property only (fast-check)
npm run test:architecture # tests/architecture only (repo-wide static checks)
npm run test:verify       # any path containing "verify" — the One-Guarantee suite
npm run test:idor         # any path containing "idor" — cross-principal access
npm run test:rate-limit   # any path containing "rate-limit" — atomic-increment races
npm run test:coverage     # vitest run --coverage, excluding *.timing.test.ts
npm run build
npm run check-all         # lint + typecheck + test + build
npm run db:migrate        # applies src/db/migrations/ to the local PGlite database
npm run validate:live     # real Gemini/NVIDIA/OpenRouter calls against curated fixtures — needs
                           # provider keys, spends the shared free-tier quota; run explicitly, one
                           # part at a time, never concurrently with itself, never folded into
                           # check-all or npm test. Re-run after any prompt or fixture change.
npm run e2e:server        # an isolated `next dev` on :3100, SABOOT_E2E=1, fresh .pglite-e2e/, a
                           # local fake provider at the transport boundary — refuses in production
npm run test:e2e          # Playwright; starts e2e:server itself if one isn't already running
npm run test:a11y         # the same harness, filtered to specs tagged @a11y (axe via @axe-core/playwright)
npm run capture:screens   # screenshots a route/state list at 1440x900 and 390x844, light and dark,
                           # against the e2e server, from an isolated rsync'd copy of the working tree
```

## Non-negotiable rules

1. **No code path sets a `verified` status without `verify()` having just run against the live
   `canonical_text`.** This is the One Guarantee — see above.
2. **`canonical_text` is extracted server-side only**, from the uploaded file's bytes via its
   storage reference. A client-submitted string is never accepted as canonical text.
3. **Every repository function takes a `principal` and calls the `canAccess` chokepoint.** No
   "get by ID" method exists without an ownership check. A function that associates two or more
   entities verifies the principal owns every one of them, not only the primary one.
4. **The LLM response schema never includes a `status` or quote-span field.** The model claims
   text; only server code decides whether it's verified and where it is.
5. **`native_document`-mode documents (scanned/image PDFs) can never reach `verified`** — capped at
   `approximate`/`not_found` inside `verify()` itself, not only by a DB constraint.
6. **A repository function never holds a connection or an open transaction across an LLM call.**
   Fetch and persist in short transactions strictly before and after the round-trip.
7. **Production's `DATABASE_URL` is the Supavisor transaction pooler (port 6543), never the direct
   connection.** Connection factory: `postgres(url, { prepare: false, max: N })`, instantiated once
   at module scope — `prepare: false` because the pooler doesn't support prepared statements.
8. **Rate-limit and cache counters are always `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`**,
   never read-then-write, never inside a transaction spanning an LLM call.
9. **Migrations are hand-written SQL.** Drizzle Kit's diff is a parity check, never a generator.
10. **App tables never receive Data API/PostgREST grants** for `anon`/`authenticated` roles —
    verify with a denial test, don't assume the platform default holds.
11. **No route that touches the DB or the LLM client opts into `runtime = "edge"`.**
12. **`npm test`/`npm run check-all` never call a live LLM/embedding API.** Fakes sit only at the
    SDK boundary; the network guard in `tests/setup/no-network.ts` fails any test that reaches a
    live host. `npm run validate:live` is the one explicit exception.
13. **A principal-scoped fetch for a resource that exists but belongs to someone else returns 404,
    never 403/401-with-detail** — a 403 confirms existence.
14. **Guest identity is an httpOnly, signed, CSPRNG-generated session cookie** — never a
    client-supplied header.

## Conventions

- **Layout.** `src/app/api/**` (thin route adapters) · `src/server/services/**` (one module per
  feature) · `src/server/deterministic/**` (extract, verify, segment, detect-type, draft-templates —
  model-independent) · `src/server/llm/**` (`LlmClient` + adapters) · `src/server/orchestrator/**` ·
  `src/server/data/**` (repositories + `canAccess`) · `src/server/storage/**` · `src/server/auth/**`
  · `src/db/**` (schema, migrations). `src/` holds production code only.
- **Route handlers call exactly one service-layer function.** No domain logic in a route handler.
- **Mocking policy: fakes only at the SDK/transport boundary** (the Gemini/NVIDIA/OpenRouter HTTP
  calls, the storage client). Never mock the database, `verify()`, a repository or a service — tests
  that matter run against real PGlite.
- **Test layout** — never put a test or test helper in `src/`:
  - `tests/unit/` mirrors `src/`; keep the suffixes `.verify.`, `.idor.`, `.timing.`, `.contract.` —
    the release-blocker filters match file paths, so a test outside the mirror or without its suffix
    silently drops out of its suite.
  - `tests/integration/routes/` drives real route handlers; `tests/property/` holds `fast-check`
    suites; `tests/architecture/` holds static repo-wide checks.
  - `tests/support/` holds helpers, never `*.test.ts` — import as `@tests/…`; `src/` may not.
- **Comments explain why**, not what: the non-obvious reason, what breaks if you change it. No
  ticket, decision or review reference; no build history ("now", "no longer", "originally").
- **Migrations are never edited once applied.** `src/db/migrate.ts` checksums every migration file
  it has run; an edited comment or a changed line fails on every database that already applied it.
  A fix always goes forward in a new migration file.
- **Git.** Stage files by name, never `git add -A`.
- **Never read `.env`.**

## Verification gate

| Touched | Run |
|---|---|
| `verify()` / anything in `src/server/deterministic/verify/` | `npm run test:verify` |
| Any repository / `canAccess` | `npm run test:idor` |
| Rate-limit or cache tables | `npm run test:rate-limit` |
| `db/schema.ts` or a migration | `npx vitest run tests/unit/db` |
| `LlmClient` / any adapter | The contract test for that interface (not the live API) |
| `src/server/orchestrator/**` | The fan-out cap test; confirm the classify step makes no LLM call |
| A storage adapter | The owner-prefix and principal-required tests |
| Anything in `src/server/prompts/**` | `npm run validate:live` before treating the change as done |
| `src/server/samples/**` | The registry's sha256/prompt-fingerprint pins, the single-importer check for `RecordedLlmClient`, and `npm run test:verify` (channels 1 and 6) |
| A screen or flow reachable by the e2e harness | `npm run test:e2e`; `npm run test:a11y` too if markup or ARIA changed |
| `scripts/capture-screens.ts` or its support code | `npm run capture:screens` against the affected route/state list |
| Anything | `npm test`, `npm run typecheck`, `npm run lint` |

More detail lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (system design, the One
Guarantee's ten channels), [docs/SCHEMA.md](docs/SCHEMA.md) (data model), [docs/API.md](docs/API.md)
(HTTP contract), [docs/PRODUCT.md](docs/PRODUCT.md) (scope) and [docs/adr/](docs/adr/README.md)
(decision records).
