// Chat home and chat thread states — every ask/verify-batch/document call is intercepted at the
// browser's own network boundary via page.route, matching tests/e2e/screens/02-chat*.spec.ts's own
// identical technique.
//
//   npm run capture:screens -- --screen chat --states home-empty,home-with-chip,starter-filled,thread-streaming,thread-with-citations,thread-scanned-citation,stream-error,rate-limited-503,guest-save-nudge,attach-failed

import type { CaptureContext, StateRegistry } from "../types";

const GUEST_SESSION = { kind: "guest", signInAvailable: true, guestTtlHours: 3 } as const;

const ATTACHED_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const SCANNED_DOCUMENT_ID = "99999999-9999-4999-8999-999999999999";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function readyDocument(id: string, overrides: Record<string, unknown> = {}) {
  return {
    analysisState: "complete",
    document: {
      id,
      title: "Lease.pdf",
      sampleId: null,
      projectId: null,
      filename: "lease.pdf",
      mimeType: "application/pdf",
      processingStatus: "ready",
      inputMode: "text",
      documentType: "leave_and_license",
      jurisdiction: "IN",
      detectionConfidence: "high",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      ...overrides,
    },
    analysis: { id: "an-1", promptVersion: "v1", modelUsed: "gemini-2.5-flash", createdAt: "2026-01-01T00:00:00.000Z" },
    findings: [],
  };
}

async function sessionRoute(ctx: CaptureContext, overrides: Record<string, unknown> = {}): Promise<void> {
  await ctx.page.route("**/api/session", (route) => route.fulfill({ json: { ...GUEST_SESSION, ...overrides } }));
}

async function seedLocalThread(ctx: CaptureContext, id: string, thread: unknown): Promise<void> {
  await ctx.page.addInitScript(
    ({ threadId, seededThread }) => {
      window.localStorage.setItem("saboot:threads:v1:index", JSON.stringify([threadId]));
      window.localStorage.setItem(`saboot:threads:v1:${threadId}`, JSON.stringify(seededThread));
    },
    { threadId: id, seededThread: thread },
  );
}

async function waitReady(ctx: CaptureContext): Promise<void> {
  await ctx.page.waitForLoadState("networkidle");
  await ctx.page.evaluate(() => document.fonts.ready);
}

export const states: StateRegistry = {
  "home-empty": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
    },
  },

  "home-with-chip": {
    route: `/chat?attach=${ATTACHED_DOCUMENT_ID}`,
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route(`**/api/documents/${ATTACHED_DOCUMENT_ID}`, (route) => route.fulfill({ json: readyDocument(ATTACHED_DOCUMENT_ID) }));
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByText("Lease.pdf").waitFor({ state: "visible" });
    },
  },

  "starter-filled": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByRole("button", { name: "Explain what an NDA actually obligates me to do." }).click();
      await ctx.page.getByLabel("Ask Saboot").waitFor({ state: "visible" });
    },
  },

  "thread-streaming": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/ask", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          // No `final` frame at all — the capture's own `ready()` returns as soon as the token
          // renders, before the stream's natural (finalless) end is ever processed client-side.
          body: sseFrame("token", { type: "token", text: "Saboot is checking your document…" }),
        }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByLabel("Ask Saboot").fill("what is a typical notice period");
      await ctx.page.getByLabel("Ask Saboot").press("Enter");
      await ctx.page.getByText("Saboot is checking your document…").waitFor({ state: "visible" });
    },
  },

  "thread-with-citations": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route(`**/api/documents/${ATTACHED_DOCUMENT_ID}`, (route) => route.fulfill({ json: readyDocument(ATTACHED_DOCUMENT_ID) }));
      await ctx.page.route("**/api/ask", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseFrame("final", {
            type: "final",
            message: {
              id: null,
              role: "assistant",
              content: "Here is what the lease says about your deposit.",
              provenance: "ai_generated",
              modelUsed: "gemini-2.5-flash",
              routedDomains: ["tenancy"],
              createdAt: null,
              mode: "grounded",
              citations: [
                {
                  id: null,
                  sourceDocumentId: ATTACHED_DOCUMENT_ID,
                  inputMode: "text",
                  verification: {
                    status: "verified",
                    spanStart: 0,
                    spanEnd: 30,
                    spanText: "the deposit is fully refundable",
                    verifierVersion: "v1",
                    textHash: "hash-a",
                  },
                },
                {
                  id: null,
                  sourceDocumentId: null,
                  inputMode: null,
                  verification: {
                    status: "not_found",
                    spanStart: null,
                    spanEnd: null,
                    spanText: null,
                    claimedQuote: "a quote from a deleted document",
                    verifierVersion: "v1",
                    textHash: "0".repeat(64),
                  },
                },
              ],
            },
          }),
        }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByLabel("Ask Saboot").fill("what does my lease say about my deposit");
      await ctx.page.getByLabel("Ask Saboot").press("Enter");
      await ctx.page.getByText("Here is what the lease says about your deposit.").waitFor({ state: "visible" });
    },
  },

  "thread-scanned-citation": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route(`**/api/documents/${SCANNED_DOCUMENT_ID}`, (route) =>
        route.fulfill({ json: readyDocument(SCANNED_DOCUMENT_ID, { inputMode: "native_document", title: "Scanned.pdf", filename: "scanned.pdf" }) }),
      );
      await ctx.page.route("**/api/ask", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseFrame("final", {
            type: "final",
            message: {
              id: null,
              role: "assistant",
              content: "Here is what the scanned document says.",
              provenance: "ai_generated",
              modelUsed: "gemini-2.5-flash",
              routedDomains: ["general_legal"],
              createdAt: null,
              mode: "grounded",
              citations: [
                {
                  id: null,
                  sourceDocumentId: SCANNED_DOCUMENT_ID,
                  inputMode: "native_document",
                  verification: {
                    status: "approximate",
                    spanStart: 0,
                    spanEnd: 20,
                    spanText: "roughly this wording",
                    claimedQuote: "roughly this wording, as claimed",
                    verifierVersion: "v1",
                    textHash: "hash-b",
                  },
                },
              ],
            },
          }),
        }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByLabel("Ask Saboot").fill("what does this scanned document say");
      await ctx.page.getByLabel("Ask Saboot").press("Enter");
      await ctx.page.getByText(/This document was read from a scanned image/).waitFor({ state: "visible" });
    },
  },

  "stream-error": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/ask", (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body:
            sseFrame("token", { type: "token", text: "Hold on" }) +
            sseFrame("error", { error: { code: "UPSTREAM_UNAVAILABLE", message: "The AI providers are busy right now. Try again in a few minutes." } }),
        }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
      await ctx.page.getByLabel("Ask Saboot").press("Enter");
      await ctx.page.getByRole("button", { name: "Retry" }).waitFor({ state: "visible" });
    },
  },

  "rate-limited-503": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/ask", (route) =>
        route.fulfill({ status: 503, json: { error: { code: "UPSTREAM_UNAVAILABLE", message: "busy", retryAfterSeconds: 45 } } }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByLabel("Ask Saboot").fill("write me a haiku about rain");
      await ctx.page.getByLabel("Ask Saboot").press("Enter");
      await ctx.page.getByText(/Try again in 45 seconds/).waitFor({ state: "visible" });
    },
  },

  "guest-save-nudge": {
    route: "/chat/local-capture-save-nudge",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await seedLocalThread(ctx, "local-capture-save-nudge", {
        id: "local-capture-save-nudge",
        title: "What is a typical notice period?",
        documentIds: [],
        messages: [
          { id: "u1", role: "user", content: "What is a typical notice period?", mode: null, citations: [], createdAtMs: 1 },
          {
            id: "a1",
            role: "assistant",
            content: "Notice periods commonly range from 30 to 90 days.",
            mode: "general",
            citations: [],
            createdAtMs: 2,
          },
        ],
      });
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByText("Save this chat").click();
      await ctx.page.getByText("Sign in to keep this").waitFor({ state: "visible" });
    },
  },

  "attach-failed": {
    route: "/chat?attach=33333333-3333-4333-8333-333333333333",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/documents/33333333-3333-4333-8333-333333333333", (route) =>
        route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "The requested resource could not be found." } } }),
      );
    },
    ready: async (ctx) => {
      await waitReady(ctx);
      await ctx.page.getByText("That document couldn't be attached.").waitFor({ state: "visible" });
    },
  },
};
