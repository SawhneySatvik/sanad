/**
 * General-mode chat answer cache: skips the LLM call entirely for a question with no attached
 * document, no conversation history (first turn) and no citations — the only shape of turn where
 * an identical question is guaranteed to deserve an identical answer, since nothing else about the
 * conversation could have changed it. General mode never carries a verified status (there is
 * nothing to verify against), and GeneralAssistantMessage is structurally incapable of carrying one
 * (services/ask.ts's GeneralModeHasNoStatus compile-time assertion) — so replaying a cached answer,
 * however it got there, opens no path to "verified".
 */

import { createHash } from "node:crypto";
import type { SpecialistId } from "./specialist-registry";

/** 24 hours: short enough that a prompt/model change (which also changes the key) never lingers long either way. */
export const GENERAL_CHAT_CACHE_TTL_SECONDS = 24 * 60 * 60;

export interface GeneralChatCacheKeyParts {
  query: string;
  // Empty only for the non_legal redirect, which this cache never stores (see services/ask.ts).
  specialistIds: readonly SpecialistId[];
  modelId: string;
  promptVersion: string;
  // Reserved for a future situation/role input; omitted today because ask() has none to pass.
  situationOrRole?: string;
}

// Trim, collapse internal whitespace, lowercase — so "What does  RENT  mean?" and "what does rent
// mean?" share one entry, matching how a human would judge two questions "the same".
function normalizeQuestion(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

export function generalChatCacheKey(parts: GeneralChatCacheKeyParts): string {
  const encoded = JSON.stringify([
    normalizeQuestion(parts.query),
    parts.situationOrRole ?? null,
    parts.specialistIds,
    parts.modelId,
    parts.promptVersion,
  ]);
  return `chat:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

/** What the cache stores: the model's answer text and enough to reconstruct the turn's final event. */
export interface CachedGeneralAnswer {
  answer: string;
  modelUsed: string;
  routedDomains: string[];
}

// Never trusts a cached payload's shape: a malformed or hand-edited entry is a miss, not an error —
// same policy as understand.ts's own result-cache parse.
export function parseCachedGeneralAnswer(raw: string): CachedGeneralAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { answer, modelUsed, routedDomains } = parsed as Record<string, unknown>;
  if (typeof answer !== "string" || typeof modelUsed !== "string") return null;
  if (!Array.isArray(routedDomains) || !routedDomains.every((domain) => typeof domain === "string")) return null;
  return { answer, modelUsed, routedDomains };
}
