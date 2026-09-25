// RecordedLlmClient's refusal gates: a mutated prompt, native-file input, stream(), a recording that
// no longer parses through the live schema, and a recording that no longer matches its pinned hash.
// It answers only the exact call it was bound to, never anything else.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RecordedLlmClient,
  RecordedPromptMismatchError,
  RecordedSchemaMismatchError,
  RecordingTamperedError,
} from "@/server/samples/recorded-llm-client";
import { hashRecording, type RecordedUnderstandOutput } from "@/server/samples/registry";
import { buildUnderstandResponseSchema, buildUnderstandSystemPrompt, buildUnderstandUserPrompt } from "@/server/prompts/understand/analyze";

const DOCUMENT_TYPE = "leave_and_license";
const CANONICAL_TEXT = "This is a short lease document used only to test RecordedLlmClient in isolation.";
const CANONICAL_TEXT_HASH = createHash("sha256").update(CANONICAL_TEXT, "utf8").digest("hex");
const SYSTEM_PROMPT = buildUnderstandSystemPrompt(DOCUMENT_TYPE);
const USER_PROMPT = buildUnderstandUserPrompt({ canonicalText: CANONICAL_TEXT, canonicalTextHash: CANONICAL_TEXT_HASH });
const SCHEMA = buildUnderstandResponseSchema(DOCUMENT_TYPE);

const RECORDING: RecordedUnderstandOutput = {
  modelUsed: "gemini-2.5-flash",
  findings: [
    {
      category: "obligation",
      quote: "Pay rent.",
      lensExplanations: {
        tenant_about_to_sign: "x",
        tenant_already_signed: "x",
        landlord_about_to_sign: "x",
        landlord_already_signed: "x",
      },
    },
  ],
};

function fingerprintOf(systemPrompt: string, userPrompt: string): string {
  return createHash("sha256").update(systemPrompt + userPrompt, "utf8").digest("hex");
}

const EXPECTED_INPUT_FINGERPRINT = fingerprintOf(SYSTEM_PROMPT, USER_PROMPT);
const EXPECTED_RECORDING_HASH = hashRecording(RECORDING);

function client(): RecordedLlmClient {
  return new RecordedLlmClient({
    recording: RECORDING,
    expectedInputFingerprint: EXPECTED_INPUT_FINGERPRINT,
    expectedRecordingHash: EXPECTED_RECORDING_HASH,
  });
}

describe("RecordedLlmClient answers only the exact call it is bound to", () => {
  it("returns the recording when the live prompt matches exactly", async () => {
    const result = await client().complete({ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, schema: SCHEMA });
    // data is only what the response SCHEMA declares (findings) — modelUsed is never part of the
    // model's own response shape, exactly like a real adapter; it comes back as its own field.
    expect(result.data).toEqual({ findings: RECORDING.findings });
    expect(result.modelUsed).toBe("gemini-2.5-flash");
  });

  it("refuses a mutated prompt — it returns the recording instead of throwing would be the bug", async () => {
    await expect(
      client().complete({ systemPrompt: SYSTEM_PROMPT, userPrompt: `${USER_PROMPT} mutated`, schema: SCHEMA }),
    ).rejects.toThrow(RecordedPromptMismatchError);
  });

  it("rejects native-file input", async () => {
    await expect(
      client().complete({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: USER_PROMPT,
        schema: SCHEMA,
        documents: [{ nativeFile: { bytes: new Uint8Array(4), mimeType: "application/pdf" } }],
      }),
    ).rejects.toThrow();
  });

  it("stream() throws — samples never stream", () => {
    expect(() => client().stream({ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, schema: SCHEMA })).toThrow();
  });

  it("throws instead of returning unparsed output when the recording violates the live response schema", async () => {
    const badRecording = {
      modelUsed: "gemini-2.5-flash",
      findings: [{ category: "obligation", quote: "x" }], // missing lensExplanations
    } as unknown as RecordedUnderstandOutput;
    const badClient = new RecordedLlmClient({
      recording: badRecording,
      expectedInputFingerprint: EXPECTED_INPUT_FINGERPRINT,
      expectedRecordingHash: hashRecording(badRecording),
    });
    await expect(badClient.complete({ systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, schema: SCHEMA })).rejects.toThrow(
      RecordedSchemaMismatchError,
    );
  });

  it("refuses to construct at all when the recording no longer matches its pinned hash", () => {
    expect(
      () =>
        new RecordedLlmClient({
          recording: RECORDING,
          expectedInputFingerprint: EXPECTED_INPUT_FINGERPRINT,
          expectedRecordingHash: "0".repeat(64),
        }),
    ).toThrow(RecordingTamperedError);
  });
});
