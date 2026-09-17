import { describe, expect, it } from "vitest";
import { DevSignInInput, SessionOutput } from "@/shared/contracts/session";

describe("SessionOutput", () => {
  it("accepts a guest session — no displayName key", () => {
    const parsed = SessionOutput.parse({ kind: "guest", signInAvailable: false, guestTtlHours: 3 });
    expect(parsed).toEqual({ kind: "guest", signInAvailable: false, guestTtlHours: 3 });
    expect(Object.keys(parsed).sort()).toEqual(["guestTtlHours", "kind", "signInAvailable"]);
  });

  it("accepts a user session with a displayName", () => {
    const parsed = SessionOutput.parse({ kind: "user", displayName: "Asha Verma", signInAvailable: true, guestTtlHours: 3 });
    expect(Object.keys(parsed).sort()).toEqual(["displayName", "guestTtlHours", "kind", "signInAvailable"]);
  });

  it("carries no id, email or token key anywhere — a spread carrying one is stripped, never round-tripped", () => {
    const forged = {
      kind: "user",
      displayName: "Asha Verma",
      signInAvailable: true,
      guestTtlHours: 3,
      userId: "a1a1a1a1-0000-4000-8000-0000000000a1",
      id: "a1a1a1a1-0000-4000-8000-0000000000a1",
      email: "asha@example.com",
      token: "not-a-real-token",
      accessToken: "not-a-real-token",
      sessionId: "not-a-real-session-id",
    };
    const parsed = SessionOutput.parse(forged);
    expect(Object.keys(parsed).sort()).toEqual(["displayName", "guestTtlHours", "kind", "signInAvailable"]);
    const json = JSON.stringify(parsed);
    for (const leaked of ["userId", "id", "email", "token", "accessToken", "sessionId", forged.email, forged.userId]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("rejects a kind outside guest/user, and a non-boolean signInAvailable", () => {
    expect(SessionOutput.safeParse({ kind: "admin", signInAvailable: false, guestTtlHours: 3 }).success).toBe(false);
    expect(SessionOutput.safeParse({ kind: "guest", signInAvailable: "false", guestTtlHours: 3 }).success).toBe(false);
  });

  it("rejects a non-positive guestTtlHours", () => {
    expect(SessionOutput.safeParse({ kind: "guest", signInAvailable: false, guestTtlHours: 0 }).success).toBe(false);
    expect(SessionOutput.safeParse({ kind: "guest", signInAvailable: false, guestTtlHours: -1 }).success).toBe(false);
  });
});

describe("DevSignInInput", () => {
  it("accepts a plain display name", () => {
    expect(DevSignInInput.parse({ displayName: "Asha Verma" })).toEqual({ displayName: "Asha Verma" });
  });

  it("rejects an empty string and a missing field", () => {
    expect(DevSignInInput.safeParse({ displayName: "" }).success).toBe(false);
    expect(DevSignInInput.safeParse({}).success).toBe(false);
  });

  it("is a strict object — a client-sent userId or id is rejected outright, never silently accepted", () => {
    expect(DevSignInInput.safeParse({ displayName: "Asha", userId: "x" }).success).toBe(false);
    expect(DevSignInInput.safeParse({ displayName: "Asha", id: "x" }).success).toBe(false);
  });
});
