import { describe, expect, it } from "vitest";
import { resolveAssetSrc } from "@/components/feedback/resolve-asset-src";

describe("resolveAssetSrc", () => {
  it("returns null for every asset id today — the delivery seam isn't filled in yet", () => {
    expect(resolveAssetSrc("empty-library")).toBeNull();
    expect(resolveAssetSrc("anything-else")).toBeNull();
  });
});
