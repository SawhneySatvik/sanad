import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// A separate file, not a second describe() in asset-placeholder.test.tsx: vi.mock() is hoisted
// only when it's a top-level statement, and this needs to replace resolveAssetSrc before
// AssetPlaceholder's own top-level import of it resolves — simulating the future state once
// resolveAssetSrc names a real delivered path.
vi.mock("@/components/feedback/resolve-asset-src", () => ({
  resolveAssetSrc: (assetId: string) => (assetId === "empty-library" ? "/assets/empty-library.png" : null),
}));

import { AssetPlaceholder } from "@/components/feedback/asset-placeholder";

describe("AssetPlaceholder, once resolveAssetSrc names a real path", () => {
  it("renders the delivered image directly, decorative alt, with the caller's label as the accessible name", () => {
    render(<AssetPlaceholder assetId="empty-library" ratio="1 / 1" label="Empty library illustration" />);
    const img = screen.getByRole("img", { name: "Empty library illustration" });
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "/assets/empty-library.png");
    expect(img).toHaveAttribute("alt", "");
  });

  it("still falls back to the placeholder box for an asset id the resolver doesn't recognise", () => {
    render(<AssetPlaceholder assetId="not-yet-delivered" ratio="1 / 1" label="Not yet delivered" />);
    const el = screen.getByRole("img", { name: "Not yet delivered" });
    expect(el.tagName).toBe("DIV");
    expect(el).toHaveAttribute("data-asset-id", "not-yet-delivered");
  });
});
