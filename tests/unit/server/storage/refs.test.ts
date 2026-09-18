import { describe, expect, it } from "vitest";
import type { Principal } from "@/server/core/types";
import { AppError } from "@/server/core/errors";
import { buildRef, parseRef, principalKey, refBelongsTo, refToPath, sanitizeFilename } from "@/server/storage/refs";

const USER: Principal = { type: "user", userId: "11111111-1111-1111-1111-111111111111" };
const GUEST: Principal = { type: "guest", guestSessionId: "guest-session-aaaa" };

describe("principalKey", () => {
  it("namespaces a user principal as user:<id>", () => {
    expect(principalKey(USER)).toBe("user:11111111-1111-1111-1111-111111111111");
  });

  it("namespaces a guest principal as guest:<sessionId>", () => {
    expect(principalKey(GUEST)).toBe("guest:guest-session-aaaa");
  });

  it("rejects an id containing a path separator — would silently split a ref into the wrong number of segments", () => {
    const hostile: Principal = { type: "guest", guestSessionId: "a/b" };
    expect(() => principalKey(hostile)).toThrow(AppError);
  });
});

describe("sanitizeFilename", () => {
  it("keeps an ordinary filename unchanged", () => {
    expect(sanitizeFilename("lease-agreement_v2.pdf")).toBe("lease-agreement_v2.pdf");
  });

  it("replaces path separators (both flavors) with underscores", () => {
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFilename("..\\..\\windows\\system32")).not.toContain("\\");
  });

  it("replaces NUL bytes", () => {
    expect(sanitizeFilename("evil\0.pdf")).not.toContain("\0");
  });

  it("replaces spaces and unicode", () => {
    const result = sanitizeFilename("my résumé 📄.pdf");
    expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("falls back to a safe name for an all-dots filename (a literal '..' path segment is still traversal-capable even with no separator in it)", () => {
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(".")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
  });

  it("falls back to a safe name for an empty filename", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  it("separator-only input becomes a valid (if ugly) underscore filename, never empty or all-dots", () => {
    expect(sanitizeFilename("///")).toBe("___");
  });

  it("truncates an excessively long filename", () => {
    const long = "a".repeat(500) + ".pdf";
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(200);
  });

  it("is idempotent — sanitizing an already-sanitized name is a no-op (parseRef relies on this)", () => {
    const once = sanitizeFilename("../weird name!!.pdf");
    expect(sanitizeFilename(once)).toBe(once);
  });
});

describe("buildRef / parseRef round-trip", () => {
  it("builds a ref with exactly 3 segments: principalKey/uuid/filename", () => {
    const ref = buildRef(USER, "lease.pdf");
    const parts = ref.split("/");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("user:11111111-1111-1111-1111-111111111111");
    expect(parts[2]).toBe("lease.pdf");
  });

  it("parseRef accepts a ref built by buildRef", () => {
    const ref = buildRef(GUEST, "nda.docx");
    const parsed = parseRef(ref);
    expect(parsed.principalKey).toBe("guest:guest-session-aaaa");
    expect(parsed.filename).toBe("nda.docx");
  });

  it("refBelongsTo is true for the minting principal, false for another", () => {
    const ref = buildRef(USER, "lease.pdf");
    expect(refBelongsTo(ref, USER)).toBe(true);
    expect(refBelongsTo(ref, GUEST)).toBe(false);
  });
});

describe("parseRef — strict grammar (ref is client-supplied at confirmUpload, treated as hostile)", () => {
  it("rejects a ref with the wrong number of segments", () => {
    expect(() => parseRef("user:a/uuid")).toThrow(AppError);
    expect(() => parseRef("user:a/uuid/extra/segments")).toThrow(AppError);
  });

  it("rejects a ref whose key isn't user: or guest:", () => {
    expect(() => parseRef("admin:a/11111111-1111-1111-1111-111111111111/x.pdf")).toThrow(
      AppError,
    );
  });

  it("rejects a ref whose middle segment isn't a UUID", () => {
    expect(() => parseRef("user:a/not-a-uuid/x.pdf")).toThrow(AppError);
  });

  it("rejects a ref whose filename segment isn't already sanitized (e.g. contains '..')", () => {
    expect(() => parseRef("user:a/11111111-1111-1111-1111-111111111111/..")).toThrow(AppError);
  });

  it("rejects an empty filename segment", () => {
    expect(() => parseRef("user:a/11111111-1111-1111-1111-111111111111/")).toThrow(AppError);
  });

  it("rejects an uppercase/mixed-case id in the key — a case-insensitive filesystem would alias it to the canonical lowercase object", () => {
    // NOT "USER:a" — the `user`/`guest` keyword itself is case-sensitive (the regex's literal
    // `(user|guest):` never matches "USER:"). The alias gap this guards against is in the ID
    // portion after the colon.
    expect(() => parseRef("user:ABC/11111111-1111-1111-1111-111111111111/x.pdf")).toThrow(
      AppError,
    );
    expect(() => parseRef("guest:Abc/11111111-1111-1111-1111-111111111111/x.pdf")).toThrow(
      AppError,
    );
  });

  it("rejects an uppercase/mixed-case UUID segment for the same reason", () => {
    expect(() => parseRef("user:a/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/x.pdf")).toThrow(AppError);
    expect(() => parseRef("user:a/AaAaAaAa-1111-1111-1111-111111111111/x.pdf")).toThrow(AppError);
  });
});

describe("principalKey — canonical lowercase", () => {
  it("rejects an id containing uppercase characters", () => {
    const hostile: Principal = { type: "guest", guestSessionId: "Guest-Session-AAAA" };
    expect(() => principalKey(hostile)).toThrow(AppError);
  });
});

describe("refToPath", () => {
  it("resolves inside the given root for a normally-built ref", () => {
    const ref = buildRef(USER, "lease.pdf");
    const resolved = refToPath("/tmp/storage-root", ref);
    expect(resolved.startsWith("/tmp/storage-root/")).toBe(true);
  });

  it("throws (never returns a path outside root) for a malformed ref", () => {
    expect(() => refToPath("/tmp/storage-root", "not/a/valid-ref")).toThrow(AppError);
  });
});
