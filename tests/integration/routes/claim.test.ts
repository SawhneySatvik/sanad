// POST /api/auth/claim (docs/API.md). Drives the real route end to end over PGlite: route()
// (src/server/http/handler.ts's `claimSession`/`clearsGuestSession` opt-in) -> auth.claimGuestSession
// -> the committed claimGuestData.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import * as claimRoute from "@/app/api/auth/claim/route";
import * as documentsRoute from "@/app/api/documents/[id]/route";
import * as documentSaveRoute from "@/app/api/documents/[id]/save-to-project/route";
import * as projectsRoute from "@/app/api/projects/route";
import { insertDocument } from "@tests/support/auth/claim";
import { GUEST_SESSION_COOKIE_NAME } from "@/server/auth/session";
import { ConfigError } from "@/server/core/env";
import { ClaimResultOutput } from "@/shared/contracts/claim";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  mintedCookie,
  request,
  userA,
  userB,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

const inAnHour = () => new Date(Date.now() + 3_600_000);

async function ownerOf(harness: RouteHarness, documentId: string) {
  const [row] = await harness.t.db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  return row;
}

// The attributes a guest_session Set-Cookie carries besides its name=value and Max-Age — comparing
// THESE between a genuinely minted cookie and the claim route's cleared one proves the cleared
// cookie is real, not a tautology against the same function the route itself calls.
function cookieAttributes(setCookie: string): string {
  return setCookie
    .split("; ")
    .filter((part) => !part.startsWith("Max-Age=") && !part.startsWith(`${GUEST_SESSION_COOKIE_NAME}=`))
    .join("; ");
}

describe("POST /api/auth/claim", () => {
  it("signed-in user + guest cookie with rows: counts match, the rows are now the user's, GET as the user succeeds, GET as the old guest 404s, and the response clears the guest cookie (real attributes, not compared against itself)", async () => {
    // A genuinely minted cookie (no request-scoped assumption) to compare the cleared one against.
    const mintRes = await callRoute(projectsRoute.GET, request("GET", "/api/projects"));
    const minted = mintedCookie(mintRes);
    if (!minted) throw new Error("expected GET /api/projects to mint a guest session");

    const { cookie, guestSessionId } = guestCookie();
    const guestPrincipal = { type: "guest" as const, guestSessionId };
    const document = await insertDocument(h.t, guestPrincipal, inAnHour());

    h.signIn(userA);
    const res = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie }));
    expect(res.status).toBe(200);
    expect(ClaimResultOutput.parse(await res.json())).toEqual({ documents: 1, comparisons: 0, drafts: 0 });

    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0].startsWith(`${GUEST_SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(setCookies[0]).toContain("Max-Age=0");
    expect(cookieAttributes(setCookies[0])).toBe(cookieAttributes(minted));

    // The rows are now the user's.
    expect(await ownerOf(h, document.id)).toMatchObject({ ownerUserId: userA.userId, ownerGuestSessionId: null });
    const asUser = await callRoute(documentsRoute.GET, request("GET", `/api/documents/${document.id}`), {
      id: document.id,
    });
    expect(asUser.status).toBe(200);

    // The old guest session 404s on the same document.
    h.signIn(null);
    const asOldGuest = await callRoute(
      documentsRoute.GET,
      request("GET", `/api/documents/${document.id}`, { cookie }),
      { id: document.id },
    );
    expect(asOldGuest.status).toBe(404);

    // Replaying the exact same claim now moves zero rows (claimGuestData's own re-check).
    h.signIn(userA);
    const replay = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
  });

  it("no signed-in user: 400 VALIDATION_FAILED, zero rows moved, and the guest cookie is NOT cleared (no Set-Cookie at all — a valid one was already present)", async () => {
    const { cookie, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, inAnHour());

    h.signIn(null);
    const res = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie }));
    // Cookie check FIRST: a fail-open mutant that answers 200 would still show its (wrong) clearing
    // cookie here, so this assertion is the one that actually catches "no cookie clear" — asserting
    // status first would let a status-only mutant slip past this line unexercised.
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    // No detail: the guest session id (the one piece of caller-specific data this request carries)
    // never appears anywhere in the response body.
    expect(body).not.toContain(guestSessionId);

    expect(await ownerOf(h, document.id)).toMatchObject({ ownerGuestSessionId: guestSessionId, ownerUserId: null });
  });

  it("no guest cookie: zero counts, not an error (still 200, still clears — nothing to clear, but the flag doesn't know that)", async () => {
    h.signIn(userA);
    const res = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    const setCookies = res.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0].startsWith(`${GUEST_SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(setCookies[0]).toContain("Max-Age=0");
  });

  it("a signed-in user whose users row does not exist (the auth adapter's precondition, unmet): 500 with the generic safe body, zero rows moved, and NO Set-Cookie clearing", async () => {
    const { cookie, guestSessionId } = guestCookie();
    const document = await insertDocument(h.t, { type: "guest", guestSessionId }, inAnHour());
    // A user principal with no row in `users` — the precondition auth.ts documents but cannot
    // itself enforce (that's the future auth adapter's job).
    const phantomUser = { type: "user" as const, userId: "9f9f9f9f-0000-4000-8000-0000000000ff" };

    h.signIn(phantomUser);
    const res = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    expect(res.headers.getSetCookie()).toEqual([]);

    expect(await ownerOf(h, document.id)).toMatchObject({ ownerGuestSessionId: guestSessionId, ownerUserId: null });
  });

  // Forges a REAL victim guest's id (one who owns rows) with a wrong signature — a placeholder id
  // with no rows behind it would read as "zero counts" whether or not the signature check ran at
  // all.
  it("a tampered guest cookie (a real victim's id, wrong signature) behaves exactly like no cookie: zero counts, and the victim's rows stay theirs — the signature is actually checked, not decorative", async () => {
    const { guestSessionId: victimGuestId } = guestCookie();
    const victimDocument = await insertDocument(h.t, { type: "guest", guestSessionId: victimGuestId }, inAnHour());
    const forged = `${GUEST_SESSION_COOKIE_NAME}=${victimGuestId}.${Math.floor(Date.now() / 1000)}.not-a-real-signature`;

    h.signIn(userA);
    const res = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie: forged }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    expect(await ownerOf(h, victimDocument.id)).toMatchObject({ ownerGuestSessionId: victimGuestId, ownerUserId: null });
  });

  // The route has no `body`/`query` schema at all, so a spoofed identity anywhere in the request is
  // inert by construction — this proves it behaviorally, against a real victim guest with real
  // rows, not just "the field is absent from the contract".
  it("a header, a query param and a JSON body field naming another guest's/user's id move nothing of theirs — only the signed cookie's own guest and the hook's own user are ever touched", async () => {
    const { cookie: myCookie, guestSessionId: myGuestId } = guestCookie();
    const { guestSessionId: victimGuestId } = guestCookie(); // never sent as a cookie — the victim
    const myDocument = await insertDocument(h.t, { type: "guest", guestSessionId: myGuestId }, inAnHour());
    const victimDocument = await insertDocument(h.t, { type: "guest", guestSessionId: victimGuestId }, inAnHour());

    h.signIn(userA);
    const req = request("POST", `/api/auth/claim?guestSessionId=${victimGuestId}&userId=${userB.userId}`, {
      cookie: myCookie,
      headers: { "x-guest-session-id": victimGuestId, "x-user-id": userB.userId },
      json: { guestSessionId: victimGuestId, userId: userB.userId },
    });
    const res = await callRoute(claimRoute.POST, req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: 1, comparisons: 0, drafts: 0 });

    expect(await ownerOf(h, myDocument.id)).toMatchObject({ ownerUserId: userA.userId });
    // The victim's document is untouched — never even looked at.
    expect(await ownerOf(h, victimDocument.id)).toMatchObject({ ownerGuestSessionId: victimGuestId, ownerUserId: null });
  });

  // Distinct from the case above: no real cookie at all, so a vulnerable implementation might fall
  // back to a spoofed identity (e.g. `claim.guest ?? guestFromQuery`) precisely when there's nothing
  // legitimate to use instead — the case a fallback bug would actually fire on.
  it("no cookie at all: a spoofed guest/user id in the query, a header and the body still move nothing — same as no cookie, not a fallback", async () => {
    const { guestSessionId: victimGuestId } = guestCookie(); // never sent as a cookie
    const victimDocument = await insertDocument(h.t, { type: "guest", guestSessionId: victimGuestId }, inAnHour());

    h.signIn(userA);
    const req = request("POST", `/api/auth/claim?guestSessionId=${victimGuestId}&userId=${userB.userId}`, {
      headers: { "x-guest-session-id": victimGuestId, "x-user-id": userB.userId },
      json: { guestSessionId: victimGuestId, userId: userB.userId },
    });
    const res = await callRoute(claimRoute.POST, req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: 0, comparisons: 0, drafts: 0 });
    expect(await ownerOf(h, victimDocument.id)).toMatchObject({ ownerGuestSessionId: victimGuestId, ownerUserId: null });
  });
});

describe("usesLlm: false (projects, save-to-project and claim never build an LLM provider)", () => {
  it("POST /api/projects, POST /api/documents/:id/save-to-project and POST /api/auth/claim all succeed even when the provider thunk throws", async () => {
    const harness = await createRouteHarness({
      providers: () => {
        throw new ConfigError("GEMINI_API_KEY");
      },
    });
    try {
      harness.signIn(userA);
      const projectRes = await callRoute(projectsRoute.POST, request("POST", "/api/projects", { json: { name: "p" } }));
      expect(projectRes.status).toBe(200);
      const project = (await projectRes.json()) as { id: string };

      const document = await insertDocument(harness.t, userA, null);
      const saveRes = await callRoute(
        documentSaveRoute.POST,
        request("POST", `/api/documents/${document.id}/save-to-project`, { json: { projectId: project.id } }),
        { id: document.id },
      );
      expect(saveRes.status).toBe(200);

      const { cookie, guestSessionId } = guestCookie();
      await insertDocument(harness.t, { type: "guest", guestSessionId }, inAnHour());
      const claimRes = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { cookie }));
      expect(claimRes.status).toBe(200);
    } finally {
      await harness.close();
    }
  });
});
