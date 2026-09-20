// Cross-site refusal: a state-changing request a browser marks `Sec-Fetch-Site: cross-site` or
// `same-site` — or, from a browser too old to send that header, whose Origin's host isn't the host
// it addressed — is a fixed 403 before ANY work: no IP-tier write, no principal, no minted guest session, no
// cookie, no service, no LLM call. same-origin, none, a request with neither header, and safe
// methods pass.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as claimRoute from "@/app/api/auth/claim/route";
import * as devSignInRoute from "@/app/api/auth/dev-sign-in/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as healthRoute from "@/app/api/health/route";
import * as signOutRoute from "@/app/api/session/sign-out/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { DEV_USER_SESSION_COOKIE_NAME } from "@/server/auth/dev-session";
import { CORRELATION_ID_HEADER } from "@/server/http/errors";
import { route } from "@/server/http/handler";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  uploadViaRoutes,
  userA,
  type RouteHarness,
} from "./harness";

const REFUSED = { error: { code: "FORBIDDEN", message: "This request is not allowed." } };
const crossSite = { "sec-fetch-site": "cross-site" };

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

async function count(sqlCount: string): Promise<number> {
  return (await h.t.client.query<{ n: number }>(sqlCount)).rows[0].n;
}

// Every row a request could write before or during its service call.
async function dbWork(): Promise<number[]> {
  return [
    await count("SELECT coalesce(sum(request_count), 0)::int AS n FROM ip_rate_limit_buckets"),
    await count("SELECT coalesce(sum(request_count), 0)::int AS n FROM rate_limit_buckets"),
    await count("SELECT count(*)::int AS n FROM documents"),
  ];
}

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual(REFUSED);
  expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.headers.getSetCookie()).toEqual([]);
}

async function ownerOf(documentId: string): Promise<{ owner_user_id: string | null; owner_guest_session_id: string | null }> {
  const result = await h.t.client.query<{ owner_user_id: string | null; owner_guest_session_id: string | null }>(
    "SELECT owner_user_id, owner_guest_session_id FROM documents WHERE id = $1",
    [documentId],
  );
  return result.rows[0];
}

describe("a cross-site state-changing request is refused before any work", () => {
  it("POST /api/auth/claim: 403, no cookie, no row moved, no DB write — then the same-origin claim works", async () => {
    const guest = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(guest.cookie);
    h.signIn(userA);
    const before = await dbWork();
    const calls = h.primary.callCount;

    const refused = await callRoute(
      claimRoute.POST,
      request("POST", "/api/auth/claim", { cookie: guest.cookie, headers: crossSite }),
    );

    await expectRefused(refused);
    expect(await dbWork()).toEqual(before);
    expect(await ownerOf(documentId)).toEqual({ owner_user_id: null, owner_guest_session_id: guest.guestSessionId });
    expect(h.primary.callCount).toBe(calls);

    const sameOrigin = await callRoute(
      claimRoute.POST,
      request("POST", "/api/auth/claim", { cookie: guest.cookie, headers: { "sec-fetch-site": "same-origin" } }),
    );
    expect(sameOrigin.status).toBe(200);
    expect(await ownerOf(documentId)).toEqual({ owner_user_id: userA.userId, owner_guest_session_id: null });
  });

  it("the attack itself — a cookie-less cross-site form POST — mints no guest session to overwrite the victim's", async () => {
    const before = await dbWork();

    const refused = await callRoute(claimRoute.POST, request("POST", "/api/auth/claim", { headers: crossSite }));

    await expectRefused(refused);
    expect(await dbWork()).toEqual(before);
  });

  it("POST /api/documents: 403, no document, no LLM call, the ref unspent — the same-origin request then succeeds", async () => {
    const { cookie } = guestCookie();
    const input = await uploadViaRoutes(cookie);
    const before = await dbWork();

    const refused = await callRoute(
      documentsRoute.POST,
      request("POST", "/api/documents", { cookie, json: input, headers: crossSite }),
    );

    await expectRefused(refused);
    expect(await dbWork()).toEqual(before);
    expect(h.primary.callCount).toBe(0);
    expect((await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }))).status).toBe(200);
  });

  it("POST /api/auth/dev-sign-in: 403, no user row created, no user cookie set — then the same-origin sign-in works", async () => {
    const before = await dbWork();

    const refused = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" }, headers: crossSite }),
    );

    await expectRefused(refused);
    expect(await dbWork()).toEqual(before);

    const sameOrigin = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }),
    );
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.getSetCookie().some((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`))).toBe(true);
  });

  it("POST /api/session/sign-out: 403, no cookie cleared — a signed-in caller's cookie survives the attack, then the same-origin sign-out clears it", async () => {
    const signedIn = await callRoute(
      devSignInRoute.POST,
      request("POST", "/api/auth/dev-sign-in", { json: { displayName: "Asha Verma" } }),
    );
    const userCookie = signedIn.headers.getSetCookie().find((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`))!;
    const cookieHeader = userCookie.split(";")[0];

    const refused = await callRoute(
      signOutRoute.POST,
      request("POST", "/api/session/sign-out", { cookie: cookieHeader, headers: crossSite }),
    );
    await expectRefused(refused);

    const sameOrigin = await callRoute(signOutRoute.POST, request("POST", "/api/session/sign-out", { cookie: cookieHeader }));
    expect(sameOrigin.status).toBe(200);
    const cleared = sameOrigin.headers.getSetCookie().find((c) => c.startsWith(`${DEV_USER_SESSION_COOKIE_NAME}=`));
    expect(cleared).toContain("Max-Age=0");
  });

  it("PUT (the upload relay), PATCH and DELETE are refused the same way, whatever the header's case", async () => {
    const { cookie } = guestCookie();
    const target = (await (
      await callRoute(
        uploadsRoute.POST,
        request("POST", "/api/uploads", { cookie, json: { filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 } }),
      )
    ).json()) as { uploadUrl: string; ref: string };
    const anyMethod = route({ usesLlm: false, response: z.object({ ok: z.boolean() }), run: async () => ({ ok: true }) });

    await expectRefused(
      await callRoute(
        uploadsRelayRoute.PUT,
        request("PUT", target.uploadUrl, { cookie, bytes: Buffer.from("x"), headers: { "sec-fetch-site": "Cross-Site" } }),
      ),
    );
    await expect(h.storage.readObject(target.ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const method of ["PATCH", "DELETE"]) {
      await expectRefused(await callRoute(anyMethod, request(method, "/api/test", { cookie, headers: crossSite })));
    }
  });
});

describe("same-site, and a foreign Origin when Sec-Fetch-Site is absent, are refused the same way", () => {
  const uploadTarget = (headers: Record<string, string>, cookie?: string) =>
    callRoute(
      uploadsRoute.POST,
      request("POST", "/api/uploads", { cookie, json: { filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 }, headers }),
    );

  // What a browser sends to this app at app.example: its Host, and a proxy's X-Forwarded-Host.
  const host = { host: "app.example" };

  it.each([
    ["Sec-Fetch-Site: same-site (a sibling subdomain)", { ...host, "sec-fetch-site": "same-site" }],
    ["no Sec-Fetch-Site, a foreign Origin", { ...host, origin: "https://evil.example" }],
    ["no Sec-Fetch-Site, a sibling subdomain's Origin", { ...host, origin: "https://files.app.example" }],
    ["no Sec-Fetch-Site, Origin: null (a sandboxed frame)", { ...host, origin: "null" }],
    ["no Sec-Fetch-Site, this host on another port", { ...host, origin: "https://app.example:8443" }],
    ["no Sec-Fetch-Site, an Origin but no Host at all", { origin: "https://app.example" }],
    ["no Sec-Fetch-Site, Host matching only a later X-Forwarded-Host entry", { host: "internal:3000", "x-forwarded-host": "proxy.example, app.example", origin: "https://app.example" }],
    ["an unrecognised Sec-Fetch-Site falls back to Origin", { ...host, "sec-fetch-site": "bogus", origin: "https://evil.example" }],
  ])("%s: 403 before any work, no cookie", async (_label, headers) => {
    const before = await dbWork();

    await expectRefused(await uploadTarget(headers));
    expect(await dbWork()).toEqual(before);
  });

  it.each([
    ["the Host it was sent to", { ...host, origin: "https://app.example" }],
    ["X-Forwarded-Host's first entry behind a proxy", { host: "internal:3000", "x-forwarded-host": "app.example, internal", origin: "https://app.example" }],
  ])("no Sec-Fetch-Site with an Origin matching %s passes (positive control)", async (_label, headers) => {
    expect((await uploadTarget(headers, guestCookie().cookie)).status).toBe(200);
  });

  it("a present Sec-Fetch-Site decides on its own: same-origin passes whatever Origin says", async () => {
    const res = await uploadTarget({ "sec-fetch-site": "same-origin", origin: "https://evil.example" }, guestCookie().cookie);
    expect(res.status).toBe(200);
  });
});

describe("everything else passes unchanged", () => {
  it.each([["same-origin"], ["none"], [null]])("Sec-Fetch-Site: %s on a POST", async (value) => {
    const res = await callRoute(
      uploadsRoute.POST,
      request("POST", "/api/uploads", {
        cookie: guestCookie().cookie,
        json: { filename: "a.txt", mimeType: "text/plain", sizeBytes: 5 },
        headers: value === null ? {} : { "sec-fetch-site": value },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("a cross-site GET or HEAD is not refused (safe methods change nothing)", async () => {
    const anyMethod = route({ usesLlm: false, response: z.object({ ok: z.boolean() }), run: async () => ({ ok: true }) });

    const get = await callRoute(healthRoute.GET, request("GET", "/api/health", { headers: crossSite }));
    const head = await callRoute(anyMethod, request("HEAD", "/api/test", { headers: crossSite }));

    expect([get.status, head.status]).toEqual([200, 200]);
  });
});
