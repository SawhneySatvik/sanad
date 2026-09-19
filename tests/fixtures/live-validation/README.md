# Live-validation fixtures

This directory holds the curated fixture set that `npm run validate:live`'s four parts (Understand,
Ask, Compare, Draft) run real models against. It also holds the golden answers those runs are judged
by.

## Provenance

The six documents were written from scratch for this project in September 2026, and so were every
golden key, question and draft prompt. Nothing here was copied from a real agreement, policy or
letter.

All parties, people, companies, addresses, reference numbers and email domains are fictional.
Email addresses use the reserved `.example` domain. The documents follow the common structure of
their real-world Indian counterparts, such as Maharashtra leave-and-license conventions, the CTC
break-up in an offer letter and the DPDP Act, 2023 vocabulary in a privacy policy. Each document
also contains deliberately problematic clauses, so that recall can be measured.

Statutes are cited only where the citation is stable: the Indian Contract Act §27/§74, the
Maharashtra Rent Control Act §24/§55, the Specific Relief Act, the Arbitration and Conciliation Act,
the IT Act 2000 and the DPDP Act 2023. Tax is described as "the income-tax law in force" because the
Income-tax Act, 2025 renumbered the sections.

## Layout

| Path | What it is |
|---|---|
| `index.json` | Entry point. It lists every fixture, Compare pair, question set and the draft file. |
| `load.ts` | `loadLiveValidationSet()`, a zod-validated, typed loader, plus `matchedPhrases()`, the one keyword matcher. **Consumers should read through this module and use this matcher rather than parsing files or matching text themselves.** |
| `tests/architecture/fixtures.test.ts` | The structural gate. It runs under plain `npm test` and makes no model call. |
| `documents/<id>.txt` | The six fixture documents, one per detectable type. |
| `keys/<id>.json` | The golden answer key for each document (Understand). |
| `compare/<id>.after.txt`, `compare/<id>.changes.json` | Compare pairs for three of the documents (Compare). The "before" side is `documents/<id>.txt`. |
| `ask/<id>.json`, `ask/non_legal.json` | Ask question sets (Ask). |
| `draft/expectations.json` | Draft prompts and expected facts (Draft). |

The six fixtures and the type each is expected to detect as:

| Fixture | Detected type | Description |
|---|---|---|
| `leave_and_license` | `leave_and_license` | 11-month flat license in Kharghar, Navi Mumbai |
| `job_offer_letter` | `job_offer_letter` | Senior engineer offer, Bengaluru |
| `nda` | `nda` | "Mutual" NDA between a Mumbai retailer and a Pune design studio |
| `privacy_policy` | `privacy_policy` | Rental-marketplace app policy |
| `freelance_service_agreement` | `freelance_service_agreement` | UX designer and a D2C food brand |
| `generic` | `generic` | Co-working dedicated-desk membership, Bengaluru |

## Getting a fixture into the pipeline

Upload a fixture as `text/plain`, UTF-8, exactly as stored. `services/understand.ts`
(`extractFromBytes`) decodes plain text and sends it through `extractDocument({ pastedText })`.

Every document is already canonical, which the test asserts. Two consequences:

- `canonical_text` is the file minus its trailing newline.
- Anchors, line numbers and offsets computed on the file therefore apply unchanged to the stored
  document.

Every document is also printable ASCII (straight quotes, `Rs.` rather than `₹`). The verified rate
therefore measures grounding, not typography.

## The matching rule: `matchedPhrases(text, phrases)`

`load.ts` exports `matchedPhrases(text, phrases)`, the only way to match key keywords and Compare
mentions against model text. It wraps `includesWholeWordPhrase` from `detect-type.ts`, so it matches
the way the classifier and detect-type do:

- Matching is case-insensitive and whole-word or whole-phrase.
- "minors" does not match inside "minor", and "contract" does not match "contracts".
- A keyword never matches as a stray substring.

Because of this, each keyword list spells out its plural and variant forms, for example "late
payment", "late payments", "late-payment" and "pays late". The test checks the lists in three ways:

- **Probes.** Every missing-clause entry has realistic probe phrasings in the test's
  `MISSING_CLAUSE_PROBES`, and each probe must hit the entry's keywords.
- **Not in the document.** No keyword may occur anywhere in its own fixture. Otherwise an
  explanation of a clause that *is* present would count as finding the gap.
- **Not in the prompt boilerplate.** No keyword may occur in the Understand lens and prompt
  boilerplate, meaning the lens descriptions and the shared system-prompt scaffolding.
  - The per-type focus checklist is excluded, because it names the topics to look for, and on-topic
    findings legitimately use those words.

A deliberate gap: bare "leaves" and "holidays" are not JO-17 keywords. "Leaves" is also a verb, and
"public holidays" appears in the offer letter.

## Which entries are required

An entry is **`required: true`** when a careful reviewer advising the signing party would raise it
before signature. That happens when either:

- it departs from standard practice to that party's detriment (one-sided, unusually costly or
  restrictive, or legally doubtful); or
- it omits a protection that documents of this kind normally give.

An entry is **`required: false`** when it is:

- a standard term that is merely worth knowing; or
- a second entry for an issue that another required entry already carries.

The rule does not depend on whether the Understand prompt's focus list names the topic. Each
entry's `description` says which way it falls.

## File schemas

`load.ts` holds the zod schemas and is authoritative. They are strict, so an unknown field is an
error. Category, specialist and draft-type values come from the real registries' id lists.

### `keys/<id>.json` — golden key (Understand)

The file has the shape `{ fixture, entries: KeyEntry[] }`. Each `KeyEntry` has these fields:

- `id`: unique across the whole set, e.g. `LL-07`.
- `category`: one of the five allowed exact values, `obligation`, `deadline`, `penalty`, `ambiguity`
  or `missing_clause`. It is the category a careful reviewer would give.
- `altCategories` (optional): other categories that are also defensible. A liability exclusion, for
  example, fits none of the five cleanly.
- `required`: see [Which entries are required](#which-entries-are-required).
- `carriedBy` (optional, only on `required: false` entries): the required entries of the same key
  that carry the same issue. The test checks this. See Understand recall below.
- `description`: why the clause matters, and why it is or is not required.
- `anchor`: an exact substring of the canonical text.
  - The test asserts that each anchor occurs exactly once and that no two anchors overlap.
  - `anchor` is `null` exactly when the category is `missing_clause`.
- `missing_clause` entries only:
  - `matchKeywords`: words a model's explanation of this gap is likely to use. They are matched
    with `matchedPhrases`.
  - `absentPhrases`: phrases the test asserts do not appear anywhere in the document. This is the
    mechanical evidence that the clause really is missing.

The test asserts that every key has at least one **required** entry in each of the five categories.
It also pins the required counts per fixture, which the recall table below lists (70 in total).

### `compare/<id>.changes.json` — Compare manifest (Compare)

The file has the shape `{ id, before, after, changes: Change[] }`, with 2-3 changes. Each `Change`
has these fields:

- `id` and `type`, where `type` is `added`, `removed` or `changed`.
- `description`.
- `before` and `after`. Each is `{ line, start, end, text, snippet }` or `null`.
  - `line` is 1-based, in that side's own file.
  - `[start, end)` are the character offsets of the full line in that file's canonical text.
  - `text` is the full line.
  - `snippet` is the words that changed.
  - `before` is `null` for `added`; `after` is `null` for `removed`.
- `expectedMentions`: alternative words, at least one of which the model's explanation of this
  change should contain. The test asserts that at least one of them appears in the changed side's
  line. For a `changed` item, none of them may appear in the old line, so a mention can only come
  from the new value.

The test asserts the following:

- The LCS line diff of the two files equals the manifest exactly. No other line differs.
- Each manifest line is the file's real line at its stated offsets, and is unique in its file.
- A `changed` line differs only by its snippet.
- `services/compare.ts`'s own `findCandidateChanges` yields exactly one candidate per manifest
  change, of the same type, whose clause spans are exactly the manifest's offsets.

### `ask/<id>.json` — question sets (Ask)

The file has the shape `{ fixture, questions: Question[] }`. Each fixture has 10 questions: 5
grounded, 2 general and 3 routing. Each `Question` has these fields:

- `id` and `question`.
- `kind` and `attachFixture`. `attachFixture` is true exactly for `grounded` questions.
  - `grounded`: the fixture is attached, and the answer lives in the document.
  - `general`: no document; a question in the fixture's domain.
  - `routing`: no document; a domain-routing test, usually with a distractor word from another
    domain (see `note`).
- `expectedAnchors`: set on `grounded` questions only. These are verbatim passages the answer
  should rest on, each occurring exactly once.
- `expectedSpecialist`: an id from `SPECIALIST_IDS`. It records what a careful human router would
  pick as the **primary** specialist. Every mark was set by human judgement, never to fit the
  classifier's behaviour.
- `routingAmbiguous`: marks questions where two specialists are genuinely defensible. It is a
  property of the question, not of any router.
- `acceptableSpecialists`: set only when `routingAmbiguous` is true. It lists the defensible
  specialists and includes `expectedSpecialist`.
- `note` (optional): why the question is tricky.

`ask/non_legal.json` has the shape `{ questions: [{ id, question, ambiguous, note? }] }`. These
questions attach nothing and are expected to hit the non-legal redirect. `NL-Q6` is marked
`ambiguous` because it names a landlord in a greeting request.

### `draft/expectations.json` — Draft prompts (Draft)

The file has the shape `{ items: Item[] }`. There is exactly one `from_scratch` item and one
`document_grounded` item for each of the six draftable types in `DRAFTABLE_DOCUMENT_TYPE_IDS`.
Each `Item` has these fields:

- `id`, `documentType`, `mode`, `jurisdiction` (`IN`) and `userInstructions`.
- `groundingFixture`: set on `document_grounded` items only. It names the fixture id to upload as
  `groundingDocumentId`. `grounded_response` is grounded on the `generic` fixture.
- `expectedFacts`: 1-3 strings, whose source depends on the mode.
  - `document_grounded`: strings from the grounding fixture. The test asserts that they are in the
    fixture and **not** in `userInstructions`, so a grounded draft cannot pass by echoing the
    prompt. They are mostly proper nouns, because models reformat amounts.
  - `from_scratch`: strings from the instructions, carried as information only.

## How validate:live consumes the set

### Understand

Run `understand.analyze()` on each of the six documents. Then compute the following.

1. **Verified rate.** Divide the number of verified quotes by the number of claimed quotes.
2. **Recall.** A finding and an entry *match* in one of two ways:
   - **Anchored entry.** The finding's verified span overlaps the entry's anchor span. Find the
     anchor span with `canonical_text.indexOf(anchor)`, which is unique by construction.
   - **Missing-clause entry.** The finding's category is `missing_clause`, and `matchedPhrases` of
     its lens explanations against the entry's `matchKeywords` is non-empty.

   **Each finding is assigned to at most ONE entry, and each entry to at most one finding.** Adjacent
   anchors can sit only a newline and a clause number apart, so a single long quote can overlap two
   of them. To assign:
   1. Take every matching (finding, entry) pair.
   2. Sort the pairs with required entries first, then by larger character overlap. Missing-clause
      pairs sort after anchored pairs within the same required tier.
   3. Walk the list and accept a pair only if neither its finding nor its entry is already taken.

   Recall is the number of assigned `required: true` entries divided by the required count.
   Report assigned `required: false` entries as bonus recall.

   Some optional entries carry `carriedBy: [ids]`. When a finding is assigned to such an entry,
   also credit each carrier that is still unassigned, for recall only. Without this, a model that
   flags the issue but quotes the "other half" (for example 6.1 rather than 6.2 of the bond) would
   count as missing the required entry.
3. **Every missing-clause finding.** List every `missing_clause` finding the model produced, matched
   or not, with its explanation text and the entry and keyword it matched (if any). Keyword matching
   is fuzzy, so a human must be able to check both the hits and the misses.
4. **Precision signal.** Report the count and share of model findings, per fixture, that match
   **no** key entry at all. This is for manual review, not a pass/fail gate.
   - A finding that matched an entry but lost the one-to-one assignment is a duplicate, not
     unmatched. Report duplicates separately.
5. **Category agreement, as a secondary metric.** Count assigned findings whose category is the
   entry's `category` or one of its `altCategories`.
6. **Out-of-enum categories.** Count findings whose category is outside the five values.

**Read per-fixture recall with care.** The per-fixture denominators are small, so the 80% bar
tolerates only two misses on each fixture (the test pins these counts):

| Fixture | Required entries | Misses the 80% bar tolerates |
|---|---|---|
| leave_and_license | 14 | 2 |
| job_offer_letter | 10 | 2 |
| nda | 11 | 2 |
| privacy_policy | 13 | 2 |
| freelance_service_agreement | 10 | 2 |
| generic | 12 | 2 |
| **all** | **70** | **14** |

The stable number is the aggregate over all 70 required entries. A single miss on one fixture is a
data point, not a trust failure.

### Ask

Run every question through the full orchestrator. Attach the fixture only when `attachFixture`
is true.

- **Grounded mode, all 30 grounded questions.**
  - The ≥90% bar is the citation verified rate over all grounded answers.
  - Also report how often a verified citation overlaps an `expectedAnchor`.
  - Report routing for these questions, but keep it out of the bar. The attached document's
    affinity boost largely decides their route.
- **General mode.** Assert that the answer structurally carries no citations or badge.
- **Routing bar.** The bar is computed over the
  non-grounded questions only: the `routing` and `general` kinds.
  - There are 30 of them: 12 general and 18 routing.
  - A question passes when the classifier's **top** choice (`routedDomains[0]`) equals
    `expectedSpecialist`.
  - A `routingAmbiguous` question passes when its top choice is any of its
    `acceptableSpecialists`. Three of the 30 are ambiguous: ND-Q8, PP-Q8 and FS-Q8.
  - The bar is ≥80% of 30, i.e. at most 6 misses.
- **Non-legal.** Expect `redirect: true` and `modelUsed: "none"`, and exclude `ambiguous` questions
  from the rate.

### Compare

Upload `before` and `after` for each pair and run `compare()`. Each manifest change must pass two
checks.

1. **Detected.** The persisted comparison has a change of the same `changeType` whose verified span
   overlaps the manifest line's `[start, end)` on each side that exists:
   - `verificationA` (with `status: "verified"`) against `before`.
   - `verificationB` against `after`.
   - The absent side's quote is `null`.
2. **Explained.** `matchedPhrases(explanation, expectedMentions)` is non-empty.

The bar is 100% of the 8 changes passing both checks. The detection half is deterministic, and this
test already asserts it through `findCandidateChanges`. The explanation half is what measures the
model. Report which changes failed which check.

### Draft

Generate all twelve items.

- **Required sections.** Check them with `missingRequiredSections()` / `requiredSectionKeys()` from
  `src/server/deterministic/draft-templates`. That registry is the source of truth, so don't copy
  the list.
- **Grounded drafts.** Each passes when its content contains at least one `expectedFact`, compared
  case-insensitively.

## Changing the set

Any edit to a document can move an anchor, a line number or an offset. Run
`npx vitest run tests/architecture/fixtures.test.ts` afterwards; it names every entry that broke.

A Compare "after" file must differ from its "before" file only by the lines in its manifest.
When a fixture changes, regenerate both the "after" file and its manifest line numbers and offsets
together.

A change to the required count or the question mix must also update the pinned denominators in the
test and the tables above.
