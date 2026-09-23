# 0002. `verified` requires an exact match on token boundaries, under a small fixed normalization set

Status: Accepted

## Context

A plain substring match lets a quote "verify" inside a longer word or number:

- "lawful termination" inside "unlawful termination";
- "25,000 per month" inside "1,25,000 per month";
- "05/2024" inside "12/05/2024";
- a true quote, "30 days", highlighted inside "130 days" instead of where it really occurs.

Normalization has the same risk. Every character class it folds is one more way for text that
differs from the document to pass as a match.

## Decision

**Normalization.** `verified` tolerates only:

- Unicode NFC (not NFKC, because "10²" would become "102");
- any whitespace or line-break run folded to one space;
- smart quotes and dashes folded to their ASCII forms;
- leading and trailing whitespace on the quote.

Case, punctuation, invisible characters, ligatures and line-end hyphen joining are **not**
tolerated. Quote marks around the quote are not trimmed, because trimming can move the certified
span.

**Token boundaries.** Both span edges are checked in the original canonical text. A position is
mid-token, and the occurrence is skipped, when:

- letters, digits or combining marks (`[\p{L}\p{N}\p{M}]`) sit on both sides;
- a hyphen, dash or apostrophe sits between word characters;
- `,`, `.` or `/` sits between digits;
- the edge splits a grapheme cluster.

The search moves on to the next occurrence that sits on boundaries. If there is none, the bounded
fuzzy path may return `approximate`, never `verified`.

**Fail-safe caps.** Every cap keeps work linear, and hitting one counts the position as mid-token:

- at most 32 invisible format characters skipped when looking for a neighbour;
- a bounded regional-indicator run;
- a 64-code-point look-behind;
- at most 4,096 grapheme checks per search.

**No minimum quote length.** A short quote on token boundaries is text the document really
contains, and a length cutoff would strip badges from decisive text such as "non-refundable".

Code: [`boundary.ts`](../../src/server/deterministic/verify/boundary.ts),
[`normalize.ts`](../../src/server/deterministic/verify/normalize.ts).

## Consequences

- Each rule can only add false negatives, never a false `verified`.
- `VERIFIER_VERSION` is stored beside every status and bumps on any change to these rules.
- A known gap is accepted: PDF line-wrap hyphenation ("non-\nrefundable") still verifies as
  written in the extracted text.
- Property tests with fast-check and a worst-case timing test keep the matcher correct and bounded
  on adversarial input.
