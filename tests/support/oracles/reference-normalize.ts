// TEST ORACLE ONLY — never import from production code. A deliberately naive, independent
// restatement of the normalization documented in normalize.ts: whole-string NFC, then regex
// mapping, whitespace collapse and trim.

const cp = (...points: number[]) => String.fromCodePoint(...points);

const WHITESPACE =
  `[${cp(0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680)}` +
  `${cp(0x2000)}-${cp(0x200a)}${cp(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)}]`;

const SINGLE_QUOTES = new RegExp(`[${cp(0x2018)}-${cp(0x201b)}]`, "g");
const DOUBLE_QUOTES = new RegExp(`[${cp(0x201c)}-${cp(0x201f)}]`, "g");
const DASHES = new RegExp(`[${cp(0x2010)}-${cp(0x2015)}${cp(0x2212, 0xfe58, 0xfe63, 0xff0d)}]`, "g");
const WHITESPACE_RUN = new RegExp(`${WHITESPACE}+`, "g");
const EDGE_WHITESPACE = new RegExp(`^${WHITESPACE}|${WHITESPACE}$`, "g");

/** Independent oracle property tests judge verify() against instead of normalizeForMatch, so a bug in the shared normalizer can't hide behind its own runtime self-check; agrees with normalizeForMatch when combining-mark runs stay under 32 code points and no mark follows whitespace. */
export function referenceNormalize(input: string): string {
  return input
    .normalize("NFC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(WHITESPACE_RUN, " ")
    .replace(EDGE_WHITESPACE, "");
}
