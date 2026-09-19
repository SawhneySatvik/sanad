// Pins PROMPT_FINGERPRINT to the prompt builders' + response schema's current fixed output: a
// prompt/schema literal changed without a matching PROMPT_VERSION + fingerprint update fails this
// test loud, instead of silently serving stale-cache-keyed behavior under an unchanged version string.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toProviderJsonSchema } from "@/server/llm/provider-schema";
import { DRAFTABLE_DOCUMENT_TYPE_IDS, type DraftableDocumentTypeId } from "@/server/deterministic/draft-templates";
import { buildDraftRevisionUserPrompt, buildDraftSystemPrompt, buildDraftUserPrompt } from "@/server/prompts/draft/prompt";
import { buildDraftResponseSchema } from "@/server/prompts/draft/schema";
import { PROMPT_FINGERPRINT, PROMPT_VERSION } from "@/server/prompts/draft/version";

const FIXED_GROUNDING_DOCUMENT = { canonicalText: "FIXTURE grounding text.", canonicalTextHash: "0".repeat(64) };

// The schema part is the provider-facing schema (llm/provider-schema.ts), not raw z.toJSONSchema —
// the wire shape is z.toJSONSchema's minus `$schema`, which the provider-facing schema does not
// send, so pinning it does not need a PROMPT_VERSION bump.

export function computeDraftPromptFingerprint(): string {
  const parts: string[] = [];
  for (const documentType of DRAFTABLE_DOCUMENT_TYPE_IDS as readonly DraftableDocumentTypeId[]) {
    parts.push(buildDraftSystemPrompt(documentType, "from_scratch", false));
    parts.push(buildDraftSystemPrompt(documentType, "document_grounded", true));
    parts.push(buildDraftSystemPrompt(documentType, "document_grounded", false));
    parts.push(JSON.stringify(toProviderJsonSchema(buildDraftResponseSchema(documentType))));
    parts.push(
      buildDraftUserPrompt({
        documentType,
        jurisdiction: "IN",
        userInstructions: "FIXTURE instructions.",
      }),
    );
    parts.push(
      buildDraftUserPrompt({
        documentType,
        jurisdiction: "IN",
        userInstructions: "FIXTURE instructions.",
        groundingDocument: FIXED_GROUNDING_DOCUMENT,
      }),
    );
    parts.push(
      buildDraftRevisionUserPrompt({
        documentType,
        jurisdiction: "IN",
        userInstructions: "FIXTURE revision instructions.",
        previousSections: [{ key: "fixture_key", content: "FIXTURE previous content." }],
      }),
    );
  }
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

describe("draft prompt version pinning", () => {
  it("PROMPT_VERSION is non-blank", () => {
    expect(PROMPT_VERSION).toMatch(/\S/);
  });

  it("PROMPT_FINGERPRINT matches the builders' current fixed output — a mismatch means bump PROMPT_VERSION and update PROMPT_FINGERPRINT", () => {
    expect(computeDraftPromptFingerprint()).toBe(PROMPT_FINGERPRINT);
  });
});
