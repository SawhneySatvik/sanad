import { describe, expect, it } from "vitest";
import { countDraftChainInProject, unassignDescription, unassignDraftDescription } from "@/components/projects/unassign-copy";

describe("unassignDescription", () => {
  it("names the item and states it stays in the library", () => {
    expect(unassignDescription("Lease")).toBe("Remove 'Lease' from this project? It stays in your library.");
  });
});

describe("unassignDraftDescription", () => {
  it("uses the singular form at N=1", () => {
    expect(unassignDraftDescription(1)).toBe("Remove this draft from the project? It stays in your library.");
  });
  it("uses the plural form with the real count at N>1", () => {
    expect(unassignDraftDescription(3)).toBe("Remove all 3 revisions of this draft from the project? They stay in your library.");
  });
});

describe("countDraftChainInProject", () => {
  it("counts every row sharing the same chain root, following parentDraftId", () => {
    const drafts = [
      { id: "root", parentDraftId: null },
      { id: "rev2", parentDraftId: "root" },
      { id: "rev3", parentDraftId: "rev2" },
      { id: "unrelated", parentDraftId: null },
    ];
    expect(countDraftChainInProject(drafts, "rev2")).toBe(3);
    expect(countDraftChainInProject(drafts, "root")).toBe(3);
    expect(countDraftChainInProject(drafts, "unrelated")).toBe(1);
  });

  it("a lone revision (no siblings loaded in this project) counts as 1", () => {
    const drafts = [{ id: "only", parentDraftId: null }];
    expect(countDraftChainInProject(drafts, "only")).toBe(1);
  });
});
