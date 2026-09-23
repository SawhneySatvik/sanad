# 0001. Only `verify()` can issue a verification result, and each result is bound to its quote and document

Status: Accepted

## Context

The product's central promise is that a quote marked `verified` really occurs in the source
document, at the place shown. The model supplies quote text; server code decides whether that text
is really there. A rule written only in prose ("always call `verify()` first") can be broken
without anyone noticing. Drizzle's insert types accept a bare `"verified"` string, so the database
layer alone cannot enforce it either.

A result that proves only that `verify()` ran also has a second weakness. It carries no identity,
so it could be attached to the wrong finding: an index drift in a batch, or the A and B sides of a
comparison swapped.

## Decision

- `verify()` and `verifyMany()` return a **`VerifyResult`**, an instance of a non-exported class
  with an ECMAScript `#private` brand field. TypeScript treats it nominally, so an object literal
  or a spread of a real result does not compile.
- The constructor also requires a **module-private token**. `new result.constructor(...)` and
  `class extends result.constructor` both throw at runtime.
- `isVerifyResult()` checks the brand with `#field in value`, never `instanceof`, which a subclass
  or `Object.create(prototype)` would pass.
- Every result records **the exact quote it checked, the SHA-256 of the canonical text, and the
  document's input mode**. Before persisting, every write path calls
  `assertVerifyResultFor(result, { quote, canonicalTextHash, inputMode })` with the row's own
  values. A mismatch throws.
- Only the findings, message-citations and comparisons repositories write a status, and they read
  status, spans and verifier version **only** from the result. The route layer puts a verification
  on the wire through a single mapper, `toVerificationOutput`. It re-asserts the same binding, then
  slices `spanText` from the live canonical text.

Code: [`verify.ts`](../../src/server/deterministic/verify/verify.ts),
[`verification.ts`](../../src/server/http/verification.ts).

## Consequences

- A forged, spread, subclassed or mismatched result fails at compile time or throws at runtime. It
  never reaches the database or the wire.
- Callers must pass the exact raw quote and the document's current hash and input mode. This is a
  small amount of plumbing on every write path, and it is deliberate.
- The brand proves provenance and binding, but not relevance. A verified quote is text the
  document really contains; it does not prove that the quote supports the finding's explanation.
