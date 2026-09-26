// The real account-session cookie (src/server/auth/user-session.ts), resolved through the exact
// hook production wires into the container (container.ts's productionContainerOptions), not the
// route harness's own test-controlled authenticateUser stub — this drives the genuine channel: a
// request carrying user B's signed cookie must resolve to B's own principal, never A's, and the
// existing canAccess chokepoint then denies cross-principal access the same way it always does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as documentsRoute from "@/app/api/documents/[id]/route";
import { guestSessionCookieName } from "@/server/auth/session";
import { mintUserSession, userSessionCookie } from "@/server/auth/user-session";
import { createContainer, productionContainerOptions, setContainerForTests } from "@/server/container";
import { insertDocument } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, request, SIGNING_SECRET, TEST_MODEL_ID, userA, userB, type RouteHarness } from "./harness";

const GENEROUS_LIMITS = {
  ipPerMinute: 1000,
  principalPerMinute: 1000,
  ipLlmPerMinute: 1000,
  principalPerDay: 1000,
  ipLlmPerDay: 1000,
  primaryPerMinute: 1000,
  secondaryPerMinute: 1000,
};

let h: RouteHarness;
beforeEach(async () => {
  vi.stubEnv("USER_SESSION_SECRET", "z".repeat(32));
  h = await createRouteHarness();
  // Replaces the harness's own container with one wired exactly as production is: identity resolved
  // from the request's real, signed account-session cookie, never a test-controlled stub.
  setContainerForTests(
    createContainer({
      db: h.t.db,
      storage: () => h.storage,
      llm: () => ({ primary: h.primary, secondary: h.secondary }),
      localStorageSigningSecret: () => SIGNING_SECRET,
      primaryModelId: TEST_MODEL_ID,
      // The exact hook production wires (container.ts's productionContainerOptions), not a
      // hand-rolled copy — so a drift in the real wiring would fail here too, not just in production.
      authenticateUser: productionContainerOptions(h.t.db).authenticateUser,
      rateLimits: GENEROUS_LIMITS,
    }),
  );
});
afterEach(async () => {
  await h.close();
  vi.unstubAllEnvs();
});

function accountCookieHeader(userId: string): string {
  const { cookieValue } = mintUserSession(userId);
  const attrs = userSessionCookie(cookieValue);
  return `${attrs.name}=${attrs.value}`;
}

describe("the real account-session cookie identifies its own principal only", () => {
  it("user B's cookie gets 404 on user A's document; user A's own cookie gets 200", async () => {
    const document = await insertDocument(h.t, userA, null);
    const cookieA = accountCookieHeader(userA.userId);
    const cookieB = accountCookieHeader(userB.userId);

    const asB = await callRoute(
      documentsRoute.GET,
      request("GET", `/api/documents/${document.id}`, { cookie: cookieB }),
      { id: document.id },
    );
    expect(asB.status).toBe(404);

    const asA = await callRoute(
      documentsRoute.GET,
      request("GET", `/api/documents/${document.id}`, { cookie: cookieA }),
      { id: document.id },
    );
    expect(asA.status).toBe(200);
  });

  it("a tampered account-session cookie (real user A id, wrong signature) resolves to a fresh guest principal, never to A — 404, not 200, and a fresh guest cookie is minted", async () => {
    const document = await insertDocument(h.t, userA, null);
    const { cookieValue } = mintUserSession(userA.userId);
    const [id, issuedAt, signature] = cookieValue.split(".");
    const flipped = signature.slice(0, -1) + (signature.at(-1) === "A" ? "B" : "A");
    const attrs = userSessionCookie(`${id}.${issuedAt}.${flipped}`);

    const res = await callRoute(
      documentsRoute.GET,
      request("GET", `/api/documents/${document.id}`, { cookie: `${attrs.name}=${attrs.value}` }),
      { id: document.id },
    );
    expect(res.status).toBe(404);
    // accountUserFromCookie answers null for a tampered cookie, so resolveRequestPrincipal falls all
    // the way through to minting a brand-new guest session — never a 500, never user A's principal.
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${guestSessionCookieName()}=`))).toBe(true);
  });
});
