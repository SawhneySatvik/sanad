/**
 * `LlmStreamEvent.token` is raw provider text — for Gemini, a partial JSON document being built up
 * character by character. Forwarding it as-is would leak JSON scaffolding and could surface a
 * hallucinated `"status":"verified"` key before schema validation strips it. This decoder extracts
 * only the plaintext `answer` field (assumed to be the first JSON key), stopping if the buffer
 * diverges from that shape; the schema-validated `done`/`data` result is always the source of
 * truth — this decoder's output is only a live preview.
 */

// Tracking a single position index into this literal, examined once per character across the
// decoder's lifetime, keeps `advancePrefix` below at O(1) amortized rather than re-scanning the
// whole buffer on every push() call.
const PREFIX_LITERAL = '{"answer":"';
// Indices where whitespace may be skipped before matching: before '{' (0), the key's opening
// quote (1), ':' (9), the value's opening quote (10). Not valid inside the `"answer"` key
// literal itself (indices 2-8) — that would not be valid JSON either.
const WS_ALLOWED_BEFORE = new Set([0, 1, 9, 10]);
// A compliant prefix is at most ~20 characters including generous whitespace; 256 is a wide
// margin. Exceeding it without completing the prefix means give up — this bounds the only
// unbounded-looking loop in this class to a small constant, however the input is chunked.
const MAX_PREFIX_SCAN_CHARS = 256;

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Extracts the plaintext `answer` field from a stream of raw provider JSON chunks; see the module doc. */
export class AnswerStreamDecoder {
  private state: "prefix" | "string" | "done" | "abandoned" = "prefix";
  private prefixPos = 0;
  private scannedChars = 0;
  // A held-back partial `\` or `\uXXXX` escape split across a chunk boundary.
  private pendingEscape = "";
  // A decoded high-surrogate code unit (from a `\uXXXX` escape) held until either its low-
  // surrogate pair arrives (emitted together) or something else disqualifies it (dropped —
  // never emit a lone surrogate).
  private pendingHighSurrogate = "";

  // Feeds one more raw chunk of provider text; returns newly-decoded plaintext (possibly "").
  push(chunk: string): string {
    if (this.state === "done" || this.state === "abandoned") return "";
    if (this.state === "prefix") {
      return this.advancePrefix(chunk);
    }
    return this.consumeString(chunk);
  }

  private advancePrefix(chunk: string): string {
    for (let i = 0; i < chunk.length; i++) {
      if (this.scannedChars >= MAX_PREFIX_SCAN_CHARS) {
        this.state = "abandoned";
        return "";
      }
      this.scannedChars++;
      const ch = chunk[i];
      if (WS_ALLOWED_BEFORE.has(this.prefixPos) && /\s/.test(ch)) continue;
      if (ch === PREFIX_LITERAL[this.prefixPos]) {
        this.prefixPos++;
        if (this.prefixPos === PREFIX_LITERAL.length) {
          this.state = "string";
          return this.consumeString(chunk.slice(i + 1));
        }
        continue;
      }
      this.state = "abandoned";
      return "";
    }
    return "";
  }

  // Decodes as much of `this.pendingEscape + chunk` as forms complete, unescaped characters. An
  // incomplete `\` or `\uXXXX` at the end is held back in `this.pendingEscape` for the next
  // push(). Stops at the first unescaped closing quote, in one linear pass.
  private consumeString(chunk: string): string {
    const text = this.pendingEscape + chunk;
    this.pendingEscape = "";
    let out = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        const escapeChar = text[i + 1];
        if (escapeChar === undefined) {
          this.pendingEscape = text.slice(i);
          return out;
        }
        if (escapeChar === "u") {
          if (text.length < i + 6) {
            this.pendingEscape = text.slice(i);
            return out;
          }
          const hex = text.slice(i + 2, i + 6);
          // Requires exactly 4 valid hex digits: a malformed escape could otherwise consume the
          // string's own closing quote as a "hex digit", letting subsequent JSON syntax leak
          // through as if still inside the answer string. Invalid means stop decoding — fail safe.
          if (!HEX4.test(hex)) {
            this.state = "abandoned";
            return out;
          }
          out += this.acceptCodeUnit(parseInt(hex, 16));
          i += 6;
          continue;
        }
        // A non-\u escape resolves/disqualifies any pending high surrogate — drop it rather
        // than ever emit it alone.
        this.pendingHighSurrogate = "";
        out += unescapeSimple(escapeChar);
        i += 2;
        continue;
      }
      if (ch === '"') {
        this.pendingHighSurrogate = "";
        this.state = "done";
        return out;
      }
      this.pendingHighSurrogate = "";
      out += ch;
      i += 1;
    }
    return out;
  }

  // Holds back a decoded `\uXXXX` high surrogate until its low-surrogate pair arrives (emitted
  // together, one valid character), rather than ever emitting a lone/dangling surrogate (U+FFFD).
  private acceptCodeUnit(code: number): string {
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (this.pendingHighSurrogate) {
      const high = this.pendingHighSurrogate;
      this.pendingHighSurrogate = "";
      if (isLowSurrogate) return high + String.fromCharCode(code);
      // The previous high surrogate never got its pair — drop it (never emit alone), then
      // evaluate this code unit fresh (it may itself start a new pending high surrogate).
      if (isHighSurrogate) {
        this.pendingHighSurrogate = String.fromCharCode(code);
        return "";
      }
      return String.fromCharCode(code);
    }
    if (isHighSurrogate) {
      this.pendingHighSurrogate = String.fromCharCode(code);
      return "";
    }
    return String.fromCharCode(code);
  }
}

function unescapeSimple(ch: string): string {
  switch (ch) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    default:
      return ch;
  }
}
