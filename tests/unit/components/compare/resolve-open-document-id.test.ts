import { describe, expect, it } from "vitest";
import { resolveOpenDocumentId } from "@/components/compare/resolve-open-document-id";

const comparison = { documentAId: "doc-a", documentBId: "doc-b" };

describe("resolveOpenDocumentId — the newer version wins, except when the clause only ever existed in A", () => {
  it("removed opens document A (the clause only exists there)", () => {
    expect(resolveOpenDocumentId({ changeType: "removed" }, comparison)).toBe("doc-a");
  });

  it("added opens document B, the newer version", () => {
    expect(resolveOpenDocumentId({ changeType: "added" }, comparison)).toBe("doc-b");
  });

  it("changed opens document B, the newer version", () => {
    expect(resolveOpenDocumentId({ changeType: "changed" }, comparison)).toBe("doc-b");
  });
});
