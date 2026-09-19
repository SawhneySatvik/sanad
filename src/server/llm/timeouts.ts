/**
 * Per-operation LLM budgets. Each service passes its own as `timeoutMs`, bounding the whole provider
 * chain: in FallbackLlmClient each tier may spend at most TIER_BUDGET_SHARE of it while a later tier
 * could still run, and the last runnable tier gets whatever is left. Measured on gemini-2.5-flash at
 * ~200-225 output tokens/s; see each key below.
 */
export const LLM_TIMEOUT_MS = {
  // Measured 35.2 s (thinking off, the setting sent) on the largest fixture; 120 s also covers
  // default thinking's 59.7 s if that is ever enabled.
  understand: 120_000,
  // Not measured: output is the whole document's text, comparable to Understand's.
  transcribe: 120_000,
  // Measured 22 s and 39 s; 90 s is 2.3x the slowest.
  prepare: 90_000,
  // Not measured: at most MAX_CHANGES (50) changes explained, sized like Prepare.
  compare: 90_000,
  // Not measured: several prose sections, the longest output after Understand.
  draft: 120_000,
  // Not measured: short output but default thinking; combined Ask-turn wait is 120 s.
  askSpecialist: 60_000,
  askSynthesis: 60_000,
} as const;

/**
 * Per-operation cap on a call's user prompt, in characters — nearly all of it the document text the
 * call sends. A prompt over it is refused with a typed error before any request; nothing is ever
 * cut to fit. English legal text runs about 4 characters per token, so 120,000 characters is about
 * 30k input tokens: at the global cap of 7 primary calls a minute (rate-limit/limiter.ts) that is
 * ~210k tokens a minute, under the 250k input tokens per minute of the published Gemini free tier
 * (not verified against a live account). AI Studio publishes 15k tokens per minute for Gemma 3,
 * so if the Gemma tier there has the same limit it can answer only prompts under about 60,000
 * characters. Devanagari text costs more tokens per character, up to about twice as much near the
 * cap. The same size as Ask's MAX_DOCUMENTS_TOTAL_CHARS (orchestrator/config.ts).
 */
export const MODEL_INPUT_BUDGET_CHARS = {
  // The whole canonical text. Consumer leases, offer letters, NDAs and policies typically run
  // 3-60k characters (the largest live fixture is 14k). Latency is set by output, not input: the
  // response is capped at MAX_FINDINGS findings whatever the document's length.
  understand: 120_000,
  // Each candidate change's clauses, already cut to 1,200 characters apiece: 50 fully cut changes
  // come to about 125k, so only near that extreme is a comparison refused.
  compare: 120_000,
  // Findings, not the document: typically 10-25k, but 40 findings quoting up to 4,000 characters
  // each can exceed it.
  prepare: 120_000,
  // The instructions (at most 4,000), the previous sections on a revision, and the grounding
  // document — which is what can exceed it.
  draft: 120_000,
} as const;

/** No fallback tier or retry starts with less than this left: the fastest measured structured answer was 22 s. */
export const MIN_FALLBACK_BUDGET_MS = 15_000;

/**
 * The most of an operation's budget one tier may spend while another could still answer after it.
 * 0.75 keeps the primary above its slowest measured answers (Understand 45 s of 90, Prepare 39 s of
 * 67.5) while leaving the next tier at least a quarter of the budget.
 */
export const TIER_BUDGET_SHARE = 0.75;
