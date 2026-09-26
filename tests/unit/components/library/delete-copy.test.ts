import { describe, expect, it } from "vitest";
import { documentDeleteDescription, draftDeleteDescription, libraryDeleteDescription, COMPARISON_DELETE_DESCRIPTION, THREAD_DELETE_DESCRIPTION } from "@/components/library/delete-copy";

describe("documentDeleteDescription", () => {
  it("states the fixed opener and the fixed local-thread addendum with no impact at all", () => {
    expect(documentDeleteDescription("Lease", undefined)).toBe(
      "Delete 'Lease'? This can't be undone. Chats on this device that quote it will show it as unavailable.",
    );
  });

  it("adds one grammatically correct line per non-zero impact field, singular and plural, never a literal '(s)'", () => {
    const text = documentDeleteDescription("Lease", { comparisons: 1, draftsUngrounded: 2, threadsUnlinked: 1 });
    expect(text).toContain("1 comparison will also be deleted.");
    expect(text).toContain("2 drafts will lose their grounding document.");
    expect(text).toContain("1 saved chat will lose this document as a source.");
    expect(text).not.toContain("(s)");
  });

  it("omits a zero-count impact line entirely, keeping the fixed addendum", () => {
    const text = documentDeleteDescription("Lease", { comparisons: 0, draftsUngrounded: 0, threadsUnlinked: 0 });
    expect(text).toBe("Delete 'Lease'? This can't be undone. Chats on this device that quote it will show it as unavailable.");
  });

  it("pluralizes comparisons correctly at N>1", () => {
    expect(documentDeleteDescription("Lease", { comparisons: 2, draftsUngrounded: 0, threadsUnlinked: 0 })).toContain(
      "2 comparisons will also be deleted.",
    );
  });
});

describe("draftDeleteDescription", () => {
  it("reads 'All 1 revision' at N=1", () => {
    expect(draftDeleteDescription(1)).toBe("Delete this draft? All 1 revision will be deleted.");
  });
  it("reads 'All N revisions' at N>1", () => {
    expect(draftDeleteDescription(3)).toBe("Delete this draft? All 3 revisions will be deleted.");
  });
});

describe("fixed-copy types", () => {
  it("comparison and thread never vary by count", () => {
    expect(COMPARISON_DELETE_DESCRIPTION).toBe("Delete this comparison? Changes cascade. The two documents are untouched.");
    expect(THREAD_DELETE_DESCRIPTION).toBe("Delete this chat? This can't be undone.");
  });
});

describe("libraryDeleteDescription dispatch", () => {
  it("routes each itemType to its own builder", () => {
    expect(libraryDeleteDescription("comparison", { title: "x" })).toBe(COMPARISON_DELETE_DESCRIPTION);
    expect(libraryDeleteDescription("thread", { title: "x" })).toBe(THREAD_DELETE_DESCRIPTION);
    expect(libraryDeleteDescription("draft", { title: "x", revisionCount: 2 })).toBe("Delete this draft? All 2 revisions will be deleted.");
    expect(libraryDeleteDescription("document", { title: "Lease" })).toContain("Delete 'Lease'?");
  });
});
