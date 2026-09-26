import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { createGuestSession, guestSessionCookie, guestSessionCookieName } from "@/server/auth/session";

function page(cookie?: string) {
  return new NextRequest("http://localhost/chat", { headers: cookie ? { cookie } : {} });
}

describe("proxy", () => {
  beforeEach(() => vi.stubEnv("GUEST_SESSION_SECRET", "p".repeat(32)));
  afterEach(() => vi.unstubAllEnvs());

  it("mints a signed guest session on a first page load with no cookie", () => {
    const setCookie = proxy(page()).headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${guestSessionCookieName()}=`)).toBe(true);
    expect(setCookie).toContain("HttpOnly");
  });

  it("leaves an existing valid guest session alone, so every later request is the same guest", () => {
    const session = createGuestSession();
    const cookie = guestSessionCookie(session.cookieValue);
    expect(proxy(page(`${cookie.name}=${cookie.value}`)).headers.get("set-cookie")).toBeNull();
  });

  it("replaces a tampered cookie rather than trusting it", () => {
    expect(proxy(page(`${guestSessionCookieName()}=not-a-signed-value`)).headers.get("set-cookie")).not.toBeNull();
  });
});
