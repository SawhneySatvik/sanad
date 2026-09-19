# Live validation — Understand — Run 3

Mode **live** · started 2026-09-23T08:42:47.655Z · wall time 8m 52s · provider calls **11/25** (gemini 8, nim 3, openrouter 0; refused locally: 0 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

**Stopped early:** prepare: stopped — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)

## Concerns

- understand/aggregate: only 5/6 fixtures analysed — every aggregate below is partial; not measured: generic
- understand/job_offer_letter: quality drop vs Run 2 — recall, category agreement, missing-clause findings 2 → 0, precision signal: unmatched 6/24 → 13/31
- understand/privacy_policy: quality drop vs Run 2 — recall, precision signal: unmatched 6/25 → 19/36
- understand/job_offer_letter: call #2 (gemini) failed with a network error
- understand/job_offer_letter: call #3 (nim) aborted by the client-side timeout after 2m 0s
- understand/job_offer_letter: first attempt failed transiently (UPSTREAM_UNAVAILABLE: A required service is temporarily unavailable. Please try again later.); retried once via the product's retry path — ok
- understand/nda: call #5 (gemini) failed with a network error
- understand/nda: call #6 (nim) aborted by the client-side timeout after 1m 30s
- understand/nda: first attempt failed transiently (UPSTREAM_UNAVAILABLE: A required service is temporarily unavailable. Please try again later.); retried once via the product's retry path — ok
- understand/generic: quota exhausted at call 10 (gemini, gemini-2.5-flash) — HTTP 429, window per_day — provider said: RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. * Quota exceeded for metric: generativelanguage.googleapis.
- understand/generic: call #11 (nim) aborted by the client-side timeout after 2m 0s
- understand/generic: analysis failed — RATE_LIMITED: Too many requests. Please try again later.

### Reviewer notes (human review of this run's output)

- FS-14 (required: no late-payment interest clause) is credited to finding …8f92c7c3 by the spec's keyword rule ('delays in payment' appears in one lens explanation), but that finding is about unlimited revisions and deliverable acceptance, not late payment. Discounting it, freelance_service_agreement recall is 7/10 (70%, below the 80% bar) and aggregate recall 49/58 (84.5%).
- The Run 2 vs Run 3 'quality drop' is one sample per setting on two fixtures (recall 23/23 → 21/23 is within run-to-run variation), so it is not yet attributable to thinking being off. The only model-facing change from understand-v2 to v3 is thinkingBudget 0 (prompt text and schema unchanged; no dedupe/trim fired). A repeated A/B is needed before deciding. Also: the generic fixture has never been measured in any run (12 required entries untested).
- Standard-clause checklist: evaluated once, held-out, on these six fixtures before any key was read: 5/7 required missing clauses, with 1 false absence claim (the freelance agreement's payment on termination, which clause 10.3 does address) that was then fixed in the permissive direction only. The checklist lines here are recomputed from the fixture text after that fix, on the same fixtures, so they are not a held-out result.

## Thresholds (aggregate over analysed fixtures)

| Metric | Threshold | Actual | Met |
|---|---|---|---|
| Verified rate of claimed quotes | ≥90% | 100.0% (137/137; 0 approximate, 0 not_found) | yes — partial, 5/6 fixtures |
| Recall of required key entries — model findings only | ≥80% | 86.2% (50/58; +22 optional) | yes — partial, 5/6 fixtures |
| Categories within the five allowed values | 100% | 100.0% (0 outside of 142) — zod rejects any other value at parse, so this is structural; the live signal is the repair-retry/SCHEMA_FAILED column below | yes — partial, 5/6 fixtures |
| Precision signal: model findings matching no key entry | reported, not gated | 49.3% (70/142); 0 duplicates | — |
| Fixtures analysed | 6 | 5/6 | **no** |

## Missing protections: the model, the checklist, and both

Required missing-clause entries of the analysed fixtures that have a standard-clause checklist (the co-working membership has none by design: with no known document type, no clause is expected).

| Line | What it counts | Required missing clauses found | All required entries |
|---|---|---|---|
| Model | findings the model wrote (`ai_generated`) | 3/7 | 50/58 |
| Checklist | the deterministic checklist's own gaps, before get() drops those a model finding covers; source: recomputed (this run predates the checklist) | 5/7 (every fixture with a checklist, analysed or not: 5/7) | — |
| Combined | model findings plus the checklist gaps the reader is shown | 5/7 | 52/58 (89.7%) |

Checklist gaps on every fixture: 5; not confirmed by any key entry (a gap the key lacks, or a false absence claim): 0.

| Fixture | Gap | Topic | Shown to the reader | Confirmed by key entry (keywords) | If unconfirmed: the document may cover it at |
|---|---|---|---|---|---|
| nda | nda.exclusion_independent_development | Exclusion for independently developed information | yes | ND-13 (independently developed) | — |
| nda | nda.compelled_disclosure | Disclosure required by law | yes | ND-12 (required by law, regulator) | — |
| privacy_policy | privacy_policy.nomination | Nominating someone to act for you | no — a model finding covers it | PP-17 (nominate, nominating, nomination) | — |
| privacy_policy | privacy_policy.childrens_data | Children's data | no — a model finding covers it | PP-16 (children, guardian, under 18) | — |
| freelance_service_agreement | freelance_service_agreement.late_payment | Late payment interest or charges | yes | FS-14 (late payment, delayed payments, MSMED) | — |

## Per fixture

| Fixture | Detected type | model_used | Findings | Verified rate | Approx | Not found | Recall (required) | Optional | Unmatched | Dup | Cat. agree | Out-of-enum | Repair retry | Trimmed by service | Transient retry | Calls | Latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| leave_and_license | leave_and_license (0.52) | gemini-2.5-flash | 27 | 100.0% (26/26) | 0 | 0 | 85.7% (12/14) | 3 | 12 (44.4%) | 0 | 13/15 | 0 | no | none | no | #1 | 38s |
| job_offer_letter | job_offer_letter (0.77) | gemini-2.5-flash | 31 | 100.0% (31/31) | 0 | 0 | 90.0% (9/10) | 9 | 13 (41.9%) | 0 | 12/18 | 0 | no | none | yes → ok | #2 #3 #4 | 2m 0s + retry 38s |
| nda | nda (1.00) | gemini-2.5-flash | 25 | 100.0% (25/25) | 0 | 0 | 81.8% (9/11) | 2 | 14 (56.0%) | 0 | 8/11 | 0 | no | none | yes → ok | #5 #6 #7 | 2m 0s + retry 35s |
| privacy_policy | privacy_policy (0.92) | gemini-2.5-flash | 36 | 100.0% (34/34) | 0 | 0 | 92.3% (12/13) | 5 | 19 (52.8%) | 0 | 15/17 | 0 | no | none | no | #8 | 28s |
| freelance_service_agreement | freelance_service_agreement (0.81) | gemini-2.5-flash | 23 | 100.0% (21/21) | 0 | 0 | 80.0% (8/10) | 3 | 12 (52.2%) | 0 | 9/11 | 0 | no | none | no | #9 | 31s |
| generic | generic | — | — | — | — | — | — | — | — | — | — | — | — | none | no | #10 #11 | **error** 2m 0s |

Category mix per fixture: leave_and_license deadline 4, obligation 16, penalty 4, ambiguity 2, missing_clause 1 · job_offer_letter ambiguity 6, obligation 19, deadline 2, penalty 4 · nda obligation 17, ambiguity 3, deadline 2, penalty 3 · privacy_policy obligation 27, ambiguity 2, penalty 2, deadline 3, missing_clause 2 · freelance_service_agreement obligation 13, deadline 3, penalty 3, ambiguity 2, missing_clause 2 · generic —

## Run 2 (`understand-v2`) vs Run 3 (`understand-v3`), on the fixtures both measured

| Fixture | Run | Latency | Findings | Verified | Recall (req.) | Optional | Unmatched | Cat. agree | Missing-clause findings | Missed required |
|---|---|---|---|---|---|---|---|---|---|---|
| job_offer_letter | Run 2 (`understand-v2`) | 45s | 24 | 22/22 | 10/10 | 8 | 6 | 15/18 | 2 | — |
| job_offer_letter | Run 3 (`understand-v3`) | 38s | 31 | 31/31 | 9/10 | 9 | 13 | 12/18 | 0 | JO-17 |
| privacy_policy | Run 2 (`understand-v2`) | 28s | 25 | 23/23 | 13/13 | 5 | 6 | 15/18 | 2 | — |
| privacy_policy | Run 3 (`understand-v3`) | 28s | 36 | 34/34 | 12/13 | 5 | 19 | 15/17 | 2 | PP-04 |

**Quality drop:** job_offer_letter (recall, category agreement, missing-clause findings 2 → 0, precision signal: unmatched 6/24 → 13/31); privacy_policy (recall, precision signal: unmatched 6/25 → 19/36).

## Missed required entries

| Fixture | Entry | Category | Why it matters (key) | Approximate near-miss |
|---|---|---|---|---|
| leave_and_license | LL-18 | penalty | A breach of any term, however minor (for example one guest night too many under 10.3), lets the licensor terminate immediately by notice, with no cha… | — |
| leave_and_license | LL-16 | missing_clause | The flat is let semi-furnished 'together with the furniture, fixtures, fittings and electrical appliances presently installed', and deductions are al… | — |
| job_offer_letter | JO-17 | missing_clause | The letter says nothing about leave: no annual, sick or casual leave entitlement and no reference to a leave policy. | — |
| nda | ND-12 | missing_clause | There is no exception for disclosure required by law, a court order or a regulator, and no process for notifying the other party before such disclosu… | — |
| nda | ND-13 | missing_clause | The exclusions omit two standard carve-outs: information independently developed by the receiving party, and information received lawfully from a thi… | — |
| privacy_policy | PP-04 | ambiguity | Breach notification is discretionary ('endeavour', 'where we consider it appropriate'). The DPDP Act (Section 8(6)) requires intimation of a personal… | — |
| freelance_service_agreement | FS-12 | ambiguity | Acceptance happens only when the client says the work is satisfactory 'in its sole discretion'. With no objective criteria and no deemed-acceptance p… | — |
| freelance_service_agreement | FS-13 | ambiguity | The client may withhold any amount it labels 'disputed' until the dispute is resolved, with no dispute procedure or time limit. One-sided: it lets th… | — |

Required entries credited through `carriedBy`: none.

## Every missing_clause finding

Keyword matching is fuzzy; check both the hits and the misses. Explanation is the default (first) lens.

| Fixture | Finding | Matched entries (keywords) | Assigned to | Explanation |
|---|---|---|---|---|
| leave_and_license | 6152e3dd | none | — | There is no mention of whether pets are allowed or prohibited in the premises. If you have pets or plan to get one, you should clarify this with the landlord and get it in writing before signing. |
| privacy_policy | 6da4c30b | PP-16 (children, parental, parental consent, under 18) | PP-16 | The policy does not mention specific provisions for children's data, such as minimum age requirements or parental consent mechanisms as per the DPDP Act. This is important if children might use the platform or if their data could be inadvertently collected. |
| privacy_policy | a0e3a35b | PP-17 (nomination, nominate) | PP-17 | The policy does not include a nomination clause, which is a right under the DPDP Act. This means you cannot designate someone to exercise your rights under the Act in case of your death or incapacitation. |
| freelance_service_agreement | 8f92c7c3 | FS-14 (delays in payment) | FS-14 | The agreement does not explicitly state a limit on the number of revisions or a clear process for accepting deliverables, which could lead to endless revision requests without additional pay. You should negotiate a specific number of revisions included in the… |
| freelance_service_agreement | a6709db9 | none | — | The contract does not include a 'force majeure' clause, which typically excuses parties from fulfilling obligations due to unforeseen events like natural disasters or pandemics. Without it, you could be penalized (e.g., through late delivery deductions) even … |

## Samples worth a human's eyes

- **leave_and_license** · deadline · **verified** · matches no key entry — span: "This license shall be for a period of eleven (11) months commencing from the Commencement Date and ending on 31st August, 2027 (both days inclusive), unless terminated earlier in accordance with this Agreement."
  - AI explanation (tenant_about_to_sign): This clause specifies that your license to use the premises will last for 11 months, from October 1, 2026, to August 31, 2027. Be aware of this fixed period and plan your stay accordingly.
- **leave_and_license** · penalty · **verified** · matches LL-11 — span: "If the Licensee fails to hand over vacant possession of the Licensed Premises on the expiry or earlier termination of this Agreement, the Licensee shall be liable to pay to the Licensor damages calculated at three (3) t…"
  - AI explanation (tenant_about_to_sign): If you overstay beyond the agreement's end date or early termination, you will face a severe penalty: three times the daily license fee for each day you remain. This means you could pay Rs. 3,200 per day (Rs. 32,000 / 30 days * 3). This is a very high cost, so plan your move carefully.
- **job_offer_letter** · ambiguity · **verified** · matches no key entry — span: "Your initial place of posting will be the Company's office at Bellandur, Bengaluru. The Company presently follows a hybrid working model under which you are expected to work from the office at least three (3) days a wee…"
  - AI explanation (employee_about_to_sign): This clause states your initial work location and a hybrid model, but the company can change it based on 'business requirements'. You might want to ask for more clarity on what could trigger such changes and how much notice would be given.
- **job_offer_letter** · penalty · **verified** · matches JO-10 — span: "If you resign, or if your employment is terminated for any reason whatsoever, before the completion of the Minimum Service Period, you shall pay to the Company a sum of Rs. 2,50,000/- (Rupees Two Lakh Fifty Thousand onl…"
  - AI explanation (employee_about_to_sign): If you leave the company or are terminated for any reason before completing 24 months, you will have to pay Rs. 2,50,000 as a penalty. This amount can be deducted from any money owed to you. This is a significant financial commitment to consider.
- **nda** · obligation · **verified** · matches no key entry — span: "This Mutual Non-Disclosure Agreement (this "Agreement" or this "NDA") is entered into at Mumbai on 14th September, 2026 (the "Effective Date")"
  - AI explanation (receiving_party_about_to_sign): This clause establishes the official start date of the agreement as September 14, 2026. Be aware that any information shared before this date might also be covered if the definition of "Confidential Information" includes pre-Effective Date disclosures.
- **nda** · penalty · **verified** · matches ND-11 — span: "Pixelkraft shall indemnify and keep indemnified Brightwater, its Affiliates and their respective directors and employees against all losses, damages, costs (including legal fees), claims and liabilities, including indir…"
  - AI explanation (receiving_party_about_to_sign): As Pixelkraft, you are required to fully indemnify (compensate) Brightwater, its affiliates, directors, and employees for all losses, damages, costs (including legal fees), claims, and liabilities they incur due to any breach by you or your representatives. This includes indirect and consequential …
- **privacy_policy** · obligation · **verified** · matches no key entry — span: "If you do not agree with it, please do not use the Platform."
  - AI explanation (user_about_to_sign): This means you must agree to the entire Privacy Policy to use the NestNagar Platform. If any part of it is unacceptable to you, you should not proceed.
- **privacy_policy** · ambiguity · **verified** · matches PP-03 — span: "We may share your Personal Data with our Partners, group companies and other third parties for the purposes described in this Privacy Policy, including for their own marketing and analytics purposes."
  - AI explanation (user_about_to_sign): NestNagar may share your personal data with its partners and other third parties for their own marketing and analytics. This means your data could be used by many different companies for their promotional activities, which is a broad sharing policy.
- **freelance_service_agreement** · deadline · **verified** · matches no key entry — span: "The Freelancer shall deliver each Deliverable by the Milestone Date specified for it in Schedule A."
  - AI explanation (freelancer_about_to_sign): You are required to deliver each part of the work by the specific Milestone Dates listed in Schedule A. Review these dates carefully to ensure they are realistic and achievable.
- **freelance_service_agreement** · penalty · **verified** · matches FS-08 — span: "If the Freelancer fails to deliver any Deliverable by its Milestone Date, the Client may deduct from the Fees an amount equal to two percent (2%) of the total Fees for each day of delay, without any upper limit, irrespe…"
  - AI explanation (freelancer_about_to_sign): This is a severe penalty clause. For every day a deliverable is late, you can lose 2% of the *total* project fees (Rs. 4,80,000), with no maximum limit, even if the delay is due to reasons outside your control. You should strongly negotiate for a reasonable cap on these deductions and include a for…

## Run 1 (pre-fix: schema 400) — 2026-09-23T06:48:11.939Z · prompt `understand-v1` · 5 provider calls

Found by this harness: Gemini rejected the Understand response schema (HTTP 400 INVALID_ARGUMENT, too many states) on 3/3 calls, so no document could be analysed and no fallback ran. Fixed: provider-facing schemas are sanitized in src/server/llm/provider-schema.ts; PROMPT_VERSION bumped to understand-v2 / prepare-v2.

Stopped: understand: stopped — two consecutive operations failed with UPSTREAM_UNAVAILABLE.

Outcomes: smoke:privacy_policy error · understand:leave_and_license error · understand:job_offer_letter error · understand:nda skipped · understand:privacy_policy skipped · understand:freelance_service_agreement skipped · understand:generic skipped · prepare:leave_and_license ok · prepare:job_offer_letter ok · prepare:nda skipped · prepare:privacy_policy skipped · prepare:freelance_service_agreement skipped · prepare:generic skipped · diagnose:gemini:job_offer_letter error.

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| 1 | smoke:privacy_policy | nim | google/gemma-4-31b-it | aborted | 1m 30s |
| 2 | smoke:privacy_policy | openrouter | google/gemma-4-31b-it:free | HTTP 429 | 1s |
| 3 | understand:leave_and_license | gemini | gemini-2.5-flash | HTTP 400 | 17s |
| 4 | understand:job_offer_letter | gemini | gemini-2.5-flash | HTTP 400 | 1s |
| 5 | diagnose:gemini:job_offer_letter | gemini | gemini-2.5-flash | HTTP 400 — INVALID_ARGUMENT: The specified schema produces a constraint that has too many states for serving. Typical causes of this error are schemas with lots of text (for example, very long property or enum … | 2s |

## Run 2 (pre-fix: 45 s timeout) — 2026-09-23T07:43:11.161Z · prompt `understand-v2` · 13 provider calls

Found by this harness: the product's 45 s provider timeout aborted 3 of 5 Gemini Understand calls (completed calls took 28-45 s), and each timeout cascaded through NIM and OpenRouter to a misleading 'Too many requests' after ~91 s. Fixed: per-operation timeouts (Understand 120 s, Prepare 90 s) with a chain-wide deadline, honest final errors, Understand with Gemini thinking off; PROMPT_VERSION understand-v3 / prepare-v3. Measured with thinking on (understand-v2).

Stopped: understand: stopped — two Gemini requests aborted by the client-side timeout in this part (calls 5, 9).

Outcomes: smoke:privacy_policy skipped · understand:leave_and_license error · understand:job_offer_letter ok · understand:nda error · understand:privacy_policy ok · understand:freelance_service_agreement error · understand:generic skipped · prepare:leave_and_license ok · prepare:job_offer_letter ok · prepare:nda ok · prepare:privacy_policy ok · prepare:freelance_service_agreement ok · prepare:generic skipped.

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| 1 | understand:leave_and_license | gemini | gemini-2.5-flash | network_error | 13s |
| 2 | understand:leave_and_license | nim | google/gemma-4-31b-it | aborted | 45s |
| 3 | understand:leave_and_license | openrouter | google/gemma-4-31b-it:free | HTTP 429 — 429: Provider returned error | 1s |
| 5 | understand:nda | gemini | gemini-2.5-flash | aborted | 45s |
| 6 | understand:nda | nim | google/gemma-4-31b-it | aborted | 45s |
| 7 | understand:nda | openrouter | google/gemma-4-31b-it:free | HTTP 429 — 429: Provider returned error | 1s |
| 9 | understand:freelance_service_agreement | gemini | gemini-2.5-flash | aborted | 45s |
| 10 | understand:freelance_service_agreement | nim | google/gemma-4-31b-it | aborted | 45s |
| 11 | understand:freelance_service_agreement | openrouter | google/gemma-4-31b-it:free | HTTP 429 — 429: Provider returned error | 1s |

## How each document went through the pipeline

Per fixture: `LocalFsStorageAdapter.createUploadTarget` → `writeRelayed` (the upload relay route's calls, `text/plain`) → `understand.analyze()` (`confirmUpload` → pending row → text extraction → type detection → one `llm.complete()` → `verifyMany` → one persisting transaction) → a fresh `understand.get()` with an LLM-less deps object (re-verifies every quote against the stored canonical text). The LLM client is `createContainer().forRequest(principal)` — the production composition: principal tier outside, Gemini → Gemma(NIM → OpenRouter) fallback with per-provider global tiers inside, default limits, in-memory PGlite with all migrations, a dedicated guest principal. Anchored matches require `status === "verified"`; approximate overlaps are listed as near-misses, never credited.

## Provider calls

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| 1 | understand:leave_and_license | gemini | gemini-2.5-flash | HTTP 200 | 38s (38238 ms) |
| 2 | understand:job_offer_letter | gemini | gemini-2.5-flash | network_error | 0s (217 ms) |
| 3 | understand:job_offer_letter | nim | google/gemma-4-31b-it | aborted | 2m 0s (119783 ms) |
| 4 | understand:job_offer_letter:retry | gemini | gemini-2.5-flash | HTTP 200 | 38s (37767 ms) |
| 5 | understand:nda | gemini | gemini-2.5-flash | network_error | 30s (29526 ms) |
| 6 | understand:nda | nim | google/gemma-4-31b-it | aborted | 1m 30s (90482 ms) |
| 7 | understand:nda:retry | gemini | gemini-2.5-flash | HTTP 200 | 35s (34766 ms) |
| 8 | understand:privacy_policy | gemini | gemini-2.5-flash | HTTP 200 | 28s (28295 ms) |
| 9 | understand:freelance_service_agreement | gemini | gemini-2.5-flash | HTTP 200 | 31s (31092 ms) |
| 10 | understand:generic | gemini | gemini-2.5-flash | HTTP 429 (per_day) | 0s (379 ms) |
| 11 | understand:generic | nim | google/gemma-4-31b-it | aborted | 2m 0s (119615 ms) |
