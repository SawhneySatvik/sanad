import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ComparisonListOutput, ComparisonListRowOutput, DocumentListOutput, DocumentListRowOutput,
  DraftListOutput, DraftListRowOutput, ThreadListOutput, ThreadListRowOutput } from "@/shared/contracts/library";

const forbidden = new Set(["verification", "status", "spanText", "claimedQuote", "quote"]);
const unsafeKeys = (value: Record<string, unknown>) => Object.keys(value).filter((key) => forbidden.has(key));

function expectNoForbiddenSchemaKeys(schema: { shape: Record<string, unknown> }) {
  expect(Object.keys(schema.shape).filter((key) => forbidden.has(key))).toEqual([]);
}

describe("library list metadata contract", () => {
  it("accepts processingStatus while rejecting exact status and verification keys", () => {
    const row = {
      id: "a1a1a1a1-0000-4000-8000-0000000000a1", title: "Lease", filename: "lease.txt",
      documentType: null, processingStatus: "ready", analysisState: "not_analyzed", inputMode: "text",
      sampleId: null, projectId: null, uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), expiresAt: null,
    };
    const parsed = DocumentListRowOutput.parse(row);
    expect(parsed.processingStatus).toBe("ready");
    expect(unsafeKeys(parsed)).toEqual([]);
    for (const schema of [DocumentListRowOutput, ComparisonListRowOutput, DraftListRowOutput, ThreadListRowOutput]) {
      expectNoForbiddenSchemaKeys(schema);
    }
  });

  it("the schema-key gate catches an optional or defaulted bare status", () => {
    expect(() => expectNoForbiddenSchemaKeys(DocumentListRowOutput.extend({ status: z.string().optional() }))).toThrow();
    expect(() => expectNoForbiddenSchemaKeys(DocumentListRowOutput.extend({ status: z.string().default("verified") }))).toThrow();
  });

  it("requires the collection envelope and all fields on each list row", () => {
    const id = "a1a1a1a1-0000-4000-8000-0000000000a1";
    const otherId = "b2b2b2b2-0000-4000-8000-0000000000b2";
    const date = new Date("2026-09-24T12:00:00.000Z").toISOString();
    const fixtures = [
      [DocumentListOutput, DocumentListRowOutput, { id, title: "Lease", filename: "lease.txt", documentType: "leave_and_license", processingStatus: "ready", analysisState: "complete", inputMode: "text", sampleId: null, projectId: null, uploadedAt: date, updatedAt: date, expiresAt: null }],
      [ComparisonListOutput, ComparisonListRowOutput, { id, title: "Lease vs NDA", titleA: "Lease", titleB: "NDA", documentAId: id, documentBId: otherId, modelUsed: "none", projectId: null, createdAt: date, updatedAt: date, expiresAt: null }],
      [DraftListOutput, DraftListRowOutput, { id, title: "NDA draft", documentType: "nda", mode: "from_scratch", revisionCount: 2, projectId: null, createdAt: date, updatedAt: date, expiresAt: null }],
      [ThreadListOutput, ThreadListRowOutput, { id, title: "Chat", projectId: null, createdAt: date, updatedAt: date }],
    ] as const;
    for (const [envelope, rowSchema, row] of fixtures) {
      const good = { items: [row], nextCursor: null };
      expect(envelope.safeParse(good).success).toBe(true);
      expect(envelope.safeParse({ items: [row] }).success).toBe(false);
      expect(envelope.safeParse({ nextCursor: null }).success).toBe(false);
      for (const key of Object.keys(row)) {
        const missing = { ...row } as Record<string, unknown>;
        delete missing[key];
        expect(rowSchema.safeParse(missing).success, key).toBe(false);
      }
    }
  });
});
