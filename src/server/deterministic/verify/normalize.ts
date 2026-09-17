/**
 * verify()'s matching normalization, applied to both the quote and canonical text so it's correct
 * whether either side was already normalized. Tolerates only: Unicode NFC; any whitespace/line-break
 * run folded to one space (not U+FEFF, which renders as nothing, so folding it would let "a b"
 * verify against text shown as "ab"); smart quotes/dashes folded to ' " -; and leading/trailing
 * whitespace of the quote. Case, added/dropped punctuation, invisible characters, ligatures and
 * wording are not tolerated — those reach only `approximate`, never `verified`.
 */

const MAX_CHUNK_CODE_POINTS = 32;

const COMBINING_MARK_AT = /\p{M}/uy;

function attachesToPrevious(text: string, index: number, cp: number): boolean {
  if (cp < 0x300) return false; // nothing below U+0300 combines backwards
  if (cp === 0x200c || cp === 0x200d) return true; // ZWNJ/ZWJ bind to what precedes them
  if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return true; // Hangul vowel/final jamo
  if (cp === 0x16d67) return true; // Kirat Rai vowel sign E: the one non-mark composition second (Unicode 16)
  COMBINING_MARK_AT.lastIndex = index;
  return COMBINING_MARK_AT.test(text);
}

function isWhitespace(cp: number): boolean {
  return (
    cp === 0x20 ||
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

// Most non-ASCII chunks are a single code point; their NFC form is memoized (bounded, transparent)
// so a long Devanagari or emoji document doesn't pay a slice + normalize call per character.
const singleCodePointNfc = new Map<number, string>();
function nfcOfCodePoint(cp: number): string {
  let nfc = singleCodePointNfc.get(cp);
  if (nfc === undefined) {
    if (singleCodePointNfc.size >= 65_536) singleCodePointNfc.clear();
    nfc = String.fromCodePoint(cp).normalize("NFC");
    singleCodePointNfc.set(cp, nfc);
  }
  return nfc;
}

function mapCodeUnit(cu: number): number {
  if (cu >= 0x2018 && cu <= 0x201b) return 0x27;
  if (cu >= 0x201c && cu <= 0x201f) return 0x22;
  if ((cu >= 0x2010 && cu <= 0x2015) || cu === 0x2212 || cu === 0xfe58 || cu === 0xfe63 || cu === 0xff0d) {
    return 0x2d;
  }
  return cu;
}

/**
 * The normalized text plus a map back to the original string. A "unit" is one chunk's normalized
 * output, or the single space a whitespace run becomes. Units tile the original string: unit u
 * covers [unitBoundary[u], unitBoundary[u + 1]).
 */
export type MatchText = {
  readonly text: string;
  // For each code unit of `text`, the unit that produced it.
  readonly unitOf: Int32Array;
  readonly unitBoundary: Int32Array;
  readonly startsWithSpace: boolean;
  readonly endsWithSpace: boolean;
};

/**
 * Builds a normalized view of `input` for exact matching, plus a map back to original offsets. Text
 * is processed in chunks — one code point plus its trailing combining marks, capped at
 * MAX_CHUNK_CODE_POINTS — each normalized independently, since whole-string NFC is quadratic on a
 * long combining-mark run (see extract/normalize.ts's own guard).
 * Up to 31 attached code points (checked exhaustively against Node 22's ICU / Unicode 17), every
 * canonical Unicode composition/reordering happens inside one chunk, so the result equals
 * whole-string NFC, and a match — which may only start or end on a chunk boundary — never splits a
 * base letter from its accents. A longer run is cut into several chunks, where both guarantees
 * stop holding: NFC can differ from whole-string NFC across the cut, and a match can start or end
 * inside the run. Real text stays well under that bound, and boundary.ts's token-boundary rule
 * still rejects a `verified` edge with a combining mark on both sides regardless.
 */
export function buildMatchText(input: string): MatchText {
  const n = input.length;
  // Units never outnumber input code units; the output can (NFC expands a few chars up to 3x),
  // hence the growable buffers.
  const unitBoundary = new Int32Array(n + 1);
  let codeUnits = new Uint16Array(n + 16);
  let unitOf = new Int32Array(n + 16);
  let length = 0;
  let units = 0;
  let inWhitespaceRun = false;
  let startsWithSpace = false;

  const emit = (cu: number) => {
    if (length === codeUnits.length) {
      const grownCodeUnits = new Uint16Array(length * 2);
      grownCodeUnits.set(codeUnits);
      codeUnits = grownCodeUnits;
      const grownUnitOf = new Int32Array(length * 2);
      grownUnitOf.set(unitOf);
      unitOf = grownUnitOf;
    }
    codeUnits[length] = cu;
    unitOf[length] = units - 1;
    length++;
  };

  let i = 0;
  while (i < n) {
    const chunkStart = i;
    const first = input.codePointAt(i)!;
    i += first > 0xffff ? 2 : 1;
    let codePoints = 1;
    while (i < n && codePoints < MAX_CHUNK_CODE_POINTS) {
      const next = input.codePointAt(i)!;
      if (!attachesToPrevious(input, i, next)) break;
      i += next > 0xffff ? 2 : 1;
      codePoints++;
    }

    if (codePoints === 1 && isWhitespace(first)) {
      if (!inWhitespaceRun) {
        if (units === 0) startsWithSpace = true;
        unitBoundary[units++] = chunkStart;
        emit(0x20);
        inWhitespaceRun = true;
      }
      continue;
    }

    inWhitespaceRun = false;
    unitBoundary[units++] = chunkStart;
    if (codePoints === 1 && first < 0x300) {
      emit(first); // NFC-stable, and no mapped character lives below U+0300
    } else {
      const nfc = codePoints === 1 ? nfcOfCodePoint(first) : input.slice(chunkStart, i).normalize("NFC");
      for (let k = 0; k < nfc.length; k++) emit(mapCodeUnit(nfc.charCodeAt(k)));
    }
  }
  unitBoundary[units] = n;

  let text = "";
  for (let k = 0; k < length; k += 8192) {
    text += String.fromCharCode(...codeUnits.subarray(k, Math.min(k + 8192, length)));
  }
  return {
    text,
    unitOf: unitOf.subarray(0, length),
    unitBoundary: unitBoundary.subarray(0, units + 1),
    startsWithSpace,
    endsWithSpace: inWhitespaceRun,
  };
}

/**
 * The comparison key: a quote verifies iff this equals the same function of
 * canonicalText.slice(spanStart, spanEnd). Trims only a whole collapsed-whitespace unit —
 * String.prototype.trim() could eat the space of a " " + combining-mark chunk and desynchronise the
 * two sides.
 */
export function normalizeForMatch(input: string): string {
  const mt = buildMatchText(input);
  const start = mt.startsWithSpace ? 1 : 0;
  const end = mt.endsWithSpace ? mt.text.length - 1 : mt.text.length;
  return start >= end ? "" : mt.text.slice(start, end);
}
