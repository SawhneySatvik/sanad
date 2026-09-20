// Who can write through the upload relay (docs/API.md PUT /api/uploads/relay): only a
// principal holding a token this server signed, still valid, for a ref in their own namespace.
// Every other request — forged, expired, wrong-ref, garbage — is the same 404, and writes nothing.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { relayUploadUrl } from "@/server/http/uploads";
import { signLocalUrl } from "@/server/storage/signed-url";
import { UploadTargetOutput } from "@/shared/contracts/uploads";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  SIGNING_SECRET,
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

async function mintTarget(cookie: string | null) {
  const res = await callRoute(
    uploadsRoute.POST,
    request("POST", "/api/uploads", { cookie, json: { filename: "lease.txt", mimeType: "text/plain", sizeBytes: 50 } }),
  );
  return UploadTargetOutput.parse(await res.json());
}

function relay(cookie: string | null, uploadUrl: string, bytes: Uint8Array) {
  return callRoute(uploadsRelayRoute.PUT, request("PUT", uploadUrl, { cookie, bytes }));
}

function withToken(token: string): string {
  return `/api/uploads/relay?token=${encodeURIComponent(token)}`;
}

// The signed local-storage URL inside an uploadUrl, as a URL whose parameters can be edited.
function tokenOf(uploadUrl: string): URL {
  return new URL(new URL(uploadUrl, "http://localhost").searchParams.get("token") ?? "");
}

async function nothingAt(ref: string): Promise<void> {
  await expect(h.storage.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
}

describe("PUT /api/uploads/relay", () => {
  it("guest: another guest's valid token is 404, and writes nothing; the owner's write then succeeds", async () => {
    const owner = guestCookie();
    const { ref, uploadUrl } = await mintTarget(owner.cookie);

    const foreign = await relay(guestCookie().cookie, uploadUrl, Buffer.from("attacker bytes"));

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } });
    await nothingAt(ref);
    expect((await relay(owner.cookie, uploadUrl, Buffer.from("owner bytes"))).status).toBe(200);
    expect((await h.storage.readObject(ref)).toString()).toBe("owner bytes");
  });

  it("user: user B cannot use user A's token; user A can", async () => {
    h.signIn(userA);
    const { ref, uploadUrl } = await mintTarget(null);

    h.signIn(userB);
    expect((await relay(null, uploadUrl, Buffer.from("attacker bytes"))).status).toBe(404);
    await nothingAt(ref);

    h.signIn(userA);
    expect((await relay(null, uploadUrl, Buffer.from("owner bytes"))).status).toBe(200);
  });

  it("every token this server did not sign, or that is no longer valid, is the same 404 and writes nothing — even for the caller's own refs", async () => {
    const { cookie, guestSessionId } = guestCookie();
    const { ref, uploadUrl } = await mintTarget(cookie);
    const neverMinted = `guest:${guestSessionId}/${randomUUID()}/lease.txt`;

    const unsigned = tokenOf(uploadUrl);
    unsigned.searchParams.delete("sig");
    const movedSignature = tokenOf(uploadUrl);
    movedSignature.searchParams.set("ref", neverMinted);
    const forged = tokenOf(uploadUrl);
    forged.searchParams.set("ref", neverMinted);
    forged.searchParams.set("sig", "0".repeat(64));
    const extended = tokenOf(uploadUrl);
    extended.searchParams.set("expires", String(Date.now() + 24 * 60 * 60 * 1000));

    const attempts: [string, string][] = [
      ["unsigned", withToken(unsigned.toString())],
      ["expired", relayUploadUrl(ref, Date.now() - 1000)],
      ["a signature moved onto a never-minted ref", withToken(movedSignature.toString())],
      ["a forged signature for a never-minted ref", withToken(forged.toString())],
      ["an expiry pushed out past its signature", withToken(extended.toString())],
      // A download URL is signed over (ref, expiry) with the same function but the raw secret; the
      // relay's key is derived for uploads only, so one never passes as the other.
      ["a storage download URL", withToken(signLocalUrl(SIGNING_SECRET, ref, Date.now() + 60_000))],
      ["garbage", withToken("not a token at all")],
    ];
    const expected = [404, JSON.stringify({ error: { code: "NOT_FOUND", message: "The requested resource could not be found." } })];
    for (const [label, url] of attempts) {
      const res = await relay(cookie, url, Buffer.from(`bytes for ${label}`));
      expect([label, res.status, await res.text()]).toEqual([label, ...expected]);
    }
    await nothingAt(ref);
    await nothingAt(neverMinted);

    // Positive control: the genuine uploadUrl still works — nothing above consumed it.
    expect((await relay(cookie, uploadUrl, Buffer.from("genuine"))).status).toBe(200);
  });

  it("the old unsigned ?ref= form is refused outright (400: not the relay's query shape)", async () => {
    const { cookie } = guestCookie();
    const { ref } = await mintTarget(cookie);

    const res = await relay(cookie, `/api/uploads/relay?ref=${encodeURIComponent(ref)}`, Buffer.from("x"));

    expect(res.status).toBe(400);
    await nothingAt(ref);
  });
});
