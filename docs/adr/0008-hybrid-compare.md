# 0008. Compare is hybrid: deterministic clause alignment, one LLM call to explain

Status: Accepted

## Context

Comparing two versions of an agreement has one job that matters more than any other: never miss a
change. If a model both finds and explains the changes, recall depends on the model. A change it
omits, or misquotes so that the quote fails verification, silently disappears from the result.

A model is still the right tool to explain what a change means in plain language.

## Decision

- **Alignment is deterministic and model-independent** (`findCandidateChanges`). Both texts are
  split into clauses (`segment.ts`), and each clause is reduced to its body: the marker ("2.1",
  "(a)", "Clause 3") is stripped and whitespace collapsed. Clauses with equal bodies are anchors;
  an LCS over the clause lists finds them, so renumbering and re-wrapping are not changes. Between
  anchors, clauses pair up as `changed` by word overlap (Jaccard), or stand alone as `added` or
  `removed`.
- **Bounds.** The LCS table is capped at 4 million cells. More than 50 candidate changes is a typed
  `VALIDATION_FAILED`, raised before any prompt is built.
- **One LLM call** explains only the candidate changes it is given, each by its id. An answer for an
  id the call never supplied is dropped.
- **Each side is verified against its own document.** A model quote is kept only when `verify()`
  places it inside its own clause. Otherwise the server quotes the clause itself, widening it with a
  few neighbouring words if needed to make it unique, so a change is never lost to a model omission
  or misquote.
- **Reads repeat the containment check.** A fresh span that falls outside its clause is withheld
  (no quote, no status), rather than shown at a place that was never checked.
- **No significance rating.** Compare, like the rest of the product, carries categories and
  plain-language explanations but no severity or priority. That keeps it on the right side of
  "legal information, not legal advice".

Code: [`compare.ts`](../../src/server/services/compare.ts),
[`segment.ts`](../../src/server/deterministic/segment.ts).

## Consequences

- Recall does not depend on the model. In live validation, 8 of 8 injected changes were detected
  and explained, on the fallback model with a small sample.
- Identical documents need no LLM call. The comparison records `model_used = "none"`.
- Clause segmentation is heuristic. Documents with unusual structure align at a coarser grain, but
  they still align deterministically.
