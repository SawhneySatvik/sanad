import { describe, expect, it } from "vitest";
import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";

describe("sanitizeModelText", () => {
  it("removes every badge glyph and bidi control from model text", () => {
    const glyphs = String.fromCodePoint(0x2705, 0x2713, 0x2714, 0x2611, 0x1f5f8, 0x1f5f9, 0x221a, 0x1f197, 0x10102, 0xfe0f);
    const bidi = String.fromCodePoint(0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069);
    expect(sanitizeModelText(`A${glyphs}${bidi}B`)).toBe("AB");
  });
});
