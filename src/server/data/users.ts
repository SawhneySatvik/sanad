/**
 * Users repository. upsertUser writes a row named by a VerifiedIdentity — producible only by
 * verifySupabaseAccessToken, never a plain Principal — because this is identity provisioning, not
 * principal-scoped data access: there is no separate "target id" a spoofed request could name, and
 * so no canAccess chokepoint to call (that chokepoint is for reads/writes of a caller's existing
 * rows; this is the one write that creates the row a Principal will later name). `display_name` is
 * set from the email's local part only on first insert (a conflict leaves it alone, so a display
 * name the user later customized in Settings is never clobbered on the next sign-in) and `email` is
 * refreshed every time, in case it changed at the provider.
 */

import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import type { VerifiedIdentity } from "../auth/supabase-auth";

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/** Creates or refreshes `identity`'s own `users` row; never touches any other user's. */
export async function upsertUser(db: Db, identity: VerifiedIdentity): Promise<{ displayName: string | null }> {
  const [row] = await db
    .insert(schema.users)
    .values({ id: identity.userId, email: identity.email, displayName: emailLocalPart(identity.email) })
    .onConflictDoUpdate({ target: schema.users.id, set: { email: identity.email } })
    .returning({ displayName: schema.users.displayName });
  return row;
}
