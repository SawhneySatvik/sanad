import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@/server/core/errors";
import { completeStructured, type StructuredCallResult } from "@/server/llm/structured-output";

const schema = z.object({ answer: z.string() });

function attemptsOf(rawTexts: string[]): (repairInstruction: string | undefined) => Promise<StructuredCallResult> {
  let i = 0;
  return async () => {
    const rawText = rawTexts[i];
    i += 1;
    return { rawText, modelUsed: "m", tokensUsed: { input: 1, output: 1 } };
  };
}

describe("completeStructured", () => {
  it("returns validated data on a first-attempt success without ever calling the repair path", async () => {
    let calls = 0;
    const result = await completeStructured(schema, async (repairInstruction) => {
      calls += 1;
      expect(repairInstruction).toBeUndefined();
      return { rawText: JSON.stringify({ answer: "ok" }), modelUsed: "m", tokensUsed: { input: 3, output: 5 } };
    });
    expect(result).toEqual({ data: { answer: "ok" }, modelUsed: "m", tokensUsed: { input: 3, output: 5 } });
    expect(calls).toBe(1);
  });

  it("retries exactly once on malformed JSON, passing a repair instruction, and succeeds", async () => {
    const seenRepairInstructions: (string | undefined)[] = [];
    const call = attemptsOf(["not json", JSON.stringify({ answer: "fixed" })]);
    let calls = 0;
    const result = await completeStructured(schema, async (repairInstruction) => {
      calls += 1;
      seenRepairInstructions.push(repairInstruction);
      return call(repairInstruction);
    });
    expect(calls).toBe(2);
    expect(seenRepairInstructions[0]).toBeUndefined();
    expect(seenRepairInstructions[1]).toContain("not valid JSON");
    expect(result.data).toEqual({ answer: "fixed" });
  });

  it("retries exactly once on a schema mismatch and succeeds", async () => {
    const call = attemptsOf([JSON.stringify({ wrong: "shape" }), JSON.stringify({ answer: "fixed" })]);
    const result = await completeStructured(schema, (repairInstruction) => call(repairInstruction));
    expect(result.data).toEqual({ answer: "fixed" });
  });

  it("sums tokensUsed across both attempts when a repair retry fires", async () => {
    const call = attemptsOf(["not json", JSON.stringify({ answer: "fixed" })]);
    let n = 0;
    const result = await completeStructured(schema, async (repairInstruction) => {
      n += 1;
      const base = await call(repairInstruction);
      return { ...base, tokensUsed: { input: n, output: n * 2 } };
    });
    expect(result.tokensUsed).toEqual({ input: 1 + 2, output: 2 + 4 });
  });

  it("throws SCHEMA_FAILED after exactly one repair retry still fails, never attempting a third call", async () => {
    let calls = 0;
    const call = attemptsOf(["not json", "still not json", JSON.stringify({ answer: "would succeed but must never be reached" })]);
    await expect(
      completeStructured(schema, async (repairInstruction) => {
        calls += 1;
        return call(repairInstruction);
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_FAILED" });
    expect(calls).toBe(2);
  });

  it("propagates a provider error immediately, without consuming the repair-retry budget", async () => {
    let calls = 0;
    const providerError = new AppError("UPSTREAM_UNAVAILABLE", "upstream unavailable");
    await expect(
      completeStructured(schema, async () => {
        calls += 1;
        throw providerError;
      }),
    ).rejects.toBe(providerError);
    expect(calls).toBe(1);
  });
});
