// POST /api/documents takes the document's filename and type from what POST /api/uploads declared,
// never from its own body, and the stored filename is display-safe.

import { afterEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRelayRoute from "@/app/api/uploads/relay/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { AnalyzeDocumentOutput } from "@/shared/contracts/documents";
import { callRoute, createRouteHarness, guestCookie, LEASE_FIXTURE, readFixture, request, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

async function uploadDeclared(cookie: string, filename: string, mimeType: string, bytes: Uint8Array): Promise<string> {
  const targetRes = await callRoute(uploadsRoute.POST, request("POST", "/api/uploads", { cookie, json: { filename, mimeType, sizeBytes: bytes.byteLength } }));
  expect(targetRes.status).toBe(200);
  const target = (await targetRes.json()) as { uploadUrl: string; ref: string };
  expect((await callRoute(uploadsRelayRoute.PUT, request("PUT", target.uploadUrl, { cookie, bytes }))).status).toBe(200);
  return target.ref;
}

describe("POST /api/documents — the upload's declared filename and type", () => {
  it("a different filename and type in the body are ignored: the document keeps the declared ones", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const storageRef = await uploadDeclared(cookie, "lease.txt", "text/plain", await readFixture(LEASE_FIXTURE));
    const spoofed = `invoice${String.fromCodePoint(0x202e)}fdp.exe`;

    const res = await callRoute(
      documentsRoute.POST,
      request("POST", "/api/documents", { cookie, json: { storageRef, filename: spoofed, mimeType: "application/pdf" } }),
    );

    expect(res.status).toBe(200);
    const body = AnalyzeDocumentOutput.parse(await res.json());
    expect(body.document).toMatchObject({ filename: "lease.txt", mimeType: "text/plain", processingStatus: "ready" });
  });

  it("the declared filename is stored and echoed without its bidi and control characters", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const declared = `lease${String.fromCodePoint(0x202e)}txt.exe${String.fromCodePoint(0x0007)}.txt`;
    const storageRef = await uploadDeclared(cookie, declared, "text/plain", await readFixture(LEASE_FIXTURE));

    const res = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: { storageRef, filename: declared, mimeType: "text/plain" } }));

    expect(res.status).toBe(200);
    expect(AnalyzeDocumentOutput.parse(await res.json()).document.filename).toBe("leasetxt.exe.txt");
  });
});
