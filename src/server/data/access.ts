/**
 * The single authorization chokepoint. Every repository function calls canAccess/assertCanAccess/
 * assertCanAccessAll instead of inlining its own ownership check — one code path to audit. Synchronous
 * and pure: a repository fetches the resource(s) first, then calls this on the already-loaded row(s).
 */

import { notFound } from "../core/errors";
import type { Principal } from "../core/types";

/** The ownership columns canAccess checks: exactly one of these two is ever non-blank. */
export type OwnedResource = {
  ownerUserId: string | null;
  ownerGuestSessionId: string | null;
};

// `unknown`-typed on purpose: a partial DB select or a malformed principal can produce `undefined` at
// runtime despite OwnedResource's declared `string | null`, and the DB's `num_nonnulls` CHECK counts
// `""` as a set owner — both would otherwise let two "missing" values compare equal and fail open.
function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Whether `principal` owns `resource`: exactly one owner column must be set and match the principal. */
export function canAccess(principal: Principal, resource: OwnedResource): boolean {
  const hasUserOwner = isNonEmptyId(resource.ownerUserId);
  const hasGuestOwner = isNonEmptyId(resource.ownerGuestSessionId);

  // A resource must have exactly one owner. Both null (never legitimately
  // persisted) or both set (an association bug) are malformed — never
  // "accidentally true" for whichever principal happens to be asking.
  if (hasUserOwner === hasGuestOwner) return false;

  if (hasUserOwner) {
    return (
      principal.type === "user" &&
      isNonEmptyId(principal.userId) &&
      principal.userId === resource.ownerUserId
    );
  }
  return (
    principal.type === "guest" &&
    isNonEmptyId(principal.guestSessionId) &&
    principal.guestSessionId === resource.ownerGuestSessionId
  );
}

/**
 * Throws 404, never 403 — a 403 confirms the resource exists. A possibly-missing resource (a
 * failed/absent lookup) denies the same way as a foreign one, so an `undefined` for a nonexistent id
 * 404s exactly like an id that belongs to someone else, never a TypeError surfacing as a 500.
 */
export function assertCanAccess(principal: Principal, resource: OwnedResource | null | undefined): void {
  if (!resource || !canAccess(principal, resource)) {
    throw notFound();
  }
}

/**
 * For any function that associates two or more entities: verifies ownership of every referenced
 * entity, not just the primary one. Callers pass one already-loaded row (or `null`/`undefined`, if
 * the lookup failed) per entity. An empty list throws rather than passing vacuously — zero resolved
 * entities is itself the caller-bug shape this function exists to catch.
 */
export function assertCanAccessAll(
  principal: Principal,
  resources: readonly (OwnedResource | null | undefined)[],
): void {
  if (resources.length === 0) {
    throw notFound();
  }
  for (const resource of resources) {
    assertCanAccess(principal, resource);
  }
}
