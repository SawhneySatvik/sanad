# Live validation — Understand — Run 1

Mode **live** · started 2026-09-23T12:53:37.815Z · wall time 2m 36s · provider calls **4/4** (gemini 4, nim 0, openrouter 0; refused locally: 6 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

## Concerns

- understand/aggregate: only 2/6 fixtures analysed — every aggregate below is partial; not measured: job_offer_letter, privacy_policy, freelance_service_agreement, generic
- understand/nda: answered by the fallback model gemini-3.5-flash-lite, not gemini-2.5-flash
- understand/nda: recall 72.7% (8/11) < 80%
- understand/leave_and_license: answered by the fallback model gemini-3.5-flash-lite, not gemini-2.5-flash

### Reviewer notes (human review of this run's output)

- A targeted confirmation of the current Prepare version, not a full Understand run: 4 provider calls at most, primary out of its daily quota (capped at 0), so every answer is the fallback model. The NDA replaced the job offer letter because the offer letter and the leave and license produce no checklist gaps, so only the NDA exercises the checklist-gap path.

## Thresholds (aggregate over analysed fixtures)

| Metric | Threshold | Actual | Met |
|---|---|---|---|
| Verified rate of claimed quotes | ≥90% | 100.0% (35/35; 0 approximate, 0 not_found) | yes — partial, 2/6 fixtures |
| Recall of required key entries — model findings only | ≥80% | 88.0% (22/25; +5 optional) | yes — partial, 2/6 fixtures |
| Categories within the five allowed values | 100% | 100.0% (0 outside of 36) — zod rejects any other value at parse, so this is structural; the live signal is the repair-retry/SCHEMA_FAILED column below | yes — partial, 2/6 fixtures |
| Precision signal: model findings matching no key entry | reported, not gated | 25.0% (9/36); 0 duplicates | — |
| Fixtures analysed | 6 | 2/6 | **no** |

## Missing protections: the model, the checklist, and both

Required missing-clause entries of the analysed fixtures that have a standard-clause checklist (the co-working membership has none by design: with no known document type, no clause is expected).

| Line | What it counts | Required missing clauses found | All required entries |
|---|---|---|---|
| Model | findings the model wrote (`ai_generated`) | 1/3 | 22/25 |
| Checklist | the deterministic checklist's own gaps, before get() drops those a model finding covers; source: served by get() | 2/3 (every fixture with a checklist, analysed or not: 5/7) | — |
| Combined | model findings plus the checklist gaps the reader is shown | 3/3 | 24/25 (96.0%) |

Checklist gaps on every fixture: 5; not confirmed by any key entry (a gap the key lacks, or a false absence claim): 0.

| Fixture | Gap | Topic | Shown to the reader | Confirmed by key entry (keywords) | If unconfirmed: the document may cover it at |
|---|---|---|---|---|---|
| nda | nda.exclusion_independent_development | Exclusion for independently developed information | yes | ND-13 (independently developed) | — |
| nda | nda.compelled_disclosure | Disclosure required by law | yes | ND-12 (required by law, regulator) | — |

## Per fixture

| Fixture | Detected type | model_used | Findings | Verified rate | Approx | Not found | Recall (required) | Optional | Unmatched | Dup | Cat. agree | Out-of-enum | Repair retry | Trimmed by service | Transient retry | Calls | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nda | nda (1.00) | gemini-3.5-flash-lite | 11 | 100.0% (11/11) | 0 | 0 | 72.7% (8/11) | 2 | 1 (9.1%) | 0 | 7/10 | 0 | no | none | no | #1 | 41s |
| leave_and_license | leave_and_license (0.52) | gemini-3.5-flash-lite | 25 | 100.0% (24/24) | 0 | 0 | 100.0% (14/14) | 3 | 8 (32.0%) | 0 | 17/17 | 0 | no | none | no | #3 | 55s |

Category mix per fixture: nda obligation 5, ambiguity 1, deadline 2, penalty 3 · leave_and_license deadline 6, obligation 11, penalty 6, ambiguity 1, missing_clause 1

## Missed required entries

| Fixture | Entry | Category | Why it matters (key) | Approximate near-miss |
|---|---|---|---|---|
| nda | ND-03 | ambiguity | Brightwater's 'Representatives' alone include its affiliates, vendors and consultants, so it can pass Pixelkraft's information to a much wider circle… | — |
| nda | ND-12 | missing_clause | There is no exception for disclosure required by law, a court order or a regulator, and no process for notifying the other party before such disclosu… | — |
| nda | ND-13 | missing_clause | The exclusions omit two standard carve-outs: information independently developed by the receiving party, and information received lawfully from a thi… | — |

Required entries credited through `carriedBy`: none.

## Every missing_clause finding

Keyword matching is fuzzy; check both the hits and the misses. Explanation is the default (first) lens.

| Fixture | Finding | Matched entries (keywords) | Assigned to | Explanation |
|---|---|---|---|---|
| leave_and_license | 7ebb5c3c | LL-16 (inventory, list of furniture) | LL-16 | The document does not specify what happens to your security deposit if the landlord fails to refund it on time. You may want to add an interest penalty for delayed refund. |

## Samples worth a human's eyes

- **nda** · obligation · **verified** · matches no key entry — span: "3.6 Where the Confidential Information disclosed by Brightwater includes personal data of its customers, Pixelkraft shall process such personal data only for the Purpose, on the documented instructions of Brightwater, a…"
  - AI explanation (receiving_party_about_to_sign): Pixelkraft must comply strictly with the Digital Personal Data Protection Act, 2023, when handling customer personal data, so verify your data processing workflows comply before signing.
- **nda** · ambiguity · **verified** · matches ND-02 — span: "4.1 Notwithstanding anything contained in this Agreement, nothing shall restrict Brightwater or its Representatives from using, for any purpose, any Residuals. "Residuals" means ideas, concepts, know-how and techniques …"
  - AI explanation (receiving_party_about_to_sign): Brightwater carves out an exception to use 'residuals' remembered by its staff, which is favourable to Brightwater but could dilute your IP protection.
- **leave_and_license** · deadline · **verified** · matches no key entry — span: "This license shall be for a period of eleven (11) months commencing from the Commencement Date and ending on 31st August, 2027 (both days inclusive), unless terminated earlier in accordance with this Agreement."
  - AI explanation (tenant_about_to_sign): You are committing to an 11-month stay, which gives you stable housing for almost a year before any renewal discussion is needed.
- **leave_and_license** · penalty · **verified** · matches LL-11 — span: "If the Licensee fails to hand over vacant possession of the Licensed Premises on the expiry or earlier termination of this Agreement, the Licensee shall be liable to pay to the Licensor damages calculated at three (3) t…"
  - AI explanation (tenant_about_to_sign): Overstaying after termination or expiry results in a massive penalty: triple the daily license fee for every single day you remain.

## How each document went through the pipeline

Per fixture: `LocalFsStorageAdapter.createUploadTarget` → `writeRelayed` (the upload relay route's calls, `text/plain`) → `understand.analyze()` (`confirmUpload` → pending row → text extraction → type detection → one `llm.complete()` → `verifyMany` → one persisting transaction) → a fresh `understand.get()` with an LLM-less deps object (re-verifies every quote against the stored canonical text). The LLM client is `createContainer().forRequest(principal)` — the production composition: principal tier outside, Gemini → Gemma(NIM → OpenRouter) fallback with per-provider global tiers inside, default limits, in-memory PGlite with all migrations, a dedicated guest principal. Anchored matches require `status === "verified"`; approximate overlaps are listed as near-misses, never credited.

## Provider calls

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| 1 | understand:nda | gemini | gemini-3.5-flash-lite | HTTP 200 | 40s (40495 ms) |
| 2 | prepare:nda | gemini | gemini-3.5-flash-lite | HTTP 200 | 4s (4040 ms) |
| 3 | understand:leave_and_license | gemini | gemini-3.5-flash-lite | HTTP 200 | 55s (55124 ms) |
| 4 | prepare:leave_and_license | gemini | gemini-3.5-flash-lite | HTTP 200 | 46s (45842 ms) |

Refused locally, never sent: understand:nda → gemini-2.5-flash (cap); understand:nda → gemini-2.5-flash (cap); prepare:nda → gemini-2.5-flash (cap); prepare:nda → gemini-2.5-flash (cap); understand:leave_and_license → gemini-2.5-flash (cap); understand:leave_and_license → gemini-2.5-flash (cap).
