/**
 * Shared structured-output validation with exactly one bounded repair retry on schema failure.
 * Every adapter calls this instead of validating inline, so the retry bound lives in one place. A
 * provider error (already normalized to an AppError by the caller) is not retried here — it
 * propagates immediately. The repair budget is only for "the model answered but the answer doesn't
 * parse/validate", never for "the provider failed to answer at all" (see fallback.ts).
 */

import type { ZodType, z } from "zod";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { assertSafeResponseSchema } from "./schema-guard";
import type { LlmTokensUsed } from "./types";

/** What one provider call returned, before schema validation. */
export interface StructuredCallResult {
  rawText: string;
  modelUsed: string;
  tokensUsed: LlmTokensUsed;
}

/** A schema-validated structured LLM result. */
export interface StructuredResult<Schema extends ZodType> {
  data: z.infer<Schema>;
  modelUsed: string;
  tokensUsed: LlmTokensUsed;
}

const MAX_ATTEMPTS = 2; // one original call + exactly one bounded repair retry

/** Runs `callProvider`, validates against `schema`, retries once with a repair instruction, then throws SCHEMA_FAILED. */
export async function completeStructured<Schema extends ZodType>(
  schema: Schema,
  // `repairInstruction` is undefined on the first (original) attempt, and a
  // human-readable description of what failed on the second (repair) attempt.
  callProvider: (repairInstruction: string | undefined) => Promise<StructuredCallResult>,
): Promise<StructuredResult<Schema>> {
  // Backstop: the primary check runs earlier, at each adapter's complete()/stream() entry point
  // (before any provider call, so a bad schema never spends quota) — this means a future call site
  // that forgets that check still can't return a forbidden key through this function.
  assertSafeResponseSchema(schema);

  let lastIssue: string | undefined;
  let totalInput = 0;
  let totalOutput = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const repairInstruction = attempt === 0 ? undefined : buildRepairInstruction(lastIssue);
    const result = await callProvider(repairInstruction);
    totalInput += result.tokensUsed.input;
    totalOutput += result.tokensUsed.output;

    const parsedJson = tryParseJson(result.rawText);
    if (parsedJson.ok) {
      const validated = schema.safeParse(parsedJson.value);
      if (validated.success) {
        return {
          data: validated.data,
          modelUsed: result.modelUsed,
          tokensUsed: { input: totalInput, output: totalOutput },
        };
      }
      lastIssue = summarizeZodError(validated.error);
    } else {
      lastIssue = "the response was not valid JSON";
    }
  }

  throw new AppError("SCHEMA_FAILED", safeMessageFor("SCHEMA_FAILED"));
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** The user-message text appended to a repair retry, describing what failed validation. */
export function buildRepairInstruction(issue: string | undefined): string {
  return (
    `Your previous response did not satisfy the required schema (${issue ?? "validation failed"}). ` +
    `Return ONLY corrected JSON that matches the schema exactly, with no extra commentary and no markdown fences.`
  );
}
