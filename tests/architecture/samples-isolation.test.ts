// RecordedLlmClient is reachable only from src/server/samples/** — never providers.ts, the
// container, the fallback chain, or any other production module, so a replay client can never be
// wired into a real analysis path by accident. A static import scan over the real tree, proven
// against a known importer with the exclusion lifted.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findFiles, isSourceFile, repoRelative } from "./route-conventions";

const SRC_ROOT = path.join(process.cwd(), "src");
const SAMPLES_ROOT = path.join(SRC_ROOT, "server", "samples");

// Matches any import/export specifier naming the module, by relative or aliased path — not just
// the exact "@/server/samples/recorded-llm-client" spelling this repo happens to use today.
const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function importsRecordedLlmClient(source: string): boolean {
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    if (/(^|\/)recorded-llm-client$/.test(match[1])) return true;
  }
  return false;
}

describe("RecordedLlmClient's single importer", () => {
  it("no production file outside src/server/samples/** imports it", () => {
    const files = findFiles(SRC_ROOT, isSourceFile).filter((file) => !file.startsWith(SAMPLES_ROOT + path.sep));
    const offenders = files.filter((file) => importsRecordedLlmClient(readFileSync(file, "utf8"))).map(repoRelative);
    expect(offenders).toEqual([]);
  });

  it("red-proof: the scan catches src/server/samples/open.ts's own (allowed) import when the exclusion is lifted", () => {
    const openTs = path.join(SAMPLES_ROOT, "open.ts");
    expect(importsRecordedLlmClient(readFileSync(openTs, "utf8"))).toBe(true);
  });
});

// A plain name-mention scan over an explicit allowed-file set — the same shape
// storage-cleanup-logging.test.ts already uses for a comparable single-caller restriction.
function findMentionsOutsideAllowlist(name: string, allowed: ReadonlySet<string>): string[] {
  return findFiles(SRC_ROOT, isSourceFile)
    .map(repoRelative)
    .filter((file) => !allowed.has(file) && readFileSync(file, "utf8").includes(name));
}

describe("replayRecordedAnalysis is reachable only from its definition and the samples-open flow", () => {
  const allowed = new Set(["src/server/services/understand.ts", "src/server/samples/open.ts"]);

  it("no other production file names it", () => {
    expect(findMentionsOutsideAllowlist("replayRecordedAnalysis", allowed)).toEqual([]);
  });
});

describe("openSampleEntry is reachable only from within src/server/samples/open.ts", () => {
  const allowed = new Set(["src/server/samples/open.ts"]);

  it("no other production file names it", () => {
    expect(findMentionsOutsideAllowlist("openSampleEntry", allowed)).toEqual([]);
  });
});
