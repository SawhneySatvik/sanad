import { describe, expect, it } from "vitest";
import { findApproximate, indexTokens, quoteTokenIds } from "@/server/deterministic/verify/approximate";
import { buildMatchText, normalizeForMatch } from "@/server/deterministic/verify/normalize";
import { MAX_QUOTES_PER_CALL, verify, verifyMany } from "@/server/deterministic/verify/verify";

// Worst-case timing at the largest document extraction accepts (500,000 chars). Asserted on CPU
// time, because wall-clock under concurrent load measured 3-5x the idle figure (idle: <= ~100 ms
// worst case; 378 ms wall at load average 29 on 8 cores). Wall-clock keeps a looser guard.
const DOC_CHARS = 500_000;
const PER_CALL_BOUND_MS = 250;
const PER_CALL_WALL_GUARD_MS = 2_000;

// The deterministic half of the gate — wall-clock can flake on a loaded
// machine, work counts cannot. Literals on purpose: asserting against the
// imported cap would let raising or removing the cap pass its own test.
const CANDIDATE_CAP = 8;
const maxAlignmentCells = (k: number) => CANDIDATE_CAP * k * (3 * k + 3);

let seed = 20260923;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
}

const WORDS = (
  "the tenant landlord licensee licensor shall pay rent deposit month notice terminate agreement premises " +
  "clause lease period days written consent sublet maintenance repairs electricity charges penalty interest " +
  "default breach party parties hereto whereas refundable deduction damages arbitration jurisdiction mumbai " +
  "rupees indemnify covenant schedule annexure"
).split(" ");

function legalProse(chars: number): string {
  let out = "";
  for (let clause = 1; out.length < chars; clause++) {
    const words: string[] = [];
    const count = 8 + Math.floor(random() * 25);
    for (let i = 0; i < count; i++) words.push(WORDS[Math.floor(random() * WORDS.length)] + (random() < 0.1 ? "," : ""));
    out += `${clause}. ${words.join(" ")}.${random() < 0.2 ? "\r\n\r\n" : " "}`;
  }
  return out.slice(0, chars);
}

// `tokens` consecutive words from the document with every 6th replaced:
// forces the full approximate path (exact miss, prefilter pass, alignment).
function nearMiss(doc: string, tokens: number): string {
  const start = Math.floor(random() * (doc.length - 40_000));
  const words = doc.slice(start, start + 40_000).split(/\s+/).slice(1, tokens + 1);
  for (let i = 3; i < words.length; i += 6) words[i] = `zzz${i}`;
  return words.join(" ");
}

type Timing = { maxCpuMs: number; maxWallMs: number; statuses: Record<string, number> };

function timed<T>(run: () => T): { result: T; cpuMs: number; wallMs: number } {
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  const result = run();
  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  return { result, cpuMs: (cpu.user + cpu.system) / 1_000, wallMs };
}

function measure(canonicalText: string, quotes: string[]): Timing {
  const timing: Timing = { maxCpuMs: 0, maxWallMs: 0, statuses: {} };
  for (const quote of quotes) {
    const { result, cpuMs, wallMs } = timed(() => verify({ quote, canonicalText, inputMode: "text" }));
    timing.maxCpuMs = Math.max(timing.maxCpuMs, cpuMs);
    timing.maxWallMs = Math.max(timing.maxWallMs, wallMs);
    timing.statuses[result.status] = (timing.statuses[result.status] ?? 0) + 1;
  }
  return timing;
}

function expectWithinBound(label: string, { maxCpuMs, maxWallMs, statuses }: Timing) {
  console.log(`${label}: max cpu ${maxCpuMs.toFixed(1)} ms, max wall ${maxWallMs.toFixed(1)} ms`, statuses);
  expect(maxCpuMs, `${label}: CPU per call (the stated bound)`).toBeLessThan(PER_CALL_BOUND_MS);
  expect(maxWallMs, `${label}: wall per call (stall guard)`).toBeLessThan(PER_CALL_WALL_GUARD_MS);
}

// Work the approximate matcher really did for each quote — the same function
// verify() calls, on the same normalized text and token index.
function approximateWork(canonicalText: string, quotes: string[]) {
  const doc = indexTokens(buildMatchText(canonicalText).text);
  return quotes.map((quote) => {
    const ids = quoteTokenIds(normalizeForMatch(quote), doc.vocab);
    return { k: ids.length, ...findApproximate(ids, doc) };
  });
}

function repeatTo(unit: string, chars: number): string {
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

const legal = legalProse(DOC_CHARS);

describe(`verify — worst-case timing at ${DOC_CHARS} chars (bound: ${PER_CALL_BOUND_MS} ms CPU per call)`, () => {
  it("legal prose × 200-token near-miss quotes (full approximate path), and a full verifyMany batch of them", () => {
    const quotes = Array.from({ length: MAX_QUOTES_PER_CALL }, () => nearMiss(legal, 200));
    const timing = measure(legal, quotes.slice(0, 20));
    expect(timing.statuses).toEqual({ approximate: 20 });
    expectWithinBound("prose/200-token near-miss", timing);

    // The largest batch verifyMany accepts, every quote on its slowest path.
    const batch = timed(() => verifyMany(quotes, legal, "text"));
    console.log(
      `prose/200-token near-miss: verifyMany(${quotes.length}) cpu ${batch.cpuMs.toFixed(1)} ms, wall ${batch.wallMs.toFixed(1)} ms`,
    );
    expect(batch.result.every((r) => r.status === "approximate")).toBe(true);
    expect(batch.cpuMs, "verifyMany full batch: CPU").toBeLessThan(PER_CALL_BOUND_MS * 4);
    expect(batch.wallMs, "verifyMany full batch: wall").toBeLessThan(PER_CALL_WALL_GUARD_MS * 4);
  });

  it("legal prose × max-length (4000-char) quotes that miss", () => {
    const quotes = Array.from({ length: 5 }, () => nearMiss(legal, 1_000).slice(0, 4_000));
    const timing = measure(legal, quotes);
    expect(timing.statuses).toEqual({ not_found: 5 });
    expectWithinBound("prose/4000-char miss", timing);
  });

  it("highly repetitive text — every window passes the prefilter, the candidate cap is what bounds the work", () => {
    const sentence = "The Tenant shall pay the monthly rent of Rs 25000 on or before the 5th day of each month without demand. ";
    const doc = repeatTo(sentence, DOC_CHARS);
    const oneWord = repeatTo("the ", DOC_CHARS);
    const cases: Array<[string, string[]]> = [
      [doc, Array.from({ length: 5 }, () => nearMiss(doc, 160))],
      [oneWord, Array.from({ length: 5 }, (_, i) => `${"the ".repeat(199)}zzz${i}`)],
    ];
    for (const [text, quotes] of cases) {
      // Work first: this is the assertion that cannot flake.
      for (const work of approximateWork(text, quotes)) {
        // The cap is reached (so this test exercises it) and never exceeded.
        expect(work.candidatesAligned).toBe(CANDIDATE_CAP);
        expect(work.alignmentCells).toBeLessThanOrEqual(maxAlignmentCells(work.k));
      }

      const timing = measure(text, quotes);
      expect(timing.statuses).toEqual({ approximate: 5 });
      expectWithinBound("repetitive", timing);
    }
  });

  it("alignment work stays under the documented per-quote bound on ordinary near-misses", () => {
    const quotes = Array.from({ length: 10 }, () => nearMiss(legal, 200));
    const work = approximateWork(legal, quotes);
    for (const w of work) {
      expect(w.match).not.toBeNull();
      expect(w.candidatesAligned).toBeLessThanOrEqual(CANDIDATE_CAP);
      expect(w.alignmentCells).toBeLessThanOrEqual(maxAlignmentCells(w.k));
    }
    expect(maxAlignmentCells(200)).toBe(964_800);
    console.log(`prose alignment cells per quote: max ${Math.max(...work.map((w) => w.alignmentCells))}`);
  });

  it("token-boundary checks stay bounded when every occurrence of the quote is mid-token", () => {
    const cp = (...points: number[]) => String.fromCodePoint(...points);
    const zwsp32 = cp(0x200b).repeat(32);
    const cases: Array<[string, string, string]> = [
      ["ascii letters", repeatTo("a", DOC_CHARS), "a"],
      ["devanagari letters", repeatTo(cp(0x915), DOC_CHARS), cp(0x915)],
      ["32 invisible chars between letters", repeatTo(`a${zwsp32}a`, DOC_CHARS), "a"],
      ["emoji + skin tone (grapheme checks, capped)", repeatTo(cp(0x1f44d, 0x1f3fd), DOC_CHARS), cp(0x1f44d)],
      ["emoji ZWJ pairs (grapheme checks, capped)", repeatTo(cp(0x1f468, 0x200d, 0x1f469), DOC_CHARS), cp(0x1f469)],
      ["flag run (regional-indicator parity, capped)", repeatTo(cp(0x1f1fa, 0x1f1f8), DOC_CHARS), cp(0x1f1f8, 0x1f1fa)],
    ];
    for (const [label, text, quote] of cases) {
      const timing = measure(text, [quote]);
      expect(timing.statuses).toEqual({ not_found: 1 });
      expectWithinBound(`mid-token: ${label}`, timing);
    }
  });

  it("adversarial Unicode: a 500k combining-mark run, Devanagari-heavy text, boundary-failing multi-unit chunks", () => {
    const marks = ["\u0301", "\u0316", "\u0334"];
    let markRun = "a";
    for (let i = 1; i < DOC_CHARS; i++) markRun += marks[i % 3];
    const devanagari = repeatTo("किरायेदार प्रत्येक माह की पांच तारीख को मासिक किराया अदा करेगा। ", DOC_CHARS);
    // "x" + U+0301 has no precomposed form: the quote's text occurs at every
    // chunk, but always misaligned with chunk boundaries.
    const chunks = repeatTo("x\u0301 ", DOC_CHARS);
    const cases: Array<[string, string[], string]> = [
      [markRun, ["a\u0301\u0316", `a${"\u0334\u0316\u0301".repeat(500)}`], "not_found"],
      [devanagari, ["किरायेदार प्रत्येक माह की पांच तारीख को मासिक किराया अदा करेगा"], "verified"],
      [chunks, ["\u0301 x", "\u0301 x".repeat(1_300)], "not_found"],
    ];
    for (const [text, quotes, expected] of cases) {
      const timing = measure(text, quotes);
      expect(timing.statuses).toEqual({ [expected]: quotes.length });
      expectWithinBound("unicode", timing);
    }
  });
});
