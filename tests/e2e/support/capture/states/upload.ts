// This directory's own upload states, mounted through /chat's composer (these components have no
// route of their own — every instance mounts inside the composer). Every network step is
// intercepted at the browser's own boundary, matching this file's own upload screen states.
//
//   npm run capture:screens -- --screen upload --states upload-progress,analysing,error-too-large,error-unsupported-type,error-extraction-failed

import type { CaptureContext, StateRegistry } from "../types";

async function sessionRoute(ctx: CaptureContext): Promise<void> {
  await ctx.page.route("**/api/session", (route) => route.fulfill({ json: { kind: "guest", signInAvailable: true, guestTtlHours: 3 } }));
}

async function chooseFile(ctx: CaptureContext, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await ctx.page.waitForLoadState("networkidle");
  const input = ctx.page.locator('input[type="file"]');
  await input.setInputFiles(file);
}

const SMALL_TEXT_FILE = { name: "lease.txt", mimeType: "text/plain", buffer: Buffer.from("This is a lease agreement.".repeat(50), "utf8") };

export const states: StateRegistry = {
  "upload-progress": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/uploads", (route) =>
        route.fulfill({ json: { method: "server-relay", uploadUrl: "/api/uploads/relay?token=capture-token", ref: "capture-ref" } }),
      );
      // Held indefinitely — the determinate "uploading" card is what this state captures, not a
      // completed upload; never resolving this route is what keeps the flow at that phase.
      await ctx.page.route("**/api/uploads/relay**", () => new Promise<void>(() => undefined));
    },
    ready: async (ctx) => {
      await chooseFile(ctx, SMALL_TEXT_FILE);
      await ctx.page.getByRole("progressbar", { name: "Upload progress" }).waitFor({ state: "visible" });
    },
  },

  analysing: {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/uploads", (route) =>
        route.fulfill({ json: { method: "server-relay", uploadUrl: "/api/uploads/relay?token=capture-token", ref: "capture-ref" } }),
      );
      await ctx.page.route("**/api/uploads/relay**", (route) => route.fulfill({ json: { ref: "capture-ref" } }));
      // Held indefinitely — POST /api/documents is the "confirming/analysing" phase's own call.
      await ctx.page.route("**/api/documents", (route) => {
        if (route.request().method() !== "POST") return route.continue();
        return new Promise<void>(() => undefined);
      });
    },
    ready: async (ctx) => {
      await chooseFile(ctx, SMALL_TEXT_FILE);
      await ctx.page.getByText("Reading the document…").waitFor({ state: "visible" });
    },
  },

  "error-too-large": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
    },
    ready: async (ctx) => {
      // A client-side pre-check rejection — no network call fires at all for this one.
      await chooseFile(ctx, { name: "huge.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(16 * 1024 * 1024) });
      // Scoped to the visible role="note" card, not a bare getByText(): the same message also
      // mirrors once into the chrome's own sr-only live region (UploadErrorCard's
      // useAnnounceOnMount), which a plain text query matches as a second, strict-mode-tripping
      // element.
      await ctx.page.getByRole("note").filter({ hasText: /too large/ }).waitFor({ state: "visible" });
    },
  },

  "error-unsupported-type": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
    },
    ready: async (ctx) => {
      await chooseFile(ctx, { name: "archive.zip", mimeType: "application/zip", buffer: Buffer.from("PK\x03\x04") });
      await ctx.page.getByText(/can't read this file type/).waitFor({ state: "visible" });
    },
  },

  "error-extraction-failed": {
    route: "/chat",
    setup: async (ctx) => {
      await sessionRoute(ctx);
      await ctx.page.route("**/api/uploads", (route) =>
        route.fulfill({ json: { method: "server-relay", uploadUrl: "/api/uploads/relay?token=capture-token", ref: "capture-ref" } }),
      );
      await ctx.page.route("**/api/uploads/relay**", (route) => route.fulfill({ json: { ref: "capture-ref" } }));
      await ctx.page.route("**/api/documents", (route) => {
        if (route.request().method() !== "POST") return route.continue();
        return route.fulfill({
          status: 422,
          json: { error: { code: "EXTRACTION_FAILED", message: "The document's text could not be extracted.", reason: "unreadable" } },
        });
      });
    },
    ready: async (ctx) => {
      await chooseFile(ctx, SMALL_TEXT_FILE);
      await ctx.page.getByText(/couldn't read this file/).waitFor({ state: "visible" });
    },
  },
};
