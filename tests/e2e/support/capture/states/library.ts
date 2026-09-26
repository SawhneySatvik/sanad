// Library and projects' own capture states. Every state needs only deterministic setup — list
// reads, a sample open, save-to-project — none of it calls a live model.

import { randomUUID } from "node:crypto";
import type { CaptureContext, StateRegistry } from "../types";

async function openLeaseSample(ctx: CaptureContext): Promise<string> {
  const response = await ctx.context.request.post(`${ctx.baseUrl}/api/samples/lease/open`);
  const body = (await response.json()) as { documentId: string };
  return body.documentId;
}

async function devSignIn(ctx: CaptureContext, displayName: string): Promise<void> {
  await ctx.context.request.post(`${ctx.baseUrl}/api/auth/dev-sign-in`, { data: { displayName } });
  await ctx.context.request.post(`${ctx.baseUrl}/api/auth/claim`);
}

async function createProject(ctx: CaptureContext, name: string): Promise<string> {
  const response = await ctx.context.request.post(`${ctx.baseUrl}/api/projects`, { data: { name } });
  const body = (await response.json()) as { id: string };
  return body.id;
}

export const states: StateRegistry = {
  "library-empty": {
    route: "/library",
  },

  "library-mixed": {
    route: "/library",
    setup: async (ctx) => {
      await openLeaseSample(ctx);
    },
  },

  "library-delete-impact": {
    route: "/library",
    setup: async (ctx) => {
      await openLeaseSample(ctx);
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      await ctx.page.getByRole("button", { name: /^Actions for/ }).first().click();
      await ctx.page.getByRole("menuitem", { name: "Delete" }).click();
      await ctx.page.getByRole("alertdialog").waitFor();
    },
  },

  "projects-empty": {
    route: "/projects",
    setup: async (ctx) => {
      await devSignIn(ctx, `capture-projects-empty-${randomUUID()}`);
    },
  },

  "projects-grid": {
    route: "/projects",
    setup: async (ctx) => {
      await devSignIn(ctx, `capture-projects-grid-${randomUUID()}`);
      await createProject(ctx, "Apartment hunt");
      await createProject(ctx, "New job paperwork");
    },
  },

  "project-detail": {
    route: "/projects/__pending__",
    setup: async (ctx) => {
      await devSignIn(ctx, `capture-project-detail-${randomUUID()}`);
      const documentId = await openLeaseSample(ctx);
      const projectId = await createProject(ctx, "Apartment hunt");
      await ctx.context.request.post(`${ctx.baseUrl}/api/documents/${documentId}/save-to-project`, { data: { projectId } });
      states["project-detail"].route = `/projects/${projectId}`;
    },
  },

  "project-picker": {
    route: "/library",
    setup: async (ctx) => {
      await devSignIn(ctx, `capture-project-picker-${randomUUID()}`);
      await openLeaseSample(ctx);
      await createProject(ctx, "Apartment hunt");
    },
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      await ctx.page.getByRole("button", { name: /^Actions for/ }).first().click();
      await ctx.page.getByRole("menuitem", { name: "Save to project" }).click();
    },
  },

  "guest-claim-nudge": {
    route: "/projects",
    ready: async (ctx) => {
      await ctx.page.waitForLoadState("networkidle");
      await ctx.page.getByRole("button", { name: "New project" }).click();
      await ctx.page.getByText("Sign in to keep this").waitFor();
    },
  },
};
