# Live validation — Compare

Mode **live** · started 2026-09-23T10:22:52.903Z · wall time 42s · provider requests sent **4** (gemini-2.5-flash 1, gemini-3.5-flash-lite 3) · refused locally: 4 by a per-model cap, 0 by the total · Flash-Lite allocation 6

**Measured on the FALLBACK tier: answered by `gemini-3.5-flash-lite`.** The primary `gemini-2.5-flash` answered HTTP 429 (per_day); later primary attempts were refused locally by the harness's cap. The cap is the harness's (one real primary request per part, set because the primary was out of its daily quota when the wave was planned), not the product's.

## Concerns

None — every measured value met its threshold.

## Thresholds

| Metric | Threshold | Actual | Met | Measured on |
|---|---|---|---|---|
| Injected changes detected AND explained | 100% | 8/8 | yes | gemini-3.5-flash-lite |
| — detected (deterministic diff + verify()) | — | 8/8 | | the service's own alignment, no model |
| — explained (the model names the new value) | — | 8/8 | | the model |

## Per change

| Pair | Change | Type | Detected | Explained (mentions found) | Explanation (model text) |
|---|---|---|---|---|---|
| leave_and_license | LL-C1 | changed | yes | yes (2,25,000) | The security deposit amount has been increased from Rs. 1,50,000/- to Rs. 2,25,000/-. This means the licensee must pay a higher upfront deposit to the licensor upon signing. |
| leave_and_license | LL-C2 | changed | yes | yes (sixty) | The required notice period for the licensee to terminate the agreement after the lock-in period has been extended from thirty days to sixty days. In practice, the licensee must plan further ahead if they wish to exit the agreement. |
| leave_and_license | LL-C3 | added | yes | yes (pet, animal) | A new restriction has been added prohibiting the licensee from keeping any pet animal or bird in the licensed premises. |
| job_offer_letter | JO-C1 | removed | yes | yes (relocation) | This clause, which previously allowed the Company to reimburse up to Rs. 50,000/- for relocation expenses from Chennai to Bengaluru, has been removed entirely. In practice, this means the company will no longer cover these relocation costs. |
| job_offer_letter | JO-C2 | changed | yes | yes (90, ninety) | The resignation notice period required from the employee after confirmation has been increased from sixty (60) days to ninety (90) days. In practice, this means you must serve a longer notice period before resigning, which may delay your ability to transition… |
| freelance_service_agreement | FS-C1 | changed | yes | yes (sixty) | The payment window for undisputed invoices has been extended from thirty days to sixty days. In practice, this means the freelancer will have to wait twice as long to receive payment after submitting an invoice. |
| freelance_service_agreement | FS-C2 | removed | yes | yes (portfolio) | A clause allowing the freelancer to display the final designs in her portfolio and website after the client's public launch has been completely removed. This means the agreement no longer explicitly grants the freelancer the right to showcase this work public… |
| freelance_service_agreement | FS-C3 | added | yes | yes (generative, artificial intelligence, AI) | A new restriction has been added prohibiting the freelancer from using any generative artificial intelligence tools for the deliverables without prior written consent. This means the freelancer must create all work manually or obtain explicit permission befor… |

## Per pair

| Pair | Answered by | Latency | Persisted changes | Model quotes kept / replaced by the clause |
|---|---|---|---|---|
| leave_and_license | gemini-3.5-flash-lite | 3s | 3 | 5 / 0 |
| job_offer_letter | gemini-3.5-flash-lite | 2s | 2 | 3 / 0 |
| freelance_service_agreement | gemini-3.5-flash-lite | 2s | 3 | 4 / 0 |

## How it ran

Both versions of each pair were uploaded, confirmed and extracted server-side through `understand.analyze()`, with its analysis call deliberately declined (no provider request). `compare()` then ran on the pair through the production fallback chain: the deterministic clause alignment finds the candidates, one model call explains them, and every quote shown is re-verified against its own document. Detection is judged on the persisted change's verified span; the explanation is judged only when it is the model's own text.

## Provider requests

| # | Operation | Model (gateway) | Result | Latency |
|---|---|---|---|---|
| 1 | compare:leave_and_license | gemini-2.5-flash (gemini) | HTTP 429 (per_day) — You exceeded your current quota, please check your plan and billing details. For more inf… | 1s (1030 ms) |
| 2 | compare:leave_and_license | gemini-3.5-flash-lite (gemini) | HTTP 200 | 2s (2247 ms) |
| 3 | compare:job_offer_letter | gemini-3.5-flash-lite (gemini) | HTTP 200 | 2s (1840 ms) |
| 4 | compare:freelance_service_agreement | gemini-3.5-flash-lite (gemini) | HTTP 200 | 2s (1960 ms) |

Refused locally, never sent: compare:job_offer_letter → gemini-2.5-flash (cap); compare:job_offer_letter → gemini-2.5-flash (cap); compare:freelance_service_agreement → gemini-2.5-flash (cap); compare:freelance_service_agreement → gemini-2.5-flash (cap).
