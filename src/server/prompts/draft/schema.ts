/**
 * The Draft response schema: one call returns the body text for every ai_generated section of the
 * document type's template, keyed by section key — nothing else. No status/verified/span field
 * anywhere — drafts never carry a verified badge at all, so there is nothing here to even omit by
 * accident, but llm/schema-guard.ts still enforces it structurally before any provider call. Keys
 * are read from draft-templates (aiSectionKeys) — never a hand-maintained parallel list, so a
 * template change can't silently desync from what the model is asked to fill in.
 */

import { z } from "zod";
import { aiSectionKeys, type DraftableDocumentTypeId } from "@/server/deterministic/draft-templates";

// `.refine()` enforces non-blank instead of `.min(1)`/`.regex()`: Gemini's `responseJsonSchema`
// doesn't support minLength/pattern, so those would leak an unsupported keyword into the schema;
// `.refine()` still runs during `schema.safeParse()`, so a blank body still fails validation.
function nonBlankBody(key: string) {
  return z
    .string()
    .describe(`The full body text for the "${key}" section, in plain prose/paragraphs. Do not include a heading line — the heading is added separately.`)
    .refine((value) => value.trim().length > 0, { message: `"${key}" must not be blank.` });
}

/** The response schema for one document type: one non-blank body string per ai_generated section key. */
export function buildDraftResponseSchema(documentType: DraftableDocumentTypeId) {
  const keys = aiSectionKeys(documentType);
  const shape = Object.fromEntries(keys.map((key) => [key, nonBlankBody(key)]));
  return z.object({ sections: z.object(shape) });
}

/** The zod type returned by buildDraftResponseSchema() for a given document type. */
export type DraftResponseSchema = ReturnType<typeof buildDraftResponseSchema>;
