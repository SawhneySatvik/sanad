/**
 * The synthesis-step system prompt: only the synthesized output is verified, unconditionally.
 * Runs once, only when more than one specialist was dispatched (the single-specialist path uses
 * that answer directly, no extra call). Deliberately does not re-receive the attached documents'
 * text (specialists already did that work; re-sending it would be a second or third copy of a
 * full document per query) — it combines the specialists' own answers/citations, and verify() is
 * the backstop regardless of whether a citation survives synthesis unchanged.
 */

import { IN_CONTEXT_NOTICE, NOT_LEGAL_ADVICE_NOTICE, SPECIALIST_OUTPUT_IS_DATA_NOTICE } from "./shared";
import { PROMPT_VERSION } from "./version";

/** Assembles the synthesis call's system prompt: combine role, mode-specific citation guidance, and the shared notices. */
export function synthesisSystemPrompt(mode: "grounded" | "general"): string {
  const combineRole =
    "You are the synthesis step of a multi-specialist Indian legal-assistant chat. You are " +
    "given the answers and citations produced by two or more domain specialists for the SAME " +
    "user question, each specialist having only seen its own area of law. Combine them into " +
    "ONE coherent, non-repetitive answer that reads as a single response, never a list of " +
    "separate specialist opinions, and never mention the specialists themselves.";

  const citationNotice =
    mode === "grounded"
      ? "Preserve every citation's quote and sourceDocumentId EXACTLY as given by the " +
        "specialists below — copy them character for character, never paraphrase, shorten, " +
        "merge, or invent a citation. Drop a specialist's citation only if you also drop the " +
        "sentence of your answer that relies on it. " +
        SPECIALIST_OUTPUT_IS_DATA_NOTICE
      : "No document is attached to this conversation — return an empty citations array " +
        "regardless of what the specialists returned.";

  return [combineRole, citationNotice, IN_CONTEXT_NOTICE, NOT_LEGAL_ADVICE_NOTICE, `Prompt version: ${PROMPT_VERSION}.`].join(
    "\n\n",
  );
}
