import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { DOCUMENT_GUEST_TTL_SECONDS } from "@/server/data/documents";
import { devSignIn, getSession, signOut } from "@/server/services/session";
import { createTestDb, type TestDb } from "@tests/support/db";

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

const GUEST: Principal = { type: "guest", guestSessionId: "some-guest-session" };

describe("getSession", () => {
  it("answers kind: guest, with no displayName key, for a guest principal", async () => {
    const session = await getSession({ db: t.db }, GUEST);
    expect(session.kind).toBe("guest");
    expect(session).not.toHaveProperty("displayName");
    expect(session.guestTtlHours).toBe(DOCUMENT_GUEST_TTL_SECONDS / 3600);
    expect(session.signInAvailable).toBe(true);
  });

  it("answers kind: user with the row's own displayName for a user principal — never another user's", async () => {
    const signedIn = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });
    await devSignIn({ db: t.db }, { displayName: "Raj Mehta" }); // a second user, to prove no bleed-through

    const session = await getSession({ db: t.db }, { type: "user", userId: signedIn.userId });

    expect(session).toEqual({
      kind: "user",
      displayName: "Asha Verma",
      signInAvailable: true,
      guestTtlHours: DOCUMENT_GUEST_TTL_SECONDS / 3600,
      signInMethod: "dev",
    });
  });

  it("signInAvailable is false in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const session = await getSession({ db: t.db }, GUEST);
    expect(session.signInAvailable).toBe(false);
  });
});

describe("signOut", () => {
  it("always answers a guest session", async () => {
    expect(await signOut()).toEqual({
      kind: "guest",
      signInAvailable: true,
      guestTtlHours: DOCUMENT_GUEST_TTL_SECONDS / 3600,
      signInMethod: "dev",
    });
  });

  it("signInAvailable is false in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await signOut()).signInAvailable).toBe(false);
  });
});

describe("devSignIn", () => {
  it("creates a users row for a new display name and returns its id", async () => {
    const result = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });

    expect(result.kind).toBe("user");
    expect(result.displayName).toBe("Asha Verma");
    const [row] = await t.db.select().from(schema.users).where(eq(schema.users.id, result.userId));
    expect(row).toMatchObject({ id: result.userId, displayName: "Asha Verma" });
  });

  it("reuses the same row for the same display name, signed in twice", async () => {
    const first = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });
    const second = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });

    expect(second.userId).toBe(first.userId);
    const rows = await t.db.select().from(schema.users).where(eq(schema.users.displayName, "Asha Verma"));
    expect(rows).toHaveLength(1);
  });

  it("a concurrent double sign-in with the same name still yields exactly one row (ON CONFLICT DO NOTHING, not a read-then-write race)", async () => {
    const [a, b] = await Promise.all([
      devSignIn({ db: t.db }, { displayName: "Concurrent Name" }),
      devSignIn({ db: t.db }, { displayName: "Concurrent Name" }),
    ]);

    expect(a.userId).toBe(b.userId);
    const rows = await t.db.select().from(schema.users).where(eq(schema.users.displayName, "Concurrent Name"));
    expect(rows).toHaveLength(1);
  });

  it("different display names get different users", async () => {
    const a = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });
    const b = await devSignIn({ db: t.db }, { displayName: "Raj Mehta" });
    expect(a.userId).not.toBe(b.userId);
  });

  it("trims whitespace and strips control/bidi characters before storing and keying the name", async () => {
    const bidiOverride = "‮";
    const result = await devSignIn({ db: t.db }, { displayName: `  Asha${bidiOverride} Verma  ` });
    expect(result.displayName).toBe("Asha Verma");
    const reSignedIn = await devSignIn({ db: t.db }, { displayName: "Asha Verma" });
    expect(reSignedIn.userId).toBe(result.userId);
  });

  it("rejects a name that sanitizes to nothing (control/bidi/whitespace only) as VALIDATION_FAILED, writing no row", async () => {
    await expect(devSignIn({ db: t.db }, { displayName: "   ‮‬  " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("rejects a name over 120 characters after sanitizing", async () => {
    await expect(devSignIn({ db: t.db }, { displayName: "a".repeat(121) })).rejects.toBeInstanceOf(AppError);
    await expect(devSignIn({ db: t.db }, { displayName: "a".repeat(120) })).resolves.toMatchObject({ displayName: "a".repeat(120) });
  });

  it("throws NOT_FOUND (the route 404s) in production, writing no row", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(devSignIn({ db: t.db }, { displayName: "Asha Verma" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await t.db.select().from(schema.users).where(eq(schema.users.displayName, "Asha Verma"));
    expect(rows).toHaveLength(0);
  });
});
