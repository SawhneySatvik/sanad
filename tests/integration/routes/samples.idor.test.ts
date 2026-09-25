// A sample-opened document is a document row like any other: a foreign principal's copy is
// NOT_FOUND, never readable, and never a 403 (which would itself confirm the id exists). Opening the
// same sample as two different principals gives each their own copy, never one another's.

import { afterEach, describe, expect, it } from "vitest";
import * as sampleOpenRoute from "@/app/api/samples/[sampleId]/open/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as analyzeRoute from "@/app/api/documents/[id]/analyze/route";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { callRoute, createRouteHarness, guestCookie, request, userA, userB, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function neverCalledLlm(): FakeLlmClient {
  return new FakeLlmClient({
    defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "the samples route must never call this") },
  });
}

function openLease(cookie?: string) {
  return callRoute(sampleOpenRoute.POST, request("POST", "/api/samples/lease/open", cookie ? { cookie } : {}), {
    sampleId: "lease",
  });
}

function getDocument(id: string, cookie?: string) {
  return callRoute(documentRoute.GET, request("GET", `/api/documents/${id}`, cookie ? { cookie } : {}), { id });
}

describe("samples idor", () => {
  it("a foreign signed-in principal cannot read another user's sample copy", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    h.signIn(userA);
    const openRes = await openLease();
    expect(openRes.status).toBe(200);
    const { documentId } = (await openRes.json()) as { documentId: string };

    h.signIn(userB);
    const res = await getDocument(documentId);
    expect(res.status).toBe(404);
  });

  it("a foreign guest cannot read another guest's sample copy", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const owner = guestCookie();
    const openRes = await openLease(owner.cookie);
    const { documentId } = (await openRes.json()) as { documentId: string };

    const stranger = guestCookie();
    const res = await getDocument(documentId, stranger.cookie);
    expect(res.status).toBe(404);
  });

  it("two principals opening the same sample each get their own copy, never each other's id", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    h.signIn(userA);
    const first = (await (await openLease()).json()) as { documentId: string };

    h.signIn(userB);
    const second = (await (await openLease()).json()) as { documentId: string };

    expect(second.documentId).not.toBe(first.documentId);
    // Each is readable only by its own owner.
    expect((await getDocument(first.documentId)).status).toBe(404);
    h.signIn(userA);
    expect((await getDocument(first.documentId)).status).toBe(200);
  });

  it("a foreign principal's POST …/analyze on someone else's sample copy is 404, never 422 sample_readonly — a 422 would confirm the id exists", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    h.signIn(userA);
    const { documentId } = (await (await openLease()).json()) as { documentId: string };

    h.signIn(userB);
    const res = await callRoute(analyzeRoute.POST, request("POST", `/api/documents/${documentId}/analyze`), { id: documentId });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.reason).toBeUndefined();
  });

  it("an unknown sample id, the deferred Compare sample, and a foreign principal's real sample copy all return byte-identical 404 bodies", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    h.signIn(userA);
    const { documentId } = (await (await openLease()).json()) as { documentId: string };

    const unknownBody = await callRoute(sampleOpenRoute.POST, request("POST", "/api/samples/no-such-sample/open"), {
      sampleId: "no-such-sample",
    });
    const deferredBody = await callRoute(sampleOpenRoute.POST, request("POST", "/api/samples/lease_v2/open"), {
      sampleId: "lease_v2",
    });
    h.signIn(userB);
    const foreignBody = await getDocument(documentId);

    expect(unknownBody.status).toBe(404);
    expect(deferredBody.status).toBe(404);
    expect(foreignBody.status).toBe(404);
    const [unknownJson, deferredJson, foreignJson] = await Promise.all([unknownBody.json(), deferredBody.json(), foreignBody.json()]);
    // No correlation id or other per-request field lives in the JSON body (it's header-only), so
    // three genuinely different refusal reasons must still produce byte-identical bodies.
    expect(deferredJson).toEqual(unknownJson);
    expect(foreignJson).toEqual(unknownJson);
  });
});
