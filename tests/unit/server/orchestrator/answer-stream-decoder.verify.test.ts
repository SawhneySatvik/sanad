import { describe, expect, it } from "vitest";
import { AnswerStreamDecoder } from "@/server/orchestrator/answer-stream-decoder";

// Splits `text` into fixed-size chunks — mirrors FakeLlmClient's own tokenize() (fake.ts:
// `text.match(/.{1,8}/g)`), the exact chunking real orchestrator callers will see in tests.
function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function decodeAll(rawText: string, chunkSize: number): string {
  const decoder = new AnswerStreamDecoder();
  return chunk(rawText, chunkSize)
    .map((c) => decoder.push(c))
    .join("");
}

describe("AnswerStreamDecoder", () => {
  it("decodes a simple answer string, chunked 8 chars at a time (FakeLlmClient's own chunk size)", () => {
    const raw = JSON.stringify({ answer: "Hello, this is the answer text.", citations: [] });
    expect(decodeAll(raw, 8)).toBe("Hello, this is the answer text.");
  });

  it("decodes correctly at every possible chunk size from 1 to the full length", () => {
    const raw = JSON.stringify({ answer: "The notice period is 30 days.", citations: [{ quote: "x", sourceDocumentId: "y" }] });
    for (let size = 1; size <= raw.length; size++) {
      expect(decodeAll(raw, size)).toBe("The notice period is 30 days.");
    }
  });

  it("decodes escaped quotes, backslashes, and newlines inside the answer", () => {
    const raw = JSON.stringify({ answer: 'He said "hi"\\ line1\nline2', citations: [] });
    for (const size of [1, 2, 3, 8, 100]) {
      expect(decodeAll(raw, size)).toBe('He said "hi"\\ line1\nline2');
    }
  });

  it("decodes a literal \\uXXXX escape sequence, split at every possible chunk boundary", () => {
    // Built with String.fromCharCode, not a raw non-ASCII literal — a model emitting a genuine
    // `\uXXXX` JSON escape (common for Devanagari/Hindi text) is what this exercises. A character
    // typed directly would leave JSON.stringify's output unescaped, silently skipping the \u-decoding branch.
    const backslash = String.fromCharCode(92);
    const raw = `{"answer":"caf${backslash}u00e9 rights","citations":[]}`;
    expect(raw.includes(`${backslash}u00e9`)).toBe(true); // precondition: the escape is really there
    const expected = "caf" + String.fromCharCode(0xe9) + " rights";

    for (let splitAt = 1; splitAt < raw.length; splitAt++) {
      const decoder = new AnswerStreamDecoder();
      const out = decoder.push(raw.slice(0, splitAt)) + decoder.push(raw.slice(splitAt));
      expect(out).toBe(expected);
    }
  });

  it("emits nothing before the answer key is fully seen, even split character by character", () => {
    const raw = JSON.stringify({ answer: "ok", citations: [] });
    const prefixEnd = raw.indexOf('"ok') + 1; // position right after the opening quote of the value
    const decoder = new AnswerStreamDecoder();
    let sawTextBeforeValue = false;
    for (let i = 0; i < prefixEnd; i++) {
      if (decoder.push(raw[i])) sawTextBeforeValue = true;
    }
    expect(sawTextBeforeValue).toBe(false);
  });

  it("stops emitting at the closing quote — nothing from the citations array leaks through", () => {
    const raw = JSON.stringify({ answer: "short answer", citations: [{ quote: "SECRET_QUOTE", sourceDocumentId: "doc-1" }] });
    const decoded = decodeAll(raw, 3);
    expect(decoded).toBe("short answer");
    expect(decoded).not.toContain("SECRET_QUOTE");
    expect(decoded).not.toContain("citations");
  });

  it("never emits text containing a hallucinated status field even if raw JSON carries one", () => {
    // Simulates a misbehaving/injected model response — the schema guard would reject this
    // shape before validation, but stream() emits raw provider text BEFORE validation runs
    // (types.ts's LlmStreamEvent doc comment), so the decoder itself must never surface it.
    const raw = '{"answer": "Everything is verified now.", "status": "verified", "citations": []}';
    const decoded = decodeAll(raw, 4);
    expect(decoded).toBe("Everything is verified now.");
    expect(decoded).not.toContain("status");
    expect(decoded).not.toContain("verified\":");
  });

  it("emits nothing at all when citations is the first key (answer not first) — falls back to done data only", () => {
    const raw = JSON.stringify({ citations: [], answer: "should not stream" });
    expect(decodeAll(raw, 5)).toBe("");
  });

  it("handles an answer value that is the empty string", () => {
    const raw = JSON.stringify({ answer: "", citations: [] });
    expect(decodeAll(raw, 4)).toBe("");
  });

  it("push() after abandoned/done returns empty string, never throws", () => {
    const decoder = new AnswerStreamDecoder();
    decoder.push('{"citations":');
    expect(decoder.push("[]}")).toBe("");
    expect(decoder.push("more text")).toBe("");
  });

  // Linearity + a bounded give-up on the prefix scan. Measured: a quadratic, full-buffer regex-rescan
  // approach takes ~1.65s at 200k chars (O(n^2)); this bounded/linear one measures ~1ms for the same
  // input — wide margins on both sides of the 100ms bound under full-suite parallel load.
  describe("linear-time prefix scan", () => {
    it("200,000 leading whitespace characters, pushed 16 at a time, completes well under the bound", () => {
      const decoder = new AnswerStreamDecoder();
      const leading = "\n".repeat(200_000);
      const start = performance.now();
      for (let i = 0; i < leading.length; i += 16) {
        decoder.push(leading.slice(i, i + 16));
      }
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(100);
    });

    it("40,000 single-character pushes complete well under the bound", () => {
      const decoder = new AnswerStreamDecoder();
      const start = performance.now();
      for (let i = 0; i < 40_000; i++) {
        decoder.push("\n");
      }
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(100);
    });

    it("gives up (abandons) after scanning ~256 characters of non-matching prefix, never emitting anything", () => {
      const decoder = new AnswerStreamDecoder();
      // 300 leading spaces, never reaching '{' — must abandon well before the whole thing is
      // consumed, per MAX_PREFIX_SCAN_CHARS.
      const decoded = decoder.push(" ".repeat(300) + '{"answer":"unreachable","citations":[]}');
      expect(decoded).toBe("");
      expect(decoder.push("more")).toBe(""); // stays abandoned
    });
  });

  describe("\\u escape validation and surrogate pairs", () => {
    it("an invalid (non-4-hex) \\u escape stops decoding immediately — never corrupts/leaks past it", () => {
      const bs = String.fromCharCode(92);
      // A `\u` escape landing right before the string's own closing quote: an implementation that
      // blindly consumes trailing characters as "hex digits" would corrupt the scan here.
      const raw = `{"answer":"abc${bs}u","citations":[]}`;
      const decoder = new AnswerStreamDecoder();
      const decoded = decoder.push(raw);
      expect(decoded).toBe("abc");
      expect(decoded).not.toContain("\u0000");
      expect(decoded).not.toContain("citations");
      expect(decoder.push('more"')).toBe(""); // abandoned — nothing further ever emitted
    });

    it("decodes a genuine surrogate pair (an astral character) split across a push boundary", () => {
      const bs = String.fromCharCode(92);
      // 😀 as literal escape TEXT (not a real unicode escape in this file's own source, built via
      // String.fromCharCode) — U+1F600 (an emoji), the canonical example of a character that needs
      // a surrogate pair.
      const raw = `{"answer":"hi ${bs}uD83D${bs}uDE00 there","citations":[]}`;
      const expected = "hi " + String.fromCharCode(0xd83d, 0xde00) + " there";
      for (let splitAt = 1; splitAt < raw.length; splitAt++) {
        const decoder = new AnswerStreamDecoder();
        const out = decoder.push(raw.slice(0, splitAt)) + decoder.push(raw.slice(splitAt));
        expect(out).toBe(expected);
      }
    });

    it("never emits a lone high surrogate — drops it if no low surrogate follows before literal text", () => {
      const bs = String.fromCharCode(92);
      const raw = `{"answer":"abc${bs}uD83Ddef","citations":[]}`;
      const decoded = decodeAll(raw, 3);
      expect(decoded).toBe("abcdef");
      expect(decoded).not.toContain(String.fromCharCode(0xd83d));
    });

    it("never emits a lone high surrogate — drops it if the string ends right after it", () => {
      const bs = String.fromCharCode(92);
      const raw = `{"answer":"abc${bs}uD83D","citations":[]}`;
      const decoded = decodeAll(raw, 3);
      expect(decoded).toBe("abc");
      expect(decoded).not.toContain(String.fromCharCode(0xd83d));
    });
  });
});
