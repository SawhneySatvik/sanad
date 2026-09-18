import { describe, expect, it } from "vitest";
import { assertCanAccess, assertCanAccessAll, canAccess, type OwnedResource } from "@/server/data/access";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";

const userA: Principal = { type: "user", userId: "user-a" };
const userB: Principal = { type: "user", userId: "user-b" };
const guestA: Principal = { type: "guest", guestSessionId: "guest-a" };
const guestB: Principal = { type: "guest", guestSessionId: "guest-b" };

function userOwned(userId: string): OwnedResource {
  return { ownerUserId: userId, ownerGuestSessionId: null };
}
function guestOwned(guestSessionId: string): OwnedResource {
  return { ownerUserId: null, ownerGuestSessionId: guestSessionId };
}

describe("canAccess — truth table", () => {
  it("a user principal matches a resource it owns", () => {
    expect(canAccess(userA, userOwned("user-a"))).toBe(true);
  });

  it("a user principal does not match another user's resource", () => {
    expect(canAccess(userB, userOwned("user-a"))).toBe(false);
  });

  it("a guest principal matches a resource it owns", () => {
    expect(canAccess(guestA, guestOwned("guest-a"))).toBe(true);
  });

  it("a guest principal does not match another guest session's resource", () => {
    expect(canAccess(guestB, guestOwned("guest-a"))).toBe(false);
  });

  it("a user principal never matches a guest-owned resource, even with the identical id string", () => {
    const principal: Principal = { type: "user", userId: "shared-id" };
    expect(canAccess(principal, guestOwned("shared-id"))).toBe(false);
  });

  it("a guest principal never matches a user-owned resource, even with the identical id string", () => {
    const principal: Principal = { type: "guest", guestSessionId: "shared-id" };
    expect(canAccess(principal, userOwned("shared-id"))).toBe(false);
  });

  it("a resource with both owners null is malformed and never accessible", () => {
    const malformed: OwnedResource = { ownerUserId: null, ownerGuestSessionId: null };
    expect(canAccess(userA, malformed)).toBe(false);
    expect(canAccess(guestA, malformed)).toBe(false);
  });

  it("a resource with both owners set is malformed and never accessible, even when both match the principal", () => {
    const malformed: OwnedResource = { ownerUserId: "user-a", ownerGuestSessionId: "guest-a" };
    expect(canAccess(userA, malformed)).toBe(false);
    expect(canAccess(guestA, malformed)).toBe(false);
  });
});

describe("canAccess — fail-closed on empty/missing ids", () => {
  it("a guest principal with an empty-string id never matches a resource whose owner column is an empty string", () => {
    const principal: Principal = { type: "guest", guestSessionId: "" };
    const resource: OwnedResource = { ownerUserId: null, ownerGuestSessionId: "" };
    expect(canAccess(principal, resource)).toBe(false);
  });

  it("a user principal with an empty-string id never matches a resource whose owner column is an empty string", () => {
    const principal: Principal = { type: "user", userId: "" };
    const resource: OwnedResource = { ownerUserId: "", ownerGuestSessionId: null };
    expect(canAccess(principal, resource)).toBe(false);
  });

  it("a resource with an unselected (undefined) ownerUserId never matches a principal with an unselected (undefined) userId", () => {
    // Both declared `string | null` by OwnedResource/Principal, but a partial DB select or a
    // malformed principal can produce `undefined` at runtime regardless of what the type says —
    // this is the "undefined === undefined" fail-open shape that a strict-equality check misses.
    const principal = { type: "user", userId: undefined } as unknown as Principal;
    const resource = { ownerUserId: undefined, ownerGuestSessionId: null } as unknown as OwnedResource;
    expect(canAccess(principal, resource)).toBe(false);
  });

  it("a guest principal with a whitespace-only id never matches a resource whose owner column is whitespace-only", () => {
    const principal: Principal = { type: "guest", guestSessionId: "   " };
    const resource: OwnedResource = { ownerUserId: null, ownerGuestSessionId: "   " };
    expect(canAccess(principal, resource)).toBe(false);
  });
});

describe("assertCanAccess", () => {
  it("does not throw when the principal owns the resource", () => {
    expect(() => assertCanAccess(userA, userOwned("user-a"))).not.toThrow();
  });

  it("throws a 404-shaped AppError, never a 403, when the principal does not own the resource", () => {
    let caught: unknown;
    try {
      assertCanAccess(userB, userOwned("user-a"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("throws for a malformed (both-null) resource too, not just a mismatched owner", () => {
    const malformed: OwnedResource = { ownerUserId: null, ownerGuestSessionId: null };
    expect(() => assertCanAccess(userA, malformed)).toThrow(AppError);
  });

  it("throws NOT_FOUND, not a TypeError, when the resource itself failed to load (null/undefined)", () => {
    expect(() => assertCanAccess(userA, null)).toThrow(AppError);
    expect(() => assertCanAccess(userA, undefined)).toThrow(AppError);
    let caught: unknown;
    try {
      assertCanAccess(userA, undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });
});

describe("assertCanAccessAll", () => {
  it("does not throw when the principal owns every referenced resource", () => {
    expect(() => assertCanAccessAll(userA, [userOwned("user-a"), userOwned("user-a")])).not.toThrow();
  });

  it("throws NOT_FOUND when only one of two referenced resources is foreign", () => {
    let caught: unknown;
    try {
      assertCanAccessAll(userA, [userOwned("user-a"), userOwned("user-b")]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("throws NOT_FOUND when a guest principal's second referenced resource belongs to a different guest session", () => {
    expect(() => assertCanAccessAll(guestA, [guestOwned("guest-a"), guestOwned("guest-b")])).toThrow(
      AppError,
    );
  });

  it("throws NOT_FOUND for an empty resource list rather than passing vacuously", () => {
    expect(() => assertCanAccessAll(userA, [])).toThrow(AppError);
    let caught: unknown;
    try {
      assertCanAccessAll(userA, []);
    } catch (err) {
      caught = err;
    }
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });

  it("throws NOT_FOUND, not a TypeError, when one referenced resource failed to load (null/undefined)", () => {
    let caught: unknown;
    try {
      assertCanAccessAll(userA, [userOwned("user-a"), undefined]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("NOT_FOUND");
  });
});
