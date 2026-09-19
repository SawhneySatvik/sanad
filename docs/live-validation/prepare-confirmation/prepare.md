# Live validation — Prepare, structural — Run 1

Mode **live** · started 2026-09-23T12:53:37.815Z · wall time 2m 36s · provider calls **4/4** (gemini 4, nim 0, openrouter 0; refused locally: 6 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

## Concerns

- prepare/nda: answered by the fallback model gemini-3.5-flash-lite
- prepare/leave_and_license: answered by the fallback model gemini-3.5-flash-lite

Schema: PASS — Prepare response schema has no status/span field: no status/verified/span key anywhere in the JSON schema.

## Per fixture

| Fixture | State | model_used | Questions | Checklist | Checklist gaps offered / cited | Checks passed | Failed checks | Calls | Time |
|---|---|---|---|---|---|---|---|---|---|
| nda | complete | gemini-3.5-flash-lite | 5 | 5 | 2 / 2 | 12/12 | — | #2 | 4s |
| leave_and_license | complete | gemini-3.5-flash-lite | 5 | 5 | 0 / 0 | 12/12 | — | #4 | 46s |

Checks run per completed fixture: typed state · non-empty · within caps · every item references real finding ids · every referenced finding is grounded (eligible) · statuses/spans are get()'s, not the model's · spanText is the canonical slice · markdown: not-legal-advice notice · markdown: every model-written line has its AI prefix · markdown: no badge glyphs · unquoted findings cited under the not-checked label, with no status · no internal finding aliases (F1…) in AI-written text.

## One question per fixture

- **nda** — AI-suggested: How can we negotiate the sole appointment of the arbitrator by Brightwater, and can we agree on a neutral arbitrator or an independent institution instead?
  - grounded in: obligation/verified: "10.2 Any dispute arising out of or in connection with this Agreement shall be referred to arbitration by a sole arbitra…"
- **leave_and_license** — AI-suggested: How can we legally challenge or modify the clause allowing the landlord to terminate the agreement on 15 days' notice while I am bound by an 8-month lock-in period?
  - grounded in: deadline/verified: "The Licensee agrees that the first eight (8) months of the License Period, that is, from 1st October, 2026 to 31st May,…"; penalty/verified: "If the Licensee terminates this Agreement or vacates the Licensed Premises for any reason before the expiry of the lock…"; deadline/verified: "The Licensor may terminate this Agreement at any time, including during the lock-in period, by giving the Licensee fift…"

## Provider calls

| # | Operation | Provider | Model | Result | Latency |
|---|---|---|---|---|---|
| 2 | prepare:nda | gemini | gemini-3.5-flash-lite | HTTP 200 | 4s (4040 ms) |
| 4 | prepare:leave_and_license | gemini | gemini-3.5-flash-lite | HTTP 200 | 46s (45842 ms) |

Refused locally, never sent: understand:nda → gemini-2.5-flash (cap); understand:nda → gemini-2.5-flash (cap); prepare:nda → gemini-2.5-flash (cap); prepare:nda → gemini-2.5-flash (cap); understand:leave_and_license → gemini-2.5-flash (cap); understand:leave_and_license → gemini-2.5-flash (cap).
