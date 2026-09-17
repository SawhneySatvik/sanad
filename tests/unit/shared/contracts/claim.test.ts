import { describe, expect, it } from "vitest";
import { ClaimResultOutput } from "@/shared/contracts/claim";

describe("ClaimResultOutput", () => {
  it("accepts nonnegative integer counts", () => {
    expect(ClaimResultOutput.parse({ documents: 2, comparisons: 1, drafts: 0 })).toEqual({
      documents: 2,
      comparisons: 1,
      drafts: 0,
    });
  });

  it("rejects a negative count, a non-integer, and a missing field", () => {
    expect(ClaimResultOutput.safeParse({ documents: -1, comparisons: 0, drafts: 0 }).success).toBe(false);
    expect(ClaimResultOutput.safeParse({ documents: 1.5, comparisons: 0, drafts: 0 }).success).toBe(false);
    expect(ClaimResultOutput.safeParse({ documents: 0, comparisons: 0 }).success).toBe(false);
  });
});
