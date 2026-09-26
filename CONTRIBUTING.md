# Contributing

Read [CLAUDE.md](CLAUDE.md) first — it is the binding source for this project's engineering rules,
including the One Guarantee, the non-negotiable rules and the full verification gate. This document
is a shorter, contributor-facing path through the same material.

## Setup

```bash
npm install
npm run db:migrate   # applies src/db/migrations/ to a local PGlite database
npm run dev          # local dev server, against PGlite
```

No API keys are needed for development or for the test suite — `npm test` never calls a live model.

## Commands

```bash
npm run dev              # local dev server, against PGlite
npm run lint
npm run typecheck        # tsc --noEmit
npm test                 # the full suite: no API keys, no network, no services
npm run test:unit        # tests/unit only
npm run test:integration # tests/integration only
npm run test:property    # tests/property only (fast-check)
npm run test:architecture # tests/architecture only (repo-wide static checks)
npm run test:verify      # any path containing "verify" — the One-Guarantee suite
npm run test:idor        # any path containing "idor" — cross-principal access
npm run test:rate-limit  # any path containing "rate-limit" — atomic-increment races
npm run test:coverage    # vitest run --coverage
npm run check-all        # lint + typecheck + test + build
npm run security:audit   # npm audit --audit-level=high
npm run test:e2e         # Playwright (starts an isolated e2e server if one isn't already running)
npm run test:a11y        # the same harness, filtered to specs tagged @a11y
npm run build
```

`npm run validate:live` makes real provider calls against curated fixtures and spends a shared
free-tier quota — run it explicitly, one part at a time, never folded into `check-all` or `npm test`.

## The One Guarantee

A finding, quote or answer is never displayed as `verified` unless `verify()` has, at that moment,
confirmed the exact text exists in the canonical source document, against the same text the UI
displays. No code path may set a verified status without passing through `verify()`. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the ten channels this holds across, and the tests
that back each one.

## Test layout

Never put a test or test helper in `src/`.

- `tests/unit/` mirrors `src/`. Suffixes matter — the release-blocker filters match file paths, so a
  test outside the mirror or without its suffix silently drops out of its suite:
  - `.verify.test.ts` — the One-Guarantee suite (`npm run test:verify`)
  - `.idor.test.ts` — cross-principal access (`npm run test:idor`)
  - `.timing.test.ts` — excluded from `test:coverage`
  - `.contract.test.ts` — a shared interface or response-shape contract (for example the LLM
    adapter contract every provider runs, or a shared list/document contract)
  - `npm run test:rate-limit` matches any path containing `rate-limit`, not a fixed suffix
- `tests/integration/routes/` drives real route handlers.
- `tests/property/` holds `fast-check` suites.
- `tests/architecture/` holds static repo-wide checks.
- `tests/support/` holds helpers, never `*.test.ts` — import as `@tests/…`; `src/` may not.

Mocking policy: fakes sit only at the SDK/transport boundary (the provider HTTP calls, the storage
client). Never mock the database, `verify()`, a repository or a service — the tests that matter run
against real PGlite.

## Migrations

Migrations are hand-written SQL and are **never edited once applied**.
[`src/db/migrate.ts`](src/db/migrate.ts) checksums every migration file it has run; an edited
comment or a changed line fails on every database that already applied it. A fix always goes
forward in a new migration file. Drizzle Kit's diff is a parity check on `db/schema.ts`, never a
generator.

## Verification gate

Run the tests that match what you touched:

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
| A screen or flow reachable by the e2e harness | `npm run test:e2e`; `npm run test:a11y` too if markup or ARIA changed |
| Anything | `npm test`, `npm run typecheck`, `npm run lint` |

The full table, with a few more specialised rows, lives in [CLAUDE.md](CLAUDE.md#verification-gate).

## Style

Write the simplest thing that works. Match the surrounding style; read a file before you edit it.
Comments explain why, not what — the non-obvious reason, what breaks if you change it — never a
ticket, decision or review reference. Delete code rather than commenting it out.

Never read or print the contents of `.env`. Reference variable names only.
