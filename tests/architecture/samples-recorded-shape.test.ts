// Every reshaped recording under src/server/samples/recorded/** carries no status/verified/span/id
// key — a recording is real model output, reshaped, never copied whole.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RECORDED_DIR = path.join(process.cwd(), "src", "server", "samples", "recorded");

// Canonicalized (lowercased, underscores stripped), matching llm/schema-guard.ts's own approach —
// catches "spanStart", "span_start" and "SPANSTART" alike.
const FORBIDDEN_KEYS = new Set(["status", "verified", "verificationstatus", "id", "span", "spans", "spanstart", "spanend", "spantext"]);

function canonicalize(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

function forbiddenKeysIn(value: unknown, at: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => forbiddenKeysIn(item, `${at}[${i}]`, found));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(canonicalize(key))) found.push(`${at}.${key}`);
      forbiddenKeysIn(child, `${at}.${key}`, found);
    }
  }
}

describe("recorded/**'s reshaped output carries no persisted/verified field", () => {
  const files = readdirSync(RECORDED_DIR).filter((f) => f.endsWith(".json"));

  it("finds at least the five shipped Understand samples", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s has no status/verified/span/id key anywhere", (file) => {
    const parsed: unknown = JSON.parse(readFileSync(path.join(RECORDED_DIR, file), "utf8"));
    const found: string[] = [];
    forbiddenKeysIn(parsed, file, found);
    expect(found).toEqual([]);
  });

  it("red-proof: the scanner catches an injected status key nested inside a finding", () => {
    const found: string[] = [];
    forbiddenKeysIn({ findings: [{ category: "obligation", status: "verified" }] }, "fixture", found);
    expect(found).toEqual(["fixture.findings[0].status"]);
  });

  it("red-proof: the scanner catches a bare 'span' or 'spans' key too, not only spanStart/spanEnd/spanText", () => {
    const found: string[] = [];
    forbiddenKeysIn({ findings: [{ category: "obligation", span: { start: 0, end: 1 } }, { category: "penalty", spans: [] }] }, "fixture", found);
    expect(found).toEqual(["fixture.findings[0].span", "fixture.findings[1].spans"]);
  });
});
