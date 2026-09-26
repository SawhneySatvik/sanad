// The Prepare screen's own capture states.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { StateRegistry, CaptureContext } from "../types";
import { registerScript, setFakeProviderDown } from "../../fake-provider/client";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "documents");

const ABOUT_TO_SIGN_MATCH = "This reader has not signed yet";
const ALREADY_SIGNED_MATCH = "This reader has already signed and is bound";

async function openLeaseSample(ctx: CaptureContext): Promise<string> {
  const response = await ctx.context.request.post(`${ctx.baseUrl}/api/samples/lease/open`);
  const body = (await response.json()) as { documentId: string };
  return body.documentId;
}

async function registerPrepareScripts(): Promise<void> {
  await registerScript({
    id: "capture-prepare-about-to-sign",
    match: ABOUT_TO_SIGN_MATCH,
    chunks: [
      JSON.stringify({
        lawyerQuestions: [{ question: "What is the notice period before signing?", whyItMatters: "It affects how quickly you can leave.", findingIds: ["F1"] }],
        checklist: [{ item: "Confirm the notice period with the landlord before signing.", findingIds: ["F1"] }],
      }),
    ],
  });
  await registerScript({
    id: "capture-prepare-already-signed",
    match: ALREADY_SIGNED_MATCH,
    chunks: [
      JSON.stringify({
        lawyerQuestions: [{ question: "What is my notice period now that I have signed?", whyItMatters: "It affects your rights going forward.", findingIds: ["F1"] }],
        checklist: [{ item: "Gather proof of the notice period you already agreed to.", findingIds: ["F1"] }],
      }),
    ],
  });
}

interface UploadTarget {
  uploadUrl: string;
  ref: string;
}

// The 3-step upload flow (POST /api/uploads -> PUT the relay -> POST /api/documents), driven
// directly rather than through the composer's own UI.
async function uploadFixture(ctx: CaptureContext, filename: string, mimeType: string): Promise<{ documentId?: string }> {
  const bytes = readFileSync(path.join(FIXTURES, filename));
  const targetResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/uploads`, {
    data: { filename, mimeType, sizeBytes: bytes.byteLength },
  });
  const target = (await targetResponse.json()) as UploadTarget;
  await ctx.context.request.put(new URL(target.uploadUrl, ctx.baseUrl).toString(), { data: bytes });
  const confirmResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/documents`, {
    data: { storageRef: target.ref, filename, mimeType },
  });
  const body = (await confirmResponse.json()) as { document?: { id: string }; error?: { documentId?: string } };
  return { documentId: body.document?.id ?? body.error?.documentId };
}

export const states: StateRegistry = {
  default: {
    route: "/documents/__pending__/prepare",
    setup: async (ctx) => {
      await registerPrepareScripts();
      const id = await openLeaseSample(ctx);
      states.default.route = `/documents/${id}/prepare`;
    },
  },

  // No response is ever registered for either lens-stage match, so the request never resolves and
  // the capture lands on the loading pulse.
  loading: {
    route: "/documents/__pending__/prepare",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states.loading.route = `/documents/${id}/prepare`;
    },
    ready: async (ctx) => {
      await ctx.page.getByText("Preparing your questions…").waitFor({ timeout: 5000 });
    },
  },

  // The provider is unreachable, so the row is created but analysis fails — analysisState stays
  // "not_analyzed", processingStatus "ready", with no live schema needed at all.
  "not-analysed": {
    route: "/documents/__pending__/prepare",
    setup: async (ctx) => {
      await setFakeProviderDown(true);
      const { documentId } = await uploadFixture(ctx, "leave_and_license.pdf", "application/pdf");
      await setFakeProviderDown(false);
      states["not-analysed"].route = `/documents/${documentId}/prepare`;
    },
  },

  // A finding whose quote never appears in the uploaded text comes back not_found, which Prepare's
  // own eligibility rule excludes — no missing_clause entries either, so nothing is eligible and
  // generate() answers no_grounded_findings without ever calling the model itself.
  "no-grounded-findings": {
    route: "/documents/__pending__/prepare",
    setup: async (ctx) => {
      await registerScript({
        id: "capture-no-grounded-findings-analyze",
        match: "You help people in India understand legal documents",
        chunks: [
          JSON.stringify({
            findings: [
              {
                category: "ambiguity",
                quote: "a clause this document does not actually contain",
                lensExplanations: {
                  party_about_to_sign: "This wording is unclear before signing.",
                  party_already_signed: "This wording is unclear now that you have signed.",
                },
              },
            ],
          }),
        ],
      });
      const { documentId } = await uploadFixture(ctx, "generic.txt", "text/plain");
      states["no-grounded-findings"].route = `/documents/${documentId}/prepare`;
    },
  },

  error: {
    route: "/documents/00000000-0000-4000-8000-000000000000/prepare",
    expectStatus: (status) => status === 404 || status < 400,
  },
};
