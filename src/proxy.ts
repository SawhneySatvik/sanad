import { NextResponse, type NextRequest } from "next/server";
import { createGuestSession, guestSessionCookie } from "@/server/auth/session";
import { accountUserFromCookie, devUserFromCookie, guestFromCookie, serializeCookie } from "@/server/http/principal";

/**
 * Mints the guest session on the first page load, before the page makes any API call. Left to the
 * API routes, a new visitor's first few requests fire in parallel with no cookie yet, each minting a
 * different guest: a sample opened under one guest is then read back as another's and 404s.
 */
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (guestFromCookie(request) || devUserFromCookie(request) || accountUserFromCookie(request)) return response;
  const session = createGuestSession();
  response.headers.append("set-cookie", serializeCookie(guestSessionCookie(session.cookieValue)));
  return response;
}

// Pages only: API routes keep resolving (and minting) identity themselves, and static files need none.
export const config = {
  matcher: ["/((?!api/|_next/|assets/|icons/|favicon\\.ico|icon\\.svg|apple-icon\\.png|robots\\.txt|manifest\\.webmanifest|llms\\.txt).*)"],
};
