import { describe, expect, it } from "vitest";
import { SignInInput, SignUpInput } from "@/shared/contracts/auth";

// A 73rd byte over the 72-byte bcrypt limit, spent entirely on multi-byte characters so the
// character count alone stays well under any character-based bound — only a byte-length check
// catches this.
const SIX_ASCII = "abcdef";
const EIGHT_ASCII = "abcdefgh";
function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe("SignInInput", () => {
  it("accepts a 6-character password — Supabase's own minimum, so a pre-existing account can still sign in", () => {
    expect(SignInInput.safeParse({ email: "a@example.com", password: SIX_ASCII }).success).toBe(true);
  });

  it("rejects a 5-character password", () => {
    expect(SignInInput.safeParse({ email: "a@example.com", password: "abcde" }).success).toBe(false);
  });

  it("accepts a password at exactly 72 bytes and rejects one over it", () => {
    const exactly72 = "a".repeat(72);
    expect(bytesOf(exactly72)).toBe(72);
    expect(SignInInput.safeParse({ email: "a@example.com", password: exactly72 }).success).toBe(true);

    const over72 = "a".repeat(73);
    expect(SignInInput.safeParse({ email: "a@example.com", password: over72 }).success).toBe(false);
  });

  it("rejects a password over 72 UTF-8 bytes even when its character count is well under 72 — multi-byte characters count by byte, not by character", () => {
    // 24 "😀" (4 UTF-8 bytes, 2 UTF-16 code units each) = 24 characters' worth of code units but 96 bytes.
    const emoji24 = "😀".repeat(24);
    expect(emoji24.length).toBeLessThan(72); // character/code-unit count alone would pass a naive check
    expect(bytesOf(emoji24)).toBeGreaterThan(72);
    expect(SignInInput.safeParse({ email: "a@example.com", password: emoji24 }).success).toBe(false);
  });
});

describe("SignUpInput", () => {
  it("keeps its own 8-character minimum — a 6-character password valid for sign-in is rejected here", () => {
    expect(SignUpInput.safeParse({ email: "a@example.com", password: SIX_ASCII }).success).toBe(false);
    expect(SignUpInput.safeParse({ email: "a@example.com", password: EIGHT_ASCII }).success).toBe(true);
  });

  it("shares SignInInput's own 72-byte ceiling", () => {
    const over72 = "a".repeat(73);
    expect(SignUpInput.safeParse({ email: "a@example.com", password: over72 }).success).toBe(false);
  });
});
