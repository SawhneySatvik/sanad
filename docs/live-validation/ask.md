# Live validation — Ask

Mode **live** · started 2026-09-23T10:16:09.941Z · wall time 1m 3s · provider requests sent **4** (gemini-2.5-flash 1, gemini-3.5-flash-lite 3) · refused locally: 6 by a per-model cap, 0 by the total · Flash-Lite allocation 5

**Measured on the primary AND the FALLBACK tier (see each row's model): answered by `gemini-2.5-flash`, `gemini-3.5-flash-lite`.** The primary `gemini-2.5-flash` answered HTTP 200; later primary attempts were refused locally by the harness's cap. The cap is the harness's (one real primary request per part, since the primary's daily quota is scarce), not the product's.

## Concerns

- routing: 24/30 meets the 80% bar exactly, with no slack (misses: JO-Q9, JO-Q10, ND-Q6, FS-Q10, GN-Q8, GN-Q10)

## Thresholds

| Metric | Threshold | Actual | Met | Measured on |
|---|---|---|---|---|
| Routing: classifier's top choice, 30 non-grounded questions | ≥80% | 80.0% (24/30) | yes (no slack) | the deterministic classifier, locally (no model involved), as of 2026-09-23T13:01:58.749Z; the live answers below are from the run of 2026-09-23T10:16:09.941Z |
| Grounded answers: citation verified rate | ≥90% | 100.0% (6/6) | yes — 3 answers only | gemini-2.5-flash, gemini-3.5-flash-lite |
| General answers: no citation, status or badge anywhere | 100% | 1/1 | yes — 1 answer only | gemini-3.5-flash-lite |
| Non-legal questions redirected, no model call | all non-ambiguous | 5/5 | yes | ask() end to end, 0 provider requests |

Grounded questions' routing (reported, not gated; the attached document decides it): 24/30.

## Routing misses (locally, deterministic classifier)

| Question | Kind | Classifier's top choice | Expected | Acceptable |
|---|---|---|---|---|
| JO-Q9 | routing | employment | privacy | — |
| JO-Q10 | routing | contracts_nda | employment | — |
| ND-Q6 | general | general_legal | contracts_nda | — |
| FS-Q10 | routing | contracts_nda | freelance | — |
| GN-Q8 | routing | freelance | contracts_nda | — |
| GN-Q10 | routing | general_legal | contracts_nda | — |

## Live answers

| Question | Kind | Answered by | Routed to | Latency | Citations: verified / approx / not found | Overlaps the marked passage | Answer (excerpt) |
|---|---|---|---|---|---|---|---|
| LL-Q2 | grounded | gemini-2.5-flash | tenancy | 5s | 4 / 0 / 0 | yes | Yes, if you move out in April 2027, you will have to pay an extra amount. Your Leave and License Agreement includes a lock-in period for the first eight months, which runs from October 1, 2026, to May 31, 2027. Since Ap… |
| JO-Q1 | grounded | gemini-3.5-flash-lite | employment | 2s | 1 / 0 / 0 | yes | Your total fixed gross salary is Rs. 1,33,218 per month, as shown in Annexure A. |
| FS-Q1 | grounded | gemini-3.5-flash-lite | freelance | 3s | 1 / 0 / 0 | yes | Under the agreement, you will get paid after raising an invoice for each milestone following the client's written acceptance of the deliverables for that milestone. The client is required to pay each undisputed invoice … |
| PP-Q5 | general | gemini-3.5-flash-lite | privacy | 3s | — (general) | — | Under the Digital Personal Data Protection (DPDP) Act, 2023, you are referred to as a "Data Principal" and you hold several key rights regarding your personal data. These include: 1. Right to Information: The right to o… |

Questions:
- LL-Q2: If I move out in April 2027, will I have to pay anything extra?
- JO-Q1: What is my fixed salary per month, leaving out the variable pay?
- FS-Q1: When will I get paid for each milestone?
- PP-Q5: What rights do I have over my personal data under the DPDP Act, 2023?

## Citations (as a reader sees them)

- LL-Q2 · **verified** — span: "This license shall be for a period of eleven (11) months commencing from the Commencement Date and ending on 31st August, 2027 (both days inclusive), unless terminated earlier in accordance with this Agreement."
- LL-Q2 · **verified** · overlaps the marked passage — span: "The Licensee agrees that the first eight (8) months of the License Period, that is, from 1st October, 2026 to 31st May, 2027, shall be a lock-in period during which the Licensee shall not terminate this Agreement or vac…"
- LL-Q2 · **verified** · overlaps the marked passage — span: "If the Licensee terminates this Agreement or vacates the Licensed Premises for any reason before the expiry of the lock-in period, the Licensee shall be liable to pay to the Licensor the License Fee for the entire unexp…"
- LL-Q2 · **verified** — span: "The Licensee shall pay to the Licensor a monthly License Fee of Rs. 32,000/- (Rupees Thirty-Two Thousand only) for the use of the Licensed Premises."
- JO-Q1 · **verified** · overlaps the marked passage — span: "Total Fixed Gross \| 15,98,614 \| 1,33,218"
- FS-Q1 · **verified** · overlaps the marked passage — span: "The Freelancer shall raise an invoice for each Milestone after the Client's written acceptance of the Deliverables for that Milestone, and the Client shall pay each undisputed invoice within thirty (30) days of receivin…"

## General-mode structure

- PP-Q5: mode `general`, label "General information, not verified against a document.", redirect false, forbidden keys found: none

## Non-legal questions (ask() end to end)

- NL-Q1: redirect true, model_used `none`, provider requests 0
- NL-Q2: redirect true, model_used `none`, provider requests 0
- NL-Q3: redirect true, model_used `none`, provider requests 0
- NL-Q4: redirect true, model_used `none`, provider requests 0
- NL-Q5: redirect true, model_used `none`, provider requests 0
- NL-Q6 (ambiguous, not scored): classified legal locally; classified legal locally, so a live run would spend a model call

## How it ran

Grounded documents were uploaded, confirmed and extracted server-side through `understand.analyze()`; its analysis call was deliberately declined (no provider request), so each document is `ready` with extracted text only, which is all Ask reads. Each live question went through `ask()` → the orchestrator → the production fallback chain from `createContainer().forRequest()`. Citations were re-verified by the service against the document's canonical text.

## Provider requests

| # | Operation | Model (gateway) | Result | Latency |
|---|---|---|---|---|
| 1 | ask:LL-Q2 | gemini-2.5-flash (gemini) | HTTP 200 | 3s (3145 ms) |
| 2 | ask:JO-Q1 | gemini-3.5-flash-lite (gemini) | HTTP 200 | 1s (1392 ms) |
| 3 | ask:FS-Q1 | gemini-3.5-flash-lite (gemini) | HTTP 200 | 1s (1374 ms) |
| 4 | ask:PP-Q5 | gemini-3.5-flash-lite (gemini) | HTTP 200 | 1s (1018 ms) |

Refused locally, never sent: ask:JO-Q1 → gemini-2.5-flash (cap); ask:JO-Q1 → gemini-2.5-flash (cap); ask:FS-Q1 → gemini-2.5-flash (cap); ask:FS-Q1 → gemini-2.5-flash (cap); ask:PP-Q5 → gemini-2.5-flash (cap); ask:PP-Q5 → gemini-2.5-flash (cap).
