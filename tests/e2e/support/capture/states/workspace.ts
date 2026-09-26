// The analysis workspace's own capture states. Every state that only needs the lease sample (no
// live model call) is high-confidence; the two that need a real analysis of a non-sample document
// (generic, scanned) register a best-effort fake-provider script inferred from the recorded-sample
// shape (RecordedUnderstandOutput in src/server/samples/registry.ts) rather than a confirmed live
// schema fixture — flagged inline as best-effort, for whoever next checks it against a live schema
// to correct if the shape is off.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { StateRegistry, CaptureContext } from "../types";
import { registerScript, setFakeProviderDown, waitForHeldRequest } from "../../fake-provider/client";

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "documents");

async function openLeaseSample(ctx: CaptureContext): Promise<string> {
  const response = await ctx.context.request.post(`${ctx.baseUrl}/api/samples/lease/open`);
  const body = (await response.json()) as { documentId: string };
  return body.documentId;
}

interface UploadTarget {
  method: string;
  uploadUrl: string;
  ref: string;
}

/** The 3-step upload flow (POST /api/uploads -> PUT the relay -> POST /api/documents), driven directly rather than through the composer's own UI. */
async function uploadFixture(ctx: CaptureContext, filename: string, mimeType: string): Promise<{ documentId?: string; failed: boolean }> {
  const bytes = readFileSync(path.join(FIXTURES, filename));
  const targetResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/uploads`, {
    data: { filename, mimeType, sizeBytes: bytes.byteLength },
  });
  const target = (await targetResponse.json()) as UploadTarget;
  await ctx.context.request.put(new URL(target.uploadUrl, ctx.baseUrl).toString(), { data: bytes });
  const confirmResponse = await ctx.context.request.post(`${ctx.baseUrl}/api/documents`, {
    data: { storageRef: target.ref, filename, mimeType },
  });
  if (!confirmResponse.ok()) {
    const body = (await confirmResponse.json()) as { error?: { documentId?: string } };
    return { documentId: body.error?.documentId, failed: true };
  }
  const body = (await confirmResponse.json()) as { document: { id: string } };
  return { documentId: body.document.id, failed: false };
}

export const states: StateRegistry = {
  default: {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states.default.route = `/documents/${id}`;
    },
  },

  // The URL's own ?lens= carries the switch, read server-side by page.tsx — no interactive click
  // needed for a static capture, and no network call either (the lens switch itself is zero-network).
  "lens-switched": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["lens-switched"].route = `/documents/${id}?lens=landlord_about_to_sign`;
    },
  },

  // No verify-batch mock in either state below — a route.fulfill() that always answers
  // "approximate" regardless of the typed text proved nothing about the real verifier and is
  // exactly the "quirk" that made a wholly-absent quote look downgraded rather than not_found (see
  // this ticket's own investigation note). Both states open "Test this quote" and let the real
  // POST /api/verify-batch answer for whatever text is actually typed.
  "verifier-downgraded": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["verifier-downgraded"].route = `/documents/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      // Findings (and "Test this quote") live inside the phone BottomSheet, never the base view —
      // open it first on that one viewport.
      if ((ctx.page.viewportSize()?.width ?? 0) < 1024) {
        await ctx.page.getByRole("button", { name: /^\d+ findings?$/ }).click();
        await ctx.page.getByRole("dialog").waitFor();
      }
      const card = ctx.page.locator("article[data-finding-category]").first();
      await card.getByRole("button", { name: "Test this quote" }).click();
      const field = ctx.page.getByLabel("Test this quote");
      const demo = field.locator("..");
      // The seeded first check (initialText, VerifierDemo's own mount-time debounce) shows this
      // card's real, already-verified status before the edit below lands — waited past explicitly,
      // so the "approximate" wait right after fill() can't pass on that stale earlier result.
      await demo.locator('[data-verification-status]').first().waitFor({ timeout: 5000 });
      // A verified quote (clause 4.1's own License Fee sentence) with one figure changed —
      // 32,000 -> 35,000 is a single-token edit against ~30 tokens of otherwise-identical text, well
      // under the approximate matcher's edit budget, so the real verifier genuinely downgrades this
      // rather than a mock asserting it.
      await field.fill(
        "The Licensee shall pay to the Licensor a monthly License Fee of Rs. 35,000/- (Rupees Thirty-Two Thousand only) for the use of the Licensed Premises.",
      );
      // Scoped to this demo's own container, not the page: the lease sample already has plenty of
      // naturally verified/approximate findings elsewhere in FindingsPane.
      await demo.locator('[data-verification-status="approximate"]').waitFor({ timeout: 5000 });
    },
  },

  "verifier-not-found": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["verifier-not-found"].route = `/documents/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      if ((ctx.page.viewportSize()?.width ?? 0) < 1024) {
        await ctx.page.getByRole("button", { name: /^\d+ findings?$/ }).click();
        await ctx.page.getByRole("dialog").waitFor();
      }
      const card = ctx.page.locator("article[data-finding-category]").first();
      await card.getByRole("button", { name: "Test this quote" }).click();
      const field = ctx.page.getByLabel("Test this quote");
      const demo = field.locator("..");
      await demo.locator('[data-verification-status]').first().waitFor({ timeout: 5000 });
      // A sentence with no real overlap against the lease's own vocabulary at all — genuinely
      // absent, not merely reworded.
      await field.fill("The submarine's periscope malfunctioned during the lunar eclipse ceremony.");
      await demo.locator('[data-verification-status="not_found"]').waitFor({ timeout: 5000 });
    },
  },

  "not-analysed": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      // No live schema needed at all: the provider is simply unreachable, so the row is created but
      // analysis fails — analysisState stays "not_analyzed", processingStatus "ready".
      await setFakeProviderDown(true);
      const { documentId } = await uploadFixture(ctx, "leave_and_license.pdf", "application/pdf");
      await setFakeProviderDown(false);
      states["not-analysed"].route = `/documents/${documentId}`;
    },
  },

  "extraction-failed": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      // corrupt.pdf fails at extraction, before any model call — no fake-provider script needed.
      const { documentId } = await uploadFixture(ctx, "corrupt.pdf", "application/pdf");
      states["extraction-failed"].route = `/documents/${documentId}`;
    },
  },

  // The findings-extraction call's system prompt (src/server/prompts/understand/analyze.ts's
  // buildUnderstandSystemPrompt) always opens with this exact sentence, for every document type —
  // matched confirmed against the real prompt source, not inferred from the recorded-sample shape.
  // A real, quoted finding (never an empty array — a page with zero findings has no LensToggle
  // either, since there's no lens set to switch between yet, so the shot would never show the
  // generic document's own "Signer" lenses or a verified badge) that quotes generic.txt's own real
  // text verbatim, with the shared party_* lenses every generic-typed finding needs.
  generic: {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const quote = "Members water the raised beds on their assigned mornings before nine o'clock.";
      await registerScript({
        id: `generic-${randomUUID()}`,
        match: "You help people in India understand legal documents",
        chunks: [
          JSON.stringify({
            findings: [
              {
                category: "obligation",
                quote,
                lensExplanations: {
                  party_about_to_sign: "Before signing, note you'll need to water the beds on your assigned mornings.",
                  party_already_signed: "Having signed, water the beds on your assigned mornings before 9am.",
                },
              },
            ],
          }),
        ],
      });
      const { documentId } = await uploadFixture(ctx, "generic.txt", "text/plain");
      states.generic.route = `/documents/${documentId}`;
    },
  },

  // Two real model calls, in order (src/server/services/understand.ts's extract() then
  // runAnalysis()): transcription first, then findings extraction over the transcribed text. Each
  // script's `match` is the one fixed sentence that opens its own call's system prompt
  // (TRANSCRIBE_SYSTEM_PROMPT / buildUnderstandSystemPrompt) and no other — an empty match string
  // (this state's earlier, unconfirmed version) matches every request, so the fake provider's
  // first-registered-wins lookup would answer the findings call with the transcription script's own
  // `{"text": …}` body instead, which findings-extraction's schema can't parse as `{"findings": […]}`.
  // The finding's own quote is verbatim in the transcribed text and real enough to demonstrate the
  // native_document verification cap rather than an empty findings array, which proves nothing
  // about the cap since it has no badges of any status to begin with.
  scanned: {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const nonce = randomUUID();
      const transcribedText = "This is a transcribed scanned lease document with a monthly rent of Rs. 20,000.";
      await registerScript({
        id: `scanned-transcribe-${nonce}`,
        match: "You transcribe scanned legal documents",
        chunks: [JSON.stringify({ text: transcribedText })],
      });
      await registerScript({
        id: `scanned-findings-${nonce}`,
        match: "You help people in India understand legal documents",
        chunks: [
          JSON.stringify({
            findings: [
              {
                category: "obligation",
                quote: transcribedText,
                lensExplanations: {
                  party_about_to_sign: "Before signing, note the monthly rent of Rs. 20,000.",
                  party_already_signed: "Having signed, the monthly rent of Rs. 20,000 is now owed.",
                },
              },
            ],
          }),
        ],
      });
      const { documentId } = await uploadFixture(ctx, "scanned_no_text_layer.pdf", "application/pdf");
      states.scanned.route = `/documents/${documentId}`;
    },
  },

  // A `lease`-sample finding's "Show in document" click, so the core finding-to-span interaction
  // (verified highlight + scroll + pulse) is visible without breaking the default state's own
  // no-pre-selection rule — every quote in the lease sample's own text starts well past the
  // preamble the "default" state's screenshot happens to show, so a resting, unselected capture can
  // legitimately show no visible mark in view at all.
  "finding-selected": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["finding-selected"].route = `/documents/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      // Findings live inside the phone BottomSheet, never the base view — open it first on that
      // one viewport; the click below then closes it again on its own (Phone layout's own rule).
      if ((ctx.page.viewportSize()?.width ?? 0) < 1024) {
        await ctx.page.getByRole("button", { name: /^\d+ findings?$/ }).click();
        await ctx.page.getByRole("dialog").waitFor();
      }
      await ctx.page
        .getByRole("button", { name: /^Show .+ in document$/ })
        .first()
        .click();
      await ctx.page.locator("mark[data-active]").waitFor({ timeout: 5000 });
      // The pulse (`active`) is a one-shot ~480ms flash; this capture is about the PERSISTENT
      // "current" selected style that outlives it, not the flash itself — waited well past
      // PULSE_HOLD_MS so the screenshot lands on the settled state.
      await ctx.page.waitForTimeout(800);
    },
  },

  "phone-findings-sheet": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["phone-findings-sheet"].route = `/documents/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      // This state is phone-only by nature (the sheet doesn't exist on desktop, where
      // FindingsPane already sits in the right pane) — every state still runs at every viewport,
      // so desktop simply leaves the default workspace on screen rather than clicking anything.
      if ((ctx.page.viewportSize()?.width ?? 0) < 1024) {
        // The phone trigger row is one segmented handle now (workspace-client.tsx), not a
        // "Findings (N)"-labelled button — its accessible name is "16 findings", anchored at the
        // start so it can never match a FindingGroup's own "Obligation, 16 findings" aria-label,
        // which merely ends the same way.
        await ctx.page.getByRole("button", { name: /^\d+ findings?$/ }).click();
        await ctx.page.getByRole("dialog").waitFor();
        // waitFor's "visible" state is satisfied the instant the sheet starts its 260ms slide-in
        // (ui/sheet.tsx) — without this, the screenshot lands mid-animation, half off-screen.
        await ctx.page.waitForTimeout(350);
      }
    },
  },

  // Holds the stream mid-answer and does NOT release it, so the screenshot lands on the held
  // frame (matching every other mid-stream capture's own convention in this harness).
  "ask-streaming": {
    route: "/documents/__pending__",
    setup: async (ctx) => {
      const id = await openLeaseSample(ctx);
      states["ask-streaming"].route = `/documents/${id}`;
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      // On phone, AskPanel (and its message list) only ever mounts inside the sheet's own Ask tab —
      // the base view's composer shares the same conversation state but has nowhere to show a
      // streamed reply. Open the sheet to Ask first, so what's typed next actually has somewhere to
      // land; on desktop this is a no-op past the width check.
      if ((ctx.page.viewportSize()?.width ?? 0) < 1024) {
        await ctx.page.getByRole("button", { name: "Ask" }).click();
        await ctx.page.getByRole("dialog").waitFor();
        await ctx.page.getByRole("tab", { name: "Ask" }).click();
      }
      // Matched by the tenancy specialist's own fixed system-prompt opening line
      // (src/server/prompts/orchestrator/specialists.ts) — classify() is deterministic and this
      // document/query pair always dispatches exactly that one specialist, so no nonce is needed to
      // disambiguate the call, and the composer never has to show a random id to the reader.
      await registerScript({
        id: "ask-streaming-tenancy",
        match: "You are the tenancy law specialist inside an Indian legal-assistant chat.",
        chunks: ['{"answer":"This clause means ', 'you owe rent monthly.","citations":[]}'],
        holdAfterChunk: 1,
      });
      await ctx.page.getByLabel("Ask about this document…").fill("What does this lease require of me?");
      await ctx.page.getByRole("button", { name: "Send" }).click();
      await waitForHeldRequest("ask-streaming-tenancy");
      await ctx.page.getByText("This clause means").waitFor({ timeout: 5000 });
      // Deliberately never released — the capture itself is the only consumer of this held state.
    },
  },

  error: {
    route: "/documents/00000000-0000-4000-8000-000000000000",
    expectStatus: (status) => status === 404 || status < 400,
  },
};
