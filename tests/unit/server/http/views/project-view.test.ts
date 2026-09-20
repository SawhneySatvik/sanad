import { describe, expect, it } from "vitest";
import type { Project, ProjectDetail } from "@/server/data/projects";
import { projectDetailView, projectsListView, projectView } from "@/server/http/views/project-view";

function poisonedProject(): Project {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    ownerUserId: "spoofed-owner",
    name: "n",
    color: null,
    icon: null,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function poisonedDetail(): ProjectDetail {
  return {
    project: poisonedProject(),
    documents: [
      {
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        ownerUserId: "spoofed-owner",
        ownerGuestSessionId: null,
        projectId: "aaaaaaaa-0000-4000-8000-000000000001",
        filename: "f.txt",
        mimeType: "text/plain",
        inputMode: "text",
        processingStatus: "ready",
        documentType: "generic",
        jurisdiction: "IN",
        uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: null,
      },
    ] as ProjectDetail["documents"],
    comparisons: [
      {
        id: "cccccccc-0000-4000-8000-000000000001",
        ownerUserId: "spoofed-owner",
        ownerGuestSessionId: null,
        projectId: "aaaaaaaa-0000-4000-8000-000000000001",
        documentAId: "bbbbbbbb-0000-4000-8000-000000000001",
        documentBId: "bbbbbbbb-0000-4000-8000-000000000002",
        modelUsed: "gemini-test",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: null,
      },
    ] as ProjectDetail["comparisons"],
    drafts: [
      {
        id: "dddddddd-0000-4000-8000-000000000001",
        ownerUserId: "spoofed-owner",
        ownerGuestSessionId: null,
        projectId: "aaaaaaaa-0000-4000-8000-000000000001",
        documentType: "generic",
        mode: "from_scratch",
        groundingDocumentId: null,
        revisionNumber: 1,
        parentDraftId: null,
        jurisdiction: "IN",
        modelUsed: "gemini-test",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: null,
      },
    ] as ProjectDetail["drafts"],
    threads: [
      {
        id: "eeeeeeee-0000-4000-8000-000000000001",
        ownerUserId: "spoofed-owner",
        projectId: "aaaaaaaa-0000-4000-8000-000000000001",
        title: "t",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ] as ProjectDetail["threads"],
  };
}

describe("projectView", () => {
  it("drops ownerUserId", () => {
    const view = projectView(poisonedProject());
    expect(view).not.toHaveProperty("ownerUserId");
    expect(view.id).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });
});

describe("projectsListView", () => {
  it("wraps a list, each project stripped the same way", () => {
    expect(projectsListView([poisonedProject()]).projects[0]).not.toHaveProperty("ownerUserId");
  });
});

describe("projectDetailView", () => {
  it("strips owner columns and processingStatus from every nested row (positive control: the input really carried them)", () => {
    const detail = poisonedDetail();
    expect(JSON.stringify(detail)).toMatch(/ownerUserId|ownerGuestSessionId|processingStatus/);

    const view = projectDetailView(detail);
    const raw = JSON.stringify(view);
    expect(raw).not.toMatch(/ownerUserId|ownerGuestSessionId|processingStatus|spoofed-owner/);
    expect(view.documents[0]).not.toHaveProperty("ownerUserId");
    expect(view.documents[0]).not.toHaveProperty("ownerGuestSessionId");
    expect(view.documents[0]).not.toHaveProperty("processingStatus");
    expect(view.comparisons[0]).not.toHaveProperty("ownerUserId");
    expect(view.drafts[0]).not.toHaveProperty("ownerUserId");
    expect(view.threads[0]).not.toHaveProperty("ownerUserId");
  });
});
