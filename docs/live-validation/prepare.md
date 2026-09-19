# Live validation — Prepare, structural — Run 3

Mode **live** · started 2026-09-23T08:42:47.655Z · wall time 8m 52s · provider calls **11/25** (gemini 8, nim 3, openrouter 0; refused locally: 0 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

**Stopped early:** prepare: stopped — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)

## Concerns

- prepare: LLM path NOT MEASURED — 0/6 documents produced Prepare output; only the zero-call checks below ran
- prepare/leave_and_license: not run — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)
- prepare/job_offer_letter: not run — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)
- prepare/nda: not run — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)
- prepare/privacy_policy: not run — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)
- prepare/freelance_service_agreement: not run — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)

### Reviewer notes (human review of this run's output)

- Prepare: this Run 3 Prepare never ran (the primary's daily quota ran out first). The current Prepare version was confirmed live separately, on the fallback model gemini-3.5-flash-lite, in docs/live-validation/prepare-confirmation/: 2 documents (the NDA and the leave and license), 12/12 checks each, 0 internal finding aliases in 20 AI-written items, and both NDA checklist gaps cited under the not-checked label with no status.

Schema: PASS — Prepare response schema has no status/span field: no status/verified/span key anywhere in the JSON schema.

## Per fixture

| Fixture | State | model_used | Questions | Checklist | Checklist gaps offered / cited | Checks passed | Failed checks | Calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| leave_and_license | skipped (quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)) | — | 0 | 0 | — | 0/0 | — | — | 0s |
| job_offer_letter | skipped (quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)) | — | 0 | 0 | — | 0/0 | — | — | 0s |
| nda | skipped (quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)) | — | 0 | 0 | — | 0/0 | — | — | 0s |
| privacy_policy | skipped (quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)) | — | 0 | 0 | — | 0/0 | — | — | 0s |
| freelance_service_agreement | skipped (quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)) | — | 0 | 0 | — | 0/0 | — | — | 0s |
| generic | not_analyzed | — | 0 | 0 | — | 1/1 | — | — | 0s |

Checks run per completed fixture: typed state.

## One question per fixture

None — no Prepare output was generated.

## Provider calls

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| — | none | | | | |
