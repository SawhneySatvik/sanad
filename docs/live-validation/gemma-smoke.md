# Gemma-path smoke — Run 3

Mode **live** · started 2026-09-23T08:42:47.655Z · wall time 8m 52s · provider calls **11/25** (gemini 8, nim 3, openrouter 0; refused locally: 0 by a per-model cap, 0 by the budget) · primary model `gemini-2.5-flash` · prompts `understand-v3`, `prepare-v3`

**Stopped early:** prepare: stopped — quota exhausted at call 10 (gemini, gemini-2.5-flash, HTTP 429, window per_day)

## Concerns

- gemma-smoke: Gemma fallback UNVERIFIED — skipped: NIM has not answered within its timeout on 3 recorded attempts and OpenRouter's free quota is exhausted, so another attempt would spend budget without new information

**Gemma fallback: UNVERIFIED.** No live call this run — skipped: NIM has not answered within its timeout on 3 recorded attempts and OpenRouter's free quota is exhausted, so another attempt would spend budget without new information.

No Gemma gateway has returned a single completion in any recorded attempt:

| Attempt | NVIDIA NIM (primary gateway) | OpenRouter (backup) |
|---|---|---|
| First probe (20 s call-site timeout) | `google/gemma-4-31b-it`: TIMEOUT at 20,087 ms (the smoke script's 20 s call-site timeout), no HTTP response | `google/gemma-4-31b-it:free`: HTTP 429 at 878 ms |
| validate:live understand run 1 (smoke, 90 s per gateway) | `google/gemma-4-31b-it`: aborted at 90,006 ms | `google/gemma-4-31b-it:free`: HTTP 429 at 966 ms |
| Second probe (60 s timeout, minimal prompt) | `google/gemma-4-31b-it`: TIMEOUT at 60,017 ms (60 s timeout, minimal prompt), no HTTP response | not called |
| validate:live understand run 2 (product fallback) | `google/gemma-4-31b-it`: aborted at 45,002 ms; `google/gemma-4-31b-it`: aborted at 45,006 ms; `google/gemma-4-31b-it`: aborted at 45,005 ms | `google/gemma-4-31b-it:free`: HTTP 429 at 837 ms; `google/gemma-4-31b-it:free`: HTTP 429 at 892 ms; `google/gemma-4-31b-it:free`: HTTP 429 at 846 ms |
| validate:live understand run 3 (product fallback) | `google/gemma-4-31b-it`: aborted at 119,783 ms; `google/gemma-4-31b-it`: aborted at 90,482 ms; `google/gemma-4-31b-it`: aborted at 119,615 ms | not called |

What this means: when Gemini fails retryably (429, 5xx, timeout), the product's fallback chain Gemini → Gemma(NIM → OpenRouter) has no gateway known to answer, so the request fails with a typed error rather than degrading to Gemma. A per-operation budget now bounds the whole chain (llm/timeouts.ts), and a secondary is not started with under 15 s of it left.
