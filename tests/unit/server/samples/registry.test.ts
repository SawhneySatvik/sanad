// Registry gates: the schema round-trip and claimedQuote fidelity over every shipped recording, the
// pre-replay staleness check (positive and negative), and the CI prompt-divergence pin. See
// src/server/samples/registry.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildUnderstandResponseSchema, PROMPT_FINGERPRINT, PROMPT_VERSION } from "@/server/prompts/understand/analyze";
import {
  allSampleEntries,
  assertSampleIsLive,
  hashRecording,
  pinnedPromptSignature,
  pinsOf,
  recomputeSamplePins,
  type RecordedUnderstandOutput,
} from "@/server/samples/registry";

// The still-in-repo raw capture every recording was reshaped from — never re-copied into the
// recording files themselves (those stay stripped down to only what the schema needs), so this test
// reaches back to it directly to check the invariants reshaping promised.
const RAW_CAPTURE_PATH = path.join(process.cwd(), "docs", "live-validation", "understand.json");
const FIXTURE_KEY_BY_SAMPLE_ID: Record<string, string> = {
  lease: "leave_and_license",
  offer_letter: "job_offer_letter",
  nda: "nda",
  privacy_policy: "privacy_policy",
  freelance: "freelance_service_agreement",
};

interface RawFinding {
  category: string;
  claimedQuote: string | null;
  claimedQuoteLength: number;
  lensExplanations: { lens: string; explanation: string }[];
}
interface RawFixture {
  fixture: string;
  analysis: { modelUsed: string };
  findings: RawFinding[];
}

function rawFixtureFor(sampleId: string): RawFixture {
  const raw = JSON.parse(readFileSync(RAW_CAPTURE_PATH, "utf8")) as { fixtures: RawFixture[] };
  const key = FIXTURE_KEY_BY_SAMPLE_ID[sampleId];
  const fixture = raw.fixtures.find((f) => f.fixture === key);
  if (!fixture) throw new Error(`no raw capture fixture for sample ${sampleId}`);
  return fixture;
}

// The one invariant reshaping promised for every finding — a real function, not an inlined
// expression, so the red-proof below exercises the exact same check the per-entry test does.
function quoteLengthMatches(quote: string | null, claimedQuoteLength: number): boolean {
  return (quote?.length ?? 0) === claimedQuoteLength;
}

describe("every shipped recording round-trips through the real Understand response schema", () => {
  for (const entry of allSampleEntries()) {
    it(`${entry.sampleId}: parses cleanly through buildUnderstandResponseSchema(${entry.documentType})`, () => {
      const schema = buildUnderstandResponseSchema(entry.documentType);
      const parsed = schema.safeParse(entry.recording);
      expect(parsed.success).toBe(true);
    });

    it(`${entry.sampleId}: every finding's quote, category and lensExplanations match the raw capture`, () => {
      const raw = rawFixtureFor(entry.sampleId);
      expect(entry.recording.findings.length).toBe(raw.findings.length);
      entry.recording.findings.forEach((finding, i) => {
        const rawFinding = raw.findings[i];
        expect(quoteLengthMatches(finding.quote, rawFinding.claimedQuoteLength)).toBe(true);
        expect(finding.quote).toBe(rawFinding.claimedQuote);
        expect(finding.category).toBe(rawFinding.category);
        const expectedLensExplanations = Object.fromEntries(
          rawFinding.lensExplanations.map((lensEntry) => [lensEntry.lens, lensEntry.explanation]),
        );
        expect(finding.lensExplanations).toEqual(expectedLensExplanations);
      });
    });

    it(`${entry.sampleId}: modelUsed matches both the pinned entry and the raw capture`, () => {
      const raw = rawFixtureFor(entry.sampleId);
      expect(entry.recording.modelUsed).toBe(entry.modelUsed);
      expect(entry.recording.modelUsed).toBe(raw.analysis.modelUsed);
    });
  }

  it("red-proof: a finding whose quote was truncated after reshaping fails the real length check", () => {
    const raw = rawFixtureFor("lease");
    const truncated = raw.findings[0].claimedQuote!.slice(0, -1);
    expect(quoteLengthMatches(truncated, raw.findings[0].claimedQuoteLength)).toBe(false);
  });
});

describe("assertSampleIsLive (the pre-replay staleness check)", () => {
  it("every shipped entry is live: recomputing its pins from the bundled bytes matches what's pinned", async () => {
    for (const entry of allSampleEntries()) {
      await expect(assertSampleIsLive(entry)).resolves.toBeUndefined();
      await expect(recomputeSamplePins(entry)).resolves.toEqual(pinsOf(entry));
    }
  });

  it("a copy edited to a wrong canonical-text hash refuses to open", async () => {
    const [entry] = allSampleEntries();
    await expect(assertSampleIsLive({ ...entry, canonicalTextHash: "0".repeat(64) })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("red-proof: a tampered inputFingerprint on a non-lease entry fails the freshness comparison", async () => {
    const real = allSampleEntries().find((entry) => entry.sampleId === "offer_letter");
    if (!real) throw new Error("offer_letter entry missing from the registry");
    const tampered = { ...real, inputFingerprint: "0".repeat(64) };
    await expect(recomputeSamplePins(tampered)).resolves.not.toEqual(pinsOf(tampered));
    await expect(assertSampleIsLive(tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // Every disjunct assertSampleIsLive compares, tampered one at a time — not only
  // canonicalTextHash/inputFingerprint above. Each copy changes exactly one pin, so a passing test
  // here depends on that specific comparison, not on a different one catching the same tamper.
  it("a tampered documentType (claiming a type the bytes don't detect as) refuses to open", async () => {
    const real = allSampleEntries().find((entry) => entry.sampleId === "offer_letter");
    if (!real) throw new Error("offer_letter entry missing from the registry");
    const tampered = { ...real, documentType: "nda" as const };
    await expect(recomputeSamplePins(tampered)).resolves.not.toEqual(pinsOf(tampered));
    await expect(assertSampleIsLive(tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a tampered recordingHash pin (the recording itself untouched) refuses to open", async () => {
    const real = allSampleEntries().find((entry) => entry.sampleId === "offer_letter");
    if (!real) throw new Error("offer_letter entry missing from the registry");
    const tampered = { ...real, recordingHash: "0".repeat(64) };
    await expect(recomputeSamplePins(tampered)).resolves.not.toEqual(pinsOf(tampered));
    await expect(assertSampleIsLive(tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a tampered modelUsed pin (the recording's own modelUsed untouched) refuses to open", async () => {
    const real = allSampleEntries().find((entry) => entry.sampleId === "offer_letter");
    if (!real) throw new Error("offer_letter entry missing from the registry");
    const tampered = { ...real, modelUsed: "not-the-real-model" };
    await expect(recomputeSamplePins(tampered)).resolves.not.toEqual(pinsOf(tampered));
    await expect(assertSampleIsLive(tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a recording that no longer parses through the live response schema refuses to open, even with every other pin self-consistent", async () => {
    const real = allSampleEntries().find((entry) => entry.sampleId === "offer_letter");
    if (!real) throw new Error("offer_letter entry missing from the registry");
    const brokenRecording = {
      ...real.recording,
      findings: [{ category: real.recording.findings[0].category, quote: real.recording.findings[0].quote }],
    } as unknown as RecordedUnderstandOutput; // missing lensExplanations: violates the schema
    // recordingHash re-pinned to match the broken recording's own bytes, so ONLY schemaParses fails —
    // not a recordingHash mismatch masquerading as a schema failure.
    const tampered = { ...real, recording: brokenRecording, recordingHash: hashRecording(brokenRecording) };
    const live = await recomputeSamplePins(tampered);
    expect(live?.schemaParses).toBe(false);
    await expect(assertSampleIsLive(tampered)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("CI prompt-divergence pin", () => {
  it("the registry's pinned PROMPT_VERSION/PROMPT_FINGERPRINT still matches the live prompt", () => {
    // This is the whole point of the gate: if analyze.ts's prompt or schema shape changes without a
    // fresh recording, this equality breaks and the build fails — not production, silently serving
    // a stale recording.
    expect(pinnedPromptSignature()).toEqual({ promptVersion: PROMPT_VERSION, promptFingerprint: PROMPT_FINGERPRINT });
  });
});
