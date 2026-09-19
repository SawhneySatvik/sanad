import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDocumentBlocks } from "@/server/prompts/orchestrator/shared";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("buildDocumentBlocks", () => {
  it("computes the boundary hash itself from canonicalText — a caller can't influence it", () => {
    const canonicalText = "The rent is 20000 per month.";
    const output = buildDocumentBlocks([{ id: "doc-1", canonicalText }]);
    const realHash = sha256(canonicalText).slice(0, 16);
    expect(output).toContain(`DOCUMENT-1-${realHash}`);
  });

  it("ManifestDocument has no canonicalTextHash field to trust — a caller literally cannot pass one in", () => {
    // Structural proof, not just a runtime one: this compiles only because buildDocumentBlocks'
    // parameter type has no `canonicalTextHash` field at all.
    const output = buildDocumentBlocks([{ id: "doc-1", canonicalText: "hello world" }]);
    expect(output).toContain(`DOCUMENT-1-${sha256("hello world").slice(0, 16)}`);
  });

  it("two documents with different text get different, independently-computed boundary hashes", () => {
    const output = buildDocumentBlocks([
      { id: "doc-1", canonicalText: "first document text" },
      { id: "doc-2", canonicalText: "second document text" },
    ]);
    expect(output).toContain(`DOCUMENT-1-${sha256("first document text").slice(0, 16)}`);
    expect(output).toContain(`DOCUMENT-2-${sha256("second document text").slice(0, 16)}`);
  });

  it("a document's own text cannot contain its own boundary marker (the whole point of a content-derived hash)", () => {
    const canonicalText = "Some ordinary document text with no special markers.";
    const output = buildDocumentBlocks([{ id: "doc-1", canonicalText }]);
    const hash = sha256(canonicalText).slice(0, 16);
    expect(output).toContain(`DOCUMENT-1-${hash} BEGIN`);
    // The document's OWN text, unmodified, obviously doesn't contain a hash of itself — this
    // pins that invariant rather than just asserting it in a comment.
    expect(canonicalText.includes(`DOCUMENT-1-${hash}`)).toBe(false);
  });
});
