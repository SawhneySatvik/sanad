/**
 * An LlmClient adapter that never calls a provider: it replays exactly one recorded Understand
 * output. Constructed fresh per open, bound to exactly one sample's recording — never shared or
 * reused across requests, so a stale binding can never leak from one caller's replay into another's.
 * The one importer this is meant for is src/server/samples/open.ts; samples-isolation.test.ts pins
 * that no other production module reaches it.
 */

import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import { AppError } from "@/server/core/errors";
import { assertDocumentsWithinCapabilities } from "@/server/llm/capabilities";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";
import type { LlmCapabilities, LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import { hashRecording, type RecordedUnderstandOutput } from "./registry";

export interface RecordedLlmClientOptions {
  recording: RecordedUnderstandOutput;
  /** sha256 of this exact document's system+user prompt, pinned when the recording was reshaped. */
  expectedInputFingerprint: string;
  /** sha256 of the recording's own JSON, pinned the same way — refuses a hand-edited recording file. */
  expectedRecordingHash: string;
}

/** A recording no longer hashes to its pin — edited (or passed a wrong pin) after the fact. */
export class RecordingTamperedError extends AppError {
  constructor() {
    super("SCHEMA_FAILED", "A sample recording no longer matches its pinned hash.");
  }
}

/** The live call's system+user prompt doesn't match what this client is bound to answer. */
export class RecordedPromptMismatchError extends AppError {
  constructor() {
    super("SCHEMA_FAILED", "A sample replay's prompt didn't match the recording it was bound to.");
  }
}

/** The recording doesn't parse through the caller's own response schema. */
export class RecordedSchemaMismatchError extends AppError {
  constructor() {
    super("SCHEMA_FAILED", "A sample recording no longer matches the live response schema.");
  }
}

function promptFingerprint(systemPrompt: string, userPrompt: string): string {
  return createHash("sha256").update(systemPrompt + userPrompt, "utf8").digest("hex");
}

/** Replays one recording as if it were a real LlmClient — see the module header. */
export class RecordedLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities = { structuredOutput: true, nativeDocumentInput: false, streaming: false };

  private readonly recording: RecordedUnderstandOutput;
  private readonly expectedInputFingerprint: string;

  constructor(options: RecordedLlmClientOptions) {
    // Checked at construction, not first use: a client bound to a tampered recording refuses to
    // exist at all, rather than existing and merely refusing its one call.
    if (hashRecording(options.recording) !== options.expectedRecordingHash) {
      throw new RecordingTamperedError();
    }
    this.recording = options.recording;
    this.expectedInputFingerprint = options.expectedInputFingerprint;
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    // Same guards a real adapter runs, so a sample call is refused by exactly the same rules a live
    // one would be — never a softer path just because nothing is actually called over the network.
    assertDocumentsWithinCapabilities(this.capabilities, input.documents);
    assertSafeResponseSchema(input.schema);
    if (promptFingerprint(input.systemPrompt, input.userPrompt) !== this.expectedInputFingerprint) {
      throw new RecordedPromptMismatchError();
    }
    const parsed = input.schema.safeParse(this.recording);
    if (!parsed.success) {
      throw new RecordedSchemaMismatchError();
    }
    // Samples never spend the real model's tokens; zero is honest, not a real usage figure.
    return { data: parsed.data, modelUsed: this.recording.modelUsed, tokensUsed: { input: 0, output: 0 } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- keeps the real LlmClient signature, unlike the real adapters this never reads its argument
  stream<Schema extends ZodType>(_input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    throw new Error("RecordedLlmClient never streams: samples replay through complete() only.");
  }
}
