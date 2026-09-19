/**
 * Bump on any change to the orchestrator's prompts (specialists.ts, synthesis.ts) or the
 * response schema they target (orchestrator/schema.ts) — mirrors
 * src/server/prompts/understand/analyze.ts's PROMPT_VERSION convention.
 */
export const PROMPT_VERSION = "orchestrator-v2";

/**
 * A sha256 hex pin of every fixed prompt string (every specialist role x mode, the synthesis
 * prompt x mode, the non_legal redirect) plus the response schema's JSON shape — see
 * version.test.ts's `computePromptFingerprint()` for exactly what's hashed. A mismatch means a
 * prompt or the schema changed without a matching PROMPT_VERSION bump. Recompute via
 * version.test.ts's helper when a prompt change is intentional, then update both this constant
 * and PROMPT_VERSION above together.
 */
export const PROMPT_FINGERPRINT = "e2b519d51c34fa7b4919dfe2475b751bce1cfd21f43e8d72d636d68ec3099ca8";
