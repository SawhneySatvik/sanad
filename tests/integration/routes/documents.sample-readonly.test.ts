// POST /api/documents/:id/analyze refuses on a sample with 422 INVALID_DOCUMENT sample_readonly and
// no model call — and the check runs BEFORE findLatestAnalysis's early return, proven here against a
// sample that already has a persisted analysis (exactly the state every opened sample is in). If the
// guard ran after that early return instead, this test would see a 200 with the existing analysis,
// not a 422.

import { afterEach, describe, expect, it } from "vitest";
import * as analyzeRoute from "@/app/api/documents/[id]/analyze/route";
import * as sampleOpenRoute from "@/app/api/samples/[sampleId]/open/route";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function neverCalledLlm(): FakeLlmClient {
  return new FakeLlmClient({
    defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "a sample_readonly refusal must never reach the model") },
  });
}

describe("POST /api/documents/:id/analyze on a sample", () => {
  it("422 INVALID_DOCUMENT sample_readonly, no model call, even though the sample already has a persisted analysis", async () => {
    h = await createRouteHarness({ primary: neverCalledLlm(), secondary: neverCalledLlm() });
    const { cookie } = guestCookie();

    const openRes = await callRoute(sampleOpenRoute.POST, request("POST", "/api/samples/lease/open", { cookie }), {
      sampleId: "lease",
    });
    expect(openRes.status).toBe(200);
    const { documentId } = (await openRes.json()) as { documentId: string };

    const res = await callRoute(
      analyzeRoute.POST,
      request("POST", `/api/documents/${documentId}/analyze`, { cookie }),
      { id: documentId },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; reason?: string } };
    expect(body.error.code).toBe("INVALID_DOCUMENT");
    expect(body.error.reason).toBe("sample_readonly");
    expect(h.primary.callCount).toBe(0);
    expect(h.secondary.callCount).toBe(0);
  });
});
