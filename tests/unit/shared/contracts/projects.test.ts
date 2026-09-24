import { describe, expect, it } from "vitest";
import {
  CreateProjectInput,
  ProjectDetailOutput,
  ProjectOutput,
  SaveToProjectInput,
  SaveToProjectOutput,
} from "@/shared/contracts/projects";

describe("CreateProjectInput", () => {
  it("accepts a name (+ optional color/icon), rejects a blank name, and is strict", () => {
    expect(CreateProjectInput.safeParse({ name: "Flat lease" }).success).toBe(true);
    expect(CreateProjectInput.safeParse({ name: "Flat lease", color: "teal", icon: "home" }).success).toBe(true);
    expect(CreateProjectInput.safeParse({ name: "" }).success).toBe(false);
    // A client can never smuggle in a server-owned field: strict schemas reject unknown keys.
    expect(CreateProjectInput.safeParse({ name: "x", ownerUserId: "spoofed" }).success).toBe(false);
  });
});

describe("SaveToProjectInput", () => {
  it("projectId is a bounded string, not a guid — a malformed value still parses so the repository (not zod) turns it into the same NOT_FOUND a foreign/missing id gets, never a 400", () => {
    expect(SaveToProjectInput.safeParse({ projectId: "not-a-uuid" }).success).toBe(true);
    expect(SaveToProjectInput.safeParse({ projectId: "" }).success).toBe(false);
    expect(SaveToProjectInput.safeParse({}).success).toBe(false);
    expect(SaveToProjectInput.safeParse({ projectId: "x", extra: 1 }).success).toBe(false);
  });
});

describe("SaveToProjectOutput", () => {
  it("whitelists projectId and itemIds only — a repo result's extra `kind` field is stripped", () => {
    const raw = {
      projectId: "aaaaaaaa-0000-4000-8000-000000000001",
      kind: "document",
      itemIds: ["bbbbbbbb-0000-4000-8000-000000000002"],
    };
    const parsed = SaveToProjectOutput.parse(raw);
    expect(parsed).toEqual({ projectId: raw.projectId, itemIds: raw.itemIds });
    expect(parsed).not.toHaveProperty("kind");
  });
});

describe("project payloads carry no canonical text, storage ref, draft content or status (contract test)", () => {
  const poisonedProject = {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "n",
    color: null,
    icon: null,
    openedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    // Poison: never legitimately on this wire.
    ownerUserId: "aaaaaaaa-0000-4000-8000-000000000099",
  };

  it("ProjectOutput strips ownerUserId", () => {
    expect(ProjectOutput.parse(poisonedProject)).not.toHaveProperty("ownerUserId");
  });

  it("ProjectDetailOutput strips owner columns, canonical_text, storage_ref, draft content and processingStatus from every nested row (positive control: the poisoned input really carried them)", () => {
    const poisonedDetail = {
      project: poisonedProject,
      documents: [
        {
          id: "bbbbbbbb-0000-4000-8000-000000000001",
          title: "f.txt",
          filename: "f.txt",
          mimeType: "text/plain",
          inputMode: "text",
          documentType: "generic",
          jurisdiction: "IN",
          uploadedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          // Poison:
          ownerUserId: "x",
          ownerGuestSessionId: null,
          canonicalText: "SECRET CANONICAL TEXT",
          storageRef: "guest:abc/f.txt",
          processingStatus: "ready",
        },
      ],
      comparisons: [
        {
          id: "cccccccc-0000-4000-8000-000000000001",
          title: "f.txt vs other.txt",
          documentAId: "bbbbbbbb-0000-4000-8000-000000000001",
          documentBId: "bbbbbbbb-0000-4000-8000-000000000003",
          modelUsed: "gemini-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          ownerUserId: "x",
          ownerGuestSessionId: null,
        },
      ],
      drafts: [
        {
          id: "dddddddd-0000-4000-8000-000000000001",
          title: "Generic draft",
          documentType: "generic",
          mode: "from_scratch",
          groundingDocumentId: null,
          revisionNumber: 1,
          parentDraftId: null,
          jurisdiction: "IN",
          modelUsed: "gemini-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          ownerUserId: "x",
          ownerGuestSessionId: null,
          content: "SECRET DRAFT CONTENT",
        },
      ],
      threads: [
        {
          id: "eeeeeeee-0000-4000-8000-000000000001",
          title: "t",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ownerUserId: "x",
        },
      ],
    };

    // Positive control: the poisoned input really carries every one of those fields.
    const rawInput = JSON.stringify(poisonedDetail);
    expect(rawInput).toContain("SECRET CANONICAL TEXT");
    expect(rawInput).toContain("SECRET DRAFT CONTENT");
    expect(rawInput).toContain("storageRef");
    expect(rawInput).toContain("processingStatus");
    expect(rawInput).toContain("ownerUserId");
    expect(rawInput).toContain("ownerGuestSessionId");

    const parsedOutput = JSON.stringify(ProjectDetailOutput.parse(poisonedDetail));
    expect(parsedOutput).not.toContain("SECRET CANONICAL TEXT");
    expect(parsedOutput).not.toContain("SECRET DRAFT CONTENT");
    expect(parsedOutput).not.toMatch(/storageRef|canonicalText|processingStatus|ownerUserId|ownerGuestSessionId/);
  });
});
