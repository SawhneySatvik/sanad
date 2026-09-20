/**
 * The cleared-cookie response for a successful claim. `claim.user` is the `authenticateUser` answer
 * that also resolved `principal`; `claim.guest` is the request's own signed cookie, read
 * independently — never from the body, a header, or a query parameter.
 */

import { guestSessionCookie } from "@/server/auth/session";
import { serializeCookie, type GuestPrincipal, type UserPrincipal } from "./principal";

/** The two identities a claim resolves. */
export interface ClaimSession {
  user: UserPrincipal | null; // null: nobody is signed in.
  guest: GuestPrincipal | null; // null: no valid signed guest cookie rode along.
}

// Clears (Max-Age=0) rather than rotates, so an already-signed-in user never gets a fresh guest
// session. The old cookie's signature stays valid server-side until its own TTL, but a replay is
// harmless — a second claim on the same guest session moves zero rows.
/** The Set-Cookie a successful claim answers with, so the browser drops the just-claimed guest session. */
export function clearedGuestSessionCookie(): string {
  return serializeCookie({ ...guestSessionCookie(""), maxAge: 0 });
}
