// toVerificationOutput over the real verify() (never mocked): the wire shape per status, spanText
// cut from the canonical text, and the binding check that refuses a result for another quote or
// another document.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractDocument } from "@/server/deterministic/extract";
import { verify, type VerifyResult } from "@/server/deterministic/verify";
import { LEASE } from "@tests/support/services/understand";
import { VerificationOutput } from "@/shared/contracts/common";
import { toVerificationOutput } from "@/server/http/verification";

interface Text {
  canonicalText: string;
  canonicalTextHash: string;
  inputMode: "text";
}

async function canonical(pastedText: string): Promise<Text> {
  const extracted = await extractDocument({ pastedText });
  if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
  return { canonicalText: extracted.canonicalText, canonicalTextHash: extracted.canonicalTextHash, inputMode: "text" };
}

let lease: Text;
let other: Text;
beforeAll(async () => {
  const fixtures = path.join(process.cwd(), "tests", "fixtures", "documents");
  lease = await canonical(await readFile(path.join(fixtures, "leave_and_license.txt"), "utf8"));
  other = await canonical(await readFile(path.join(fixtures, "nda.txt"), "utf8"));
});

function checked(quote: string, text: Text = lease): VerifyResult {
  return verify({ quote, canonicalText: text.canonicalText, inputMode: text.inputMode });
}

describe("toVerificationOutput", () => {
  it("verified: the span and the document's own text at it — no model text", () => {
    const output = toVerificationOutput(checked(LEASE.licenseFee), { quote: LEASE.licenseFee, ...lease });

    expect(output.status).toBe("verified");
    if (output.status !== "verified") return;
    expect(output.spanText).toBe(lease.canonicalText.slice(output.spanStart, output.spanEnd));
    expect(output.spanText).toBe(LEASE.licenseFee);
    expect(Object.keys(output).sort()).toEqual(["spanEnd", "spanStart", "spanText", "status", "verifierVersion"]);
    expect(VerificationOutput.parse(output)).toEqual(output);
  });

  it("approximate: the closest passage as spanText, the model's claim only as claimedQuote", () => {
    const output = toVerificationOutput(checked(LEASE.nearMiss), { quote: LEASE.nearMiss, ...lease });

    expect(output.status).toBe("approximate");
    if (output.status !== "approximate") return;
    expect(output.spanText).toBe(lease.canonicalText.slice(output.spanStart, output.spanEnd));
    expect(output.spanText).not.toBe(LEASE.nearMiss);
    expect(output.claimedQuote).toBe(LEASE.nearMiss);
  });

  it("not_found: no span, no text — only the claim", () => {
    const output = toVerificationOutput(checked(LEASE.fabricated), { quote: LEASE.fabricated, ...lease });

    expect(output).toEqual({
      status: "not_found",
      spanStart: null,
      spanEnd: null,
      spanText: null,
      claimedQuote: LEASE.fabricated,
      verifierVersion: expect.any(String),
    });
  });

  it("refuses a result computed against another document (a comparison A/B swap)", () => {
    expect(() => toVerificationOutput(checked(LEASE.licenseFee), { quote: LEASE.licenseFee, ...other })).toThrow(
      /different quote or document/,
    );
  });

  it("refuses a result attached to another quote (index drift)", () => {
    expect(() => toVerificationOutput(checked(LEASE.licenseFee), { quote: LEASE.lockIn, ...lease })).toThrow(
      /different quote or document/,
    );
  });

  it("refuses anything verify() did not issue", () => {
    const forged = { ...checked(LEASE.licenseFee) } as VerifyResult;
    expect(() => toVerificationOutput(forged, { quote: LEASE.licenseFee, ...lease })).toThrow(/Not a VerifyResult/);
  });
});
