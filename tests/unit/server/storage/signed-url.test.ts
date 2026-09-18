import { describe, expect, it } from "vitest";
import { signLocalUrl, verifyLocalUrl } from "@/server/storage/signed-url";

const SECRET = "test-signing-secret";
const REF = "user:abc/11111111-1111-1111-1111-111111111111/lease.pdf";

describe("signLocalUrl / verifyLocalUrl", () => {
  it("verifies a freshly-signed URL before expiry", () => {
    const now = 1_000_000;
    const url = signLocalUrl(SECRET, REF, now + 60_000);
    const result = verifyLocalUrl(SECRET, url, now);
    expect(result).toEqual({ ref: REF, expiresAtMs: now + 60_000 });
  });

  it("rejects a URL that has expired", () => {
    const now = 1_000_000;
    const url = signLocalUrl(SECRET, REF, now - 1);
    expect(verifyLocalUrl(SECRET, url, now)).toBeNull();
  });

  it("rejects a URL whose ref was tampered with after signing", () => {
    const now = 1_000_000;
    const url = signLocalUrl(SECRET, REF, now + 60_000);
    const tampered = url.replace(encodeURIComponent(REF), encodeURIComponent("user:evil/11111111-1111-1111-1111-111111111111/lease.pdf"));
    expect(verifyLocalUrl(SECRET, tampered, now)).toBeNull();
  });

  it("rejects a URL whose expiry was tampered with after signing (extending its own life)", () => {
    const now = 1_000_000;
    const url = signLocalUrl(SECRET, REF, now + 1);
    const tampered = url.replace(`expires=${now + 1}`, `expires=${now + 1_000_000}`);
    expect(verifyLocalUrl(SECRET, tampered, now)).toBeNull();
  });

  it("rejects a URL signed with a different secret", () => {
    const now = 1_000_000;
    const url = signLocalUrl(SECRET, REF, now + 60_000);
    expect(verifyLocalUrl("a-different-secret", url, now)).toBeNull();
  });

  it("rejects garbage input instead of throwing", () => {
    expect(verifyLocalUrl(SECRET, "not a url at all")).toBeNull();
    expect(verifyLocalUrl(SECRET, "https://example.com/object?ref=x&expires=1&sig=y")).toBeNull();
    expect(verifyLocalUrl(SECRET, "local-storage:///object")).toBeNull();
  });
});
