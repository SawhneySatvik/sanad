# Gemma-path smoke — Run 1

Mode **live** · started 2026-09-23T12:53:37.815Z · wall time 2m 36s · provider calls **4/4** (gemini 4, nim 0, openrouter 0; refused locally: 6 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

## Concerns

- gemma-smoke: Gemma fallback UNVERIFIED — skipped: NIM has not answered within its timeout on 3 recorded attempts and OpenRouter's free quota is exhausted, so another attempt would spend budget without new information

**Gemma fallback: UNVERIFIED.** No live call this run — skipped: NIM has not answered within its timeout on 3 recorded attempts and OpenRouter's free quota is exhausted, so another attempt would spend budget without new information.

No Gemma gateway has returned a single completion in any recorded attempt:

| Attempt | NVIDIA NIM (primary gateway) | OpenRouter (backup) |
|---|---|---|
| First probe (20 s call-site timeout) | `google/gemma-4-31b-it`: TIMEOUT at 20,087 ms (the smoke script's 20 s call-site timeout), no HTTP response | `google/gemma-4-31b-it:free`: HTTP 429 at 878 ms |
| Second probe (60 s timeout, minimal prompt) | `google/gemma-4-31b-it`: TIMEOUT at 60,017 ms (60 s timeout, minimal prompt), no HTTP response | not called |

What this means: when Gemini fails retryably (429, 5xx, timeout), the product's fallback chain Gemini → Gemma(NIM → OpenRouter) has no gateway known to answer, so the request fails with a typed error rather than degrading to Gemma. A per-operation budget now bounds the whole chain (llm/timeouts.ts), and a secondary is not started with under 15 s of it left.
