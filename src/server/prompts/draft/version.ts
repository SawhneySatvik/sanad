/**
 * Cache-key-shaped version string (mirrors prompts/understand/analyze.ts's PROMPT_VERSION). Surfaced
 * on DraftResult.promptVersion (services/draft.ts) for audit/reporting so a generated draft can be
 * attributed to the exact prompt/schema version that produced it, even though drafts has no
 * promptVersion DB column to persist it in (get() returns null for that reason; only a fresh
 * create()/revise() result carries a real value). Not otherwise read by any code path.
 */
export const PROMPT_VERSION = "draft-v3";

/**
 * Pins the builders' (prompt.ts/schema.ts) current fixed output to a specific hash (fixed sample
 * inputs — see prompt-version.test.ts's computeDraftPromptFingerprint()), so any change to a
 * prompt/schema literal fails prompt-version.test.ts immediately, forcing whoever made the change
 * to consciously re-pin this constant. It does not itself force PROMPT_VERSION to move with it —
 * nothing checks that the two change together; bump PROMPT_VERSION above by convention whenever the
 * change is prompt-semantic rather than merely mechanical, a judgment call this test cannot make.
 */
export const PROMPT_FINGERPRINT = "d9920970557c0473b1261de5d210102a282545088af74b5247fad1ea309faf65";
