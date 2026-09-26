import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { AssetPlaceholder } from "@/components/feedback/asset-placeholder";

describe("AssetPlaceholder", () => {
  it("renders a labelled placeholder shape at the exact ratio, tagged with its assetId", () => {
    render(<AssetPlaceholder assetId="empty-library" ratio="1 / 1" label="Empty library illustration" />);
    const el = screen.getByRole("img", { name: "Empty library illustration" });
    expect(el).toHaveAttribute("data-asset-id", "empty-library");
    expect(el).toHaveStyle({ aspectRatio: "1 / 1" });
  });

  it("applies the given pixel size", () => {
    render(<AssetPlaceholder assetId="empty-projects" ratio="4 / 3" label="Empty projects illustration" sizePx={{ w: 240, h: 180 }} />);
    const el = screen.getByRole("img", { name: "Empty projects illustration" });
    expect(el).toHaveStyle({ width: "240px", height: "180px" });
  });

  it("shows no visible caption, so a demo screen never reads as unfinished", () => {
    render(<AssetPlaceholder assetId="error-404" ratio="1 / 1" label="404 illustration" />);
    expect(screen.getByRole("img", { name: "404 illustration" })).toHaveTextContent("");
  });

  it("has no axe violations", async () => {
    const { container } = render(<AssetPlaceholder assetId="empty-unsupported-type" ratio="1 / 1" label="Unsupported file type illustration" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
