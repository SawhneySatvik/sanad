# 0011. Tests live in a dedicated tree, fakes sit only at the SDK boundary, and live validation is separate

Status: Accepted

## Context

The most important properties here are security and trust properties: the One Guarantee,
cross-principal isolation, and atomic rate limits. A suite that mocks the database, the verifier or
a repository can pass while any of them is broken. A suite that calls a live model is slow and
flaky, and it burns a shared free quota. Tests mixed into `src/` blur what ships, and a path-based
filter can silently lose them.

## Decision

- **Layout.** `src/` holds production code only. `tests/unit/` mirrors `src/` one to one. The other
  kinds have their own folders:
  - `tests/integration/routes/` drives the real route handlers over HTTP-shaped requests;
  - `tests/property/` holds fast-check suites;
  - `tests/architecture/` holds static, repo-wide checks;
  - `tests/support/` holds helpers, never tests.

  `tests/architecture/no-tests-in-src.test.ts` fails on any test, snapshot or vitest import under
  `src/`. An ESLint rule bans `@tests/*` imports from `src/`.
- **Release-blocker filters match file paths.** `test:verify`, `test:idor` and `test:rate-limit`
  are `vitest run <word>`, so a test joins its suite through its path. Examples are the suffixes
  `.verify.` and `.idor.`, or a directory such as `rate-limit/`.
- **The One-Guarantee registry.** `tests/architecture/one-guarantee-channels.json` names, for each
  channel, a positive and a negative test by file and exact title. The coverage check parses the
  channel table out of the architecture doc and each title out of the TypeScript AST. It fails if a
  channel lacks either test inside the `verify` suite, or if a title stops matching a live test.
- **The contract lint.** It checks every response zod schema: no raw quote field outside the shared
  verification shape, no canonical text or storage ref, no pass-through types, and a provenance
  label on model-written prose.
- **Fakes only at the SDK or transport boundary.** `FakeLlmClient` stands in for Gemini, NIM and
  OpenRouter, and the storage contract suite runs against the real local adapter. The database,
  `verify()`, repositories and services are never mocked: tests run against in-memory PGlite with
  the real migrations applied.
- **No network in tests.** `tests/setup/no-network.ts` fails the *test*, not only the call, on any
  non-local egress, even if an SDK swallows the error. Its escape hatch may be called from exactly
  one file, and an architecture test enforces that.
- **Live validation is separate.** `npm run validate:live` runs real models against curated
  fixtures with golden answer keys and writes a report. It is never part of `npm test`, and it runs
  one part at a time under an explicit call budget.

## Consequences

- `npm test` passes on a bare clone with no API keys and no services running.
- Renaming a test file can move it out of a release-blocker suite. The registry and the
  path-matching filters make that failure loud rather than silent.
- A quality regression, such as recall or schema acceptance by a real provider, shows up only in
  `validate:live`, never in the fast suite.
