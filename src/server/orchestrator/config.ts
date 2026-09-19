/** Fan-out cap: specialists dispatched in parallel for one query — a cost and token-budget control. */
export const MAX_SPECIALISTS = 2;

/**
 * Context-cap constants below: the binding constraint is the shared free-tier per-minute
 * request/token budget (src/server/rate-limit/limiter.ts), combined with MAX_SPECIALISTS parallel
 * copies of the same attached document(s) per turn. Conversational turns kept; anything older is
 * dropped, never truncated.
 */
export const MAX_HISTORY_TURNS = 12;
/** History-text char budget; whole turns drop from the oldest end, a single turn is never cut mid-string. */
export const MAX_HISTORY_CHARS = 6_000;
/** Document-text char budget per call; a set exceeding it is rejected outright, never silently truncated. */
export const MAX_DOCUMENTS_TOTAL_CHARS = 120_000;
