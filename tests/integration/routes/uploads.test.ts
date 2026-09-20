// POST /api/uploads and PUT /api/uploads/relay — the local server-relay upload flow
// (docs/ARCHITECTURE.md's Storage adapter section) through the real route handlers and storage adapter.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { MAX_RELAY_UPLOAD_BYTES } from "@/server/http/uploads";
import { UploadTargetOutput } from "@/shared/contracts/uploads";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  mintedCookie,
  readFixture,
  request,
  sessionCookieOf,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
});
afterEach(async () => {
  await h.close();
});

function createTarget(cookie: string | null, json: unknown) {
  return callRoute(uploadsRoute.POST, request("POST", "/api/uploads", { cookie, json }));
}

function relay(cookie: string | null, pathAndQuery: string, bytes: Uint8Array, headers?: Record<string, string>) {
  return callRoute(uploadsRelayRoute.PUT, request("PUT", pathAndQuery, { cookie, bytes, headers }));
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("POST /api/uploads", () => {
  it("mints a server-relay target in the caller's namespace, pointing at the relay route", async () => {
    const { cookie, guestSessionId } = guestCookie();

    const res = await createTarget(cookie, { filename: "lease.txt", mimeType: "text/plain", sizeBytes: 1200 });

    expect(res.status).toBe(200);
    const target = UploadTargetOutput.parse(await res.json());
    expect(target.method).toBe("server-relay");
    expect(target.ref).toMatch(new RegExp(`^guest:${guestSessionId}/[0-9a-f-]{36}/lease\\.txt$`));
    // A signed, expiring token for exactly this ref — not the bare ref.
    const url = new URL(target.uploadUrl, "http://localhost");
    expect(url.pathname).toBe("/api/uploads/relay");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
    const token = new URL(url.searchParams.get("token") ?? "");
    expect(token.searchParams.get("ref")).toBe(target.ref);
    expect(token.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
    const expiresInMs = Number(token.searchParams.get("expires")) - Date.now();
    expect(expiresInMs).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresInMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(mintedCookie(res)).toBeNull();
  });

  it("a first request with no session mints one, and the target is in that new session's namespace", async () => {
    const res = await createTarget(null, { filename: "lease.txt", mimeType: "text/plain", sizeBytes: 10 });

    expect(res.status).toBe(200);
    const guestSessionId = sessionCookieOf(res).split("=")[1].split(".")[0];
    expect(UploadTargetOutput.parse(await res.json()).ref.startsWith(`guest:${guestSessionId}/`)).toBe(true);
  });

  it.each([
    ["a disallowed type", { filename: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }],
    ["a size over the cap", { filename: "x.pdf", mimeType: "application/pdf", sizeBytes: MAX_RELAY_UPLOAD_BYTES + 1 }],
  ])("rejects %s with the storage policy's 422", async (_label, json) => {
    const res = await createTarget(guestCookie().cookie, json);

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("INVALID_DOCUMENT");
  });

  it.each([
    ["an unknown field", { filename: "a.txt", mimeType: "text/plain", sizeBytes: 10, ref: "guest:x/y/z" }],
    ["a non-integer size", { filename: "a.txt", mimeType: "text/plain", sizeBytes: 1.5 }],
    ["an empty filename", { filename: "", mimeType: "text/plain", sizeBytes: 10 }],
  ])("rejects %s with a 400", async (_label, json) => {
    const res = await createTarget(guestCookie().cookie, json);

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION_FAILED");
  });
});

describe("PUT /api/uploads/relay", () => {
  async function target(cookie: string, sizeBytes = 100) {
    const res = await createTarget(cookie, { filename: "lease.txt", mimeType: "text/plain", sizeBytes });
    return UploadTargetOutput.parse(await res.json());
  }

  it("writes exactly the bytes sent to the minted ref", async () => {
    const { cookie } = guestCookie();
    const bytes = await readFixture("leave_and_license.txt");
    const { ref, uploadUrl } = await target(cookie, bytes.byteLength);

    const res = await relay(cookie, uploadUrl, bytes);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ref });
    expect((await h.storage.readObject(ref)).equals(bytes)).toBe(true);
  });

  it("a second write to the same ref is refused and the first bytes stay", async () => {
    const { cookie } = guestCookie();
    const { ref, uploadUrl } = await target(cookie);
    await relay(cookie, uploadUrl, Buffer.from("first"));

    const res = await relay(cookie, uploadUrl, Buffer.from("second"));

    expect(res.status).toBe(400);
    expect((await h.storage.readObject(ref)).toString()).toBe("first");
  });

  it("rejects a declared Content-Length over the cap before reading the body", async () => {
    const { cookie } = guestCookie();
    const { ref, uploadUrl } = await target(cookie);

    const res = await relay(cookie, uploadUrl, Buffer.from("small"), {
      "content-length": String(MAX_RELAY_UPLOAD_BYTES + 1),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT", reason: "too_large" } });
    await expect(h.storage.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a body that streams past the cap with no Content-Length", async () => {
    const { cookie } = guestCookie();
    const { ref, uploadUrl } = await target(cookie);
    const oversized = new Uint8Array(MAX_RELAY_UPLOAD_BYTES + 1);
    const req = request("PUT", uploadUrl, { cookie, bytes: oversized });
    expect(req.headers.get("content-length")).toBeNull();

    const res = await callRoute(uploadsRelayRoute.PUT, req);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT", reason: "too_large" } });
    await expect(h.storage.readObject(ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects an empty body with the storage policy's 422/empty — a real zero-byte relay past a positive declared size", async () => {
    const { cookie } = guestCookie();
    const { uploadUrl } = await target(cookie, 10); // declared size is positive; the actual write is 0 bytes

    const res = await relay(cookie, uploadUrl, new Uint8Array(0));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_DOCUMENT", reason: "empty" } });
  });

  it("rejects a missing or unknown query parameter with a 400", async () => {
    const { cookie } = guestCookie();
    const { uploadUrl } = await target(cookie);

    const statuses = [
      (await relay(cookie, "/api/uploads/relay", Buffer.from("x"))).status,
      (await relay(cookie, `${uploadUrl}&extra=1`, Buffer.from("x"))).status,
    ];

    expect(statuses).toEqual([400, 400]);
  });
});
