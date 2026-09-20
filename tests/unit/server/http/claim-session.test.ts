import { afterEach, describe, expect, it, vi } from "vitest";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { clearedGuestSessionCookie } from "@/server/http/claim-session";

describe("clearedGuestSessionCookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears the cookie: empty value, Max-Age=0, still HttpOnly/SameSite=Lax, matching guestSessionCookie()'s own attributes outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(clearedGuestSessionCookie()).toBe(`${GUEST_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  });

  it("carries Secure in production — same source (guestSessionCookie()) as the minted cookie, so the flag can never drift and fail to clear it", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(clearedGuestSessionCookie()).toContain("Secure");
  });

  it("clears the production __Host- cookie by its own name: a clear under the plain name would leave it in place", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(clearedGuestSessionCookie()).toBe("__Host-guest_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
  });
});
