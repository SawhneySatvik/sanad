// POST /api/documents/:id/prepare — over real PGlite + FakeLlmClients, through the actual route
// handler (CLAUDE.md's mocking policy). The three typed states stay distinct.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as prepareRoute from "@/app/api/documents/[id]/prepare/route";
import { extractDocument } from "@/server/deterministic/extract";
import { AppError } from "@/server/core/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LEASE, lensExplanationsFor } from "@tests/support/services/understand";
import type { PrepareOutput } from "@/shared/contracts/prepare";
import {
  analyzedDocumentViaRoutes,
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  TEST_MODEL_ID,
  unavailable,
  uploadViaRoutes,
  type RouteHarness,
} from "./harness";

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function callPrepare(documentId: string, cookie: string | null, query = "") {
  return callRoute(prepareRoute.POST, request("POST", `/api/documents/${documentId}/prepare${query}`, { cookie }), { id: documentId });
}

// Eligible findings (not_found excluded, everything else offered) get short aliases F1, F2, … in
// the SAME order Understand returned them. leaseOutput's fabricated finding is skipped, so its
// missing_clause finding (the last one) becomes the highest alias.
const LICENSE_FEE_ALIAS = "F1";

describe("POST /api/documents/:id/prepare", () => {
  it("complete: every item is grounded in a real finding, and a verified item's spanText is the canonical slice of the document", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentId = await analyzedDocumentViaRoutes(cookie);

    h.primary.enqueue({
      data: {
        lawyerQuestions: [
          { question: "Is the license fee negotiable?", whyItMatters: "It is your biggest recurring cost.", findingIds: [LICENSE_FEE_ALIAS] },
        ],
        checklist: [{ item: "Confirm the monthly license fee before signing.", findingIds: [LICENSE_FEE_ALIAS] }],
      },
    });

    const res = await callPrepare(documentId, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PrepareOutput;
    expect(body.state).toBe("complete");
    if (body.state !== "complete") return;
    expect(body.documentId).toBe(documentId);
    expect(body.modelUsed).toBe(TEST_MODEL_ID);
    expect(body.lawyerQuestions).toHaveLength(1);
    expect(body.checklist).toHaveLength(1);
    expect(typeof body.markdown).toBe("string");
    expect(body.markdown).toContain("AI-suggested question:");

    // The response echoes the lens the output was written for — the document's type's first lens,
    // since no ?lens= was sent — and the contract strips its internal-only description field.
    expect(body.lens).toEqual({ id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" });
    expect("description" in body.lens).toBe(false);
    expect(body.markdown).toContain("Prepared for: Tenant, before signing");

    const finding = body.lawyerQuestions[0].findings[0];
    expect(finding.category).toBe("obligation");
    expect(finding.verification?.status).toBe("verified");
    const fixturePath = path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt");
    const canonical = await extractDocument({ pastedText: await readFile(fixturePath, "utf8") });
    if (canonical.kind !== "extracted") throw new Error("fixture did not extract");
    const v = finding.verification;
    if (v?.status === "verified" && v.spanStart !== null && v.spanEnd !== null) {
      expect(v.spanText).toBe(canonical.canonicalText.slice(v.spanStart, v.spanEnd));
      expect(v.spanText).toBe(LEASE.licenseFee);
    }
  });

  it("?lens= picks the reader: the prompt carries that lens's explanations and the response and Markdown name it", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentId = await analyzedDocumentViaRoutes(cookie);
    h.primary.enqueue({
      data: {
        lawyerQuestions: [{ question: "Can the deposit be withheld?", whyItMatters: "It is your money.", findingIds: [LICENSE_FEE_ALIAS] }],
        checklist: [{ item: "Collect the move-out inspection report.", findingIds: [LICENSE_FEE_ALIAS] }],
      },
    });
    const callsBefore = h.primary.calls.length;

    const res = await callPrepare(documentId, cookie, "?lens=tenant_already_signed");

    expect(res.status).toBe(200);
    const body = (await res.json()) as PrepareOutput;
    if (body.state !== "complete") throw new Error(`expected complete, got ${body.state}`);
    expect(body.lens).toEqual({ id: "tenant_already_signed", role: "tenant", stage: "already_signed" });
    expect(body.markdown).toContain("Prepared for: Tenant, already signed");
    const prompt = h.primary.calls[callsBefore].userPrompt;
    expect(prompt).toContain("as seen by tenant_already_signed");
    expect(prompt).not.toContain("as seen by tenant_about_to_sign");
  });

  it("?lens= naming no lens, or a lens of another document type, is 400 with no model call", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentId = await analyzedDocumentViaRoutes(cookie);
    const callsBefore = h.primary.calls.length;

    const unknown = await callPrepare(documentId, cookie, "?lens=not_a_lens");
    const otherType = await callPrepare(documentId, cookie, "?lens=employee_about_to_sign");

    expect(unknown.status).toBe(400);
    expect(otherType.status).toBe(400);
    expect(h.primary.calls.length).toBe(callsBefore);
  });

  it("not_analyzed: a document with no completed analysis answers state: not_analyzed, no lawyerQuestions/checklist key at all", async () => {
    h = await createRouteHarness({
      primary: new FakeLlmClient({
        modelUsed: TEST_MODEL_ID,
        responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "primary down") }],
      }),
      secondary: unavailable(),
    });
    const cookie = guestCookie().cookie;
    const input = await uploadViaRoutes(cookie);
    const failed = await callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
    expect(failed.status).toBe(503);
    const { documentId } = ((await failed.json()) as { error: { documentId: string } }).error;

    const res = await callPrepare(documentId, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PrepareOutput;
    expect(body).toEqual({ state: "not_analyzed", documentId });
    expect("lawyerQuestions" in body).toBe(false);
    expect("markdown" in body).toBe(false);
  });

  // Eligible findings WERE offered, but the model's response grounded to none of them (every alias
  // it returned is unknown) — prepare.ts throws SCHEMA_FAILED, which core/errors.ts maps to 502.
  it("a model response that grounds to nothing usable is SCHEMA_FAILED -> 502 at the route", async () => {
    h = await createRouteHarness();
    const cookie = guestCookie().cookie;
    const documentId = await analyzedDocumentViaRoutes(cookie);

    h.primary.enqueue({
      data: {
        lawyerQuestions: [{ question: "Is the fee negotiable?", whyItMatters: "It matters.", findingIds: ["F99"] }],
        checklist: [{ item: "Confirm the fee.", findingIds: ["F99"] }],
      },
    });

    const res = await callPrepare(documentId, cookie);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "SCHEMA_FAILED", message: "The response from an upstream service was malformed." },
    });
  });

  it("no_grounded_findings: every finding is not_found — nothing eligible to offer the model, no model call made", async () => {
    // A generic document has no standard-clause checklist, so the model's finding is the only one.
    const fabricated = { category: "obligation", quote: LEASE.fabricated, lensExplanations: lensExplanationsFor("generic", "A fee nowhere in this document") };
    h = await createRouteHarness({
      primary: new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: { findings: [fabricated] } } }),
    });
    const cookie = guestCookie().cookie;
    const documentId = await analyzedDocumentViaRoutes(cookie, "generic.txt");
    const callsBefore = h.primary.callCount;

    const res = await callPrepare(documentId, cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PrepareOutput;
    expect(body).toEqual({ state: "no_grounded_findings", documentId });
    // No LLM call for this state (prepare.ts: nothing eligible to offer the model at all).
    expect(h.primary.callCount).toBe(callsBefore);
  });
});
