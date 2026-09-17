import { describe, expect, it } from "vitest";
import { MAX_EXTRACTED_CHARS } from "@/server/deterministic/extract/constants";
import { findMissingStandardClauses, STANDARD_CLAUSES_BY_DOCUMENT_TYPE } from "@/server/deterministic/standard-clauses";

// Worst case is every item absent at the largest text extraction accepts: every phrase scans the
// whole text, twice when line-end hyphens add a second view. Measured: ~90 ms CPU per call on one
// view, ~150 ms on two, up to ~220 ms on a loaded machine. Asserted on CPU time, since wall-clock
// inflates on a machine running other test suites.
const PER_CALL_BOUND_MS = 1_000;
const PER_CALL_WALL_GUARD_MS = 5_000;

const TUNED_TYPES = ["leave_and_license", "job_offer_letter", "nda", "privacy_policy", "freelance_service_agreement"] as const;

let seed = 20260923;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
}

function corpus(words: readonly string[], separator: () => string): string {
  let text = "";
  while (text.length < MAX_EXTRACTED_CHARS) text += words[Math.floor(random() * words.length)] + separator();
  return text.slice(0, MAX_EXTRACTED_CHARS);
}

// Words that appear in no presence phrase, so every item stays absent and every phrase is tried.
const NEUTRAL_WORDS = (
  "paper records particulars settled between persons named each person has read every page with care signs " +
  "good faith headings ease reading only words singular plural context allows nothing meant against either copy kept above"
).split(" ");

function timed<T>(run: () => T): { result: T; cpuMs: number; wallMs: number } {
  const cpuBefore = process.cpuUsage();
  const wallBefore = performance.now();
  const result = run();
  const wallMs = performance.now() - wallBefore;
  const cpu = process.cpuUsage(cpuBefore);
  return { result, cpuMs: (cpu.user + cpu.system) / 1_000, wallMs };
}

function expectWithinBound(label: string, cpuMs: number, wallMs: number) {
  console.log(`${label}: cpu ${cpuMs.toFixed(1)} ms, wall ${wallMs.toFixed(1)} ms`);
  expect(cpuMs, `${label}: CPU per call`).toBeLessThan(PER_CALL_BOUND_MS);
  expect(wallMs, `${label}: wall per call (stall guard)`).toBeLessThan(PER_CALL_WALL_GUARD_MS);
}

describe(`findMissingStandardClauses — worst-case timing at ${MAX_EXTRACTED_CHARS} chars (bound: ${PER_CALL_BOUND_MS} ms CPU per call)`, () => {
  const plain = corpus(NEUTRAL_WORDS, () => (random() < 0.1 ? ". " : " "));
  const hyphenated = corpus(NEUTRAL_WORDS, () => (random() < 0.2 ? "-\n" : " "));

  it.each(TUNED_TYPES)("checks every %s item with none present, on one and on two views of the text", (type) => {
    for (const [label, text] of [
      ["plain", plain],
      ["line-end hyphens", hyphenated],
    ] as const) {
      expect(text.length).toBe(MAX_EXTRACTED_CHARS);

      const { result, cpuMs, wallMs } = timed(() => findMissingStandardClauses(type, text));

      expect(result, `${type}/${label}: every item absent`).toHaveLength(STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].length);
      expectWithinBound(`${type}/${label}`, cpuMs, wallMs);
    }
  });

  it.each(TUNED_TYPES)("stays within the bound on text made of %s phrase prefixes", (type) => {
    const prefixWords = STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].flatMap((item) =>
      item.presence.flatMap((phrase) => phrase.split(" ").slice(0, -1)),
    );
    const text = corpus([...new Set(prefixWords)], () => " ");

    const { cpuMs, wallMs } = timed(() => findMissingStandardClauses(type, text));

    expectWithinBound(`${type}/phrase prefixes`, cpuMs, wallMs);
  });

  it("rejects text over the cap before any other work", () => {
    const overCap = `${plain} `;

    const { result, cpuMs, wallMs } = timed(() => findMissingStandardClauses("nda", overCap));

    expect(result).toEqual([]);
    expectWithinBound("over cap", cpuMs, wallMs);
    expect(cpuMs).toBeLessThan(20);
  });
});
