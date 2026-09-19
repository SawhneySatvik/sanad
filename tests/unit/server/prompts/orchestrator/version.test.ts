// Pins a hash of every fixed prompt string + the response schema's JSON shape, so a prompt/schema
// edit that forgets to bump PROMPT_VERSION fails loud here instead of silently invalidating
// cached/logged output keyed on that version string.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toProviderJsonSchema } from "@/server/llm/provider-schema";
import { specialistOutputSchema } from "@/server/orchestrator/schema";
import { SPECIALIST_IDS } from "@/server/orchestrator/specialist-registry";
import { NON_LEGAL_REDIRECT_MESSAGE } from "@/server/prompts/orchestrator/redirect";
import { specialistSystemPrompt } from "@/server/prompts/orchestrator/specialists";
import { synthesisSystemPrompt } from "@/server/prompts/orchestrator/synthesis";
import { PROMPT_FINGERPRINT } from "@/server/prompts/orchestrator/version";

// Every fixed string this prompt package can produce, plus the response schema's JSON shape —
// concatenated with a NUL separator (never a valid character in these strings) so adjacent parts
// can't be confused for one longer part. The schema is the provider-facing one, not raw z.toJSONSchema.
export function computePromptFingerprint(): string {
  const parts: string[] = [];
  for (const id of SPECIALIST_IDS) {
    parts.push(specialistSystemPrompt(id, "grounded"));
    parts.push(specialistSystemPrompt(id, "general"));
  }
  parts.push(synthesisSystemPrompt("grounded"));
  parts.push(synthesisSystemPrompt("general"));
  parts.push(NON_LEGAL_REDIRECT_MESSAGE);
  parts.push(JSON.stringify(toProviderJsonSchema(specialistOutputSchema)));
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

describe("prompt fingerprint pin", () => {
  it("matches PROMPT_FINGERPRINT", () => {
    expect(computePromptFingerprint(), "prompt changed — bump PROMPT_VERSION and update the hash").toBe(PROMPT_FINGERPRINT);
  });
});
