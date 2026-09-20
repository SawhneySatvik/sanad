/**
 * GET /api/session, POST /api/session/sign-out and POST /api/auth/dev-sign-in — the session summary
 * every caller sees, and the dev-only adapter that finds-or-creates a `users` row outside production.
 * No repository call: a signed-in caller's own display name is a one-row self-lookup by the
 * principal's own userId, never another principal's id, so there is no ownership ambiguity for a
 * canAccess-style check to arbitrate — that chokepoint exists to police access to *other* principals'
 * rows, which never happens here.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { createDevSignInAdapter, deriveDevUserId } from "@/server/auth/dev-session";
import { AppError, notFound, safeMessageFor } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { DOCUMENT_GUEST_TTL_SECONDS } from "@/server/data/documents";
import type { DevSignInInput, SessionOutput } from "@/shared/contracts/session";

const MAX_DISPLAY_NAME_CHARS = 120;

// The same control/bidi character set storage/policy.ts's displayFilename strips, because a display
// name that renders differently than it reads is exactly as dangerous in a sidebar as a filename is.
// Unlike a filename, an empty result here is a hard validation failure — there is no meaningful
// placeholder for "who is this".
const BIDI_CONTROLS_RE = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("")}]`,
  "gu",
);

function sanitizeDisplayName(raw: string): string | null {
  const cleaned = raw.toWellFormed().replace(/\p{Cc}/gu, "").replace(BIDI_CONTROLS_RE, "").trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length === 0 || codePoints.length > MAX_DISPLAY_NAME_CHARS) return null;
  return cleaned;
}

// users.email is NOT NULL (db/schema.ts) but a dev-signed-in user has no real one; a fixed,
// RFC 2606 "invalid" TLD marks the address as intentionally non-deliverable rather than inventing a
// domain that could someday resolve.
function syntheticDevEmail(userId: string): string {
  return `${userId}@dev-sign-in.invalid`;
}

function signInIsAvailable(): boolean {
  try {
    createDevSignInAdapter();
    return true;
  } catch {
    return false;
  }
}

// The guest data TTL, not the guest cookie's own (auth/session.ts's GUEST_SESSION_TTL_SECONDS governs
// only the cookie's lifetime) — this is what the upload TTL notice is actually about.
function guestTtlHours(): number {
  return DOCUMENT_GUEST_TTL_SECONDS / 3600;
}

/** GET /api/session's answer for the caller's current principal. */
export async function getSession(deps: { db: Db }, principal: Principal): Promise<SessionOutput> {
  const base = { signInAvailable: signInIsAvailable(), guestTtlHours: guestTtlHours() };
  if (principal.type === "guest") return { kind: "guest", ...base };

  const [row] = await deps.db
    .select({ displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, principal.userId));
  return { kind: "user", displayName: row?.displayName ?? undefined, ...base };
}

/** POST /api/session/sign-out's answer; the route's "userSession: clear" opt-in clears the cookie separately. */
export async function signOut(): Promise<SessionOutput> {
  return { kind: "guest", signInAvailable: signInIsAvailable(), guestTtlHours: guestTtlHours() };
}

/** What POST /api/auth/dev-sign-in's route hands its "userSession: set" cookie minter. */
export interface DevSignInResult extends SessionOutput {
  userId: string;
}

/**
 * Finds or creates a `users` row for `input.displayName` and answers the session the route's
 * "userSession: set" opt-in signs a cookie for.
 * @throws AppError NOT_FOUND in production (the route 404s, same as a missing id — the dev adapter
 * itself refuses to construct there) and VALIDATION_FAILED for a name that sanitizes to nothing.
 */
export async function devSignIn(deps: { db: Db }, input: DevSignInInput): Promise<DevSignInResult> {
  try {
    createDevSignInAdapter();
  } catch {
    throw notFound();
  }

  const displayName = sanitizeDisplayName(input.displayName);
  if (displayName === null) {
    throw new AppError("VALIDATION_FAILED", safeMessageFor("VALIDATION_FAILED"));
  }

  const userId = deriveDevUserId(displayName);
  await deps.db
    .insert(schema.users)
    .values({ id: userId, email: syntheticDevEmail(userId), displayName })
    .onConflictDoNothing();

  return { kind: "user", displayName, signInAvailable: true, guestTtlHours: guestTtlHours(), userId };
}
