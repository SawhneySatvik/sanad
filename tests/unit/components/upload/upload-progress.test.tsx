import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { UploadProgress } from "@/components/upload/upload-progress";

function renderProgress(props: React.ComponentProps<typeof UploadProgress>) {
  return render(
    <LiveRegionProvider>
      <UploadProgress {...props} />
    </LiveRegionProvider>,
  );
}

describe("UploadProgress — uploading (determinate)", () => {
  it("exposes real aria-valuenow/aria-valuemax during upload", () => {
    renderProgress({ phase: "uploading", percent: 42 });
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).not.toHaveAttribute("aria-valuetext");
  });

  it("clamps an out-of-range percent rather than emitting an invalid aria-valuenow", () => {
    renderProgress({ phase: "uploading", percent: 142 });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("shows the stage label 'Uploading · N%', tracking the real percent", () => {
    renderProgress({ phase: "uploading", percent: 42 });
    expect(screen.getByText("Uploading · 42%")).toBeInTheDocument();
  });

  it("clamps the stage label's own percent too, in step with aria-valuenow", () => {
    renderProgress({ phase: "uploading", percent: 142 });
    expect(screen.getByText("Uploading · 100%")).toBeInTheDocument();
  });

  it("shows the attachment row (file icon + filename) only when fileMeta is given", () => {
    const { rerender } = renderProgress({ phase: "uploading", percent: 10 });
    expect(screen.queryByText("lease.pdf")).not.toBeInTheDocument();

    rerender(
      <LiveRegionProvider>
        <UploadProgress phase="uploading" percent={10} fileMeta={{ filename: "lease.pdf", sizeBytes: 1024 }} />
      </LiveRegionProvider>,
    );
    expect(screen.getByText("lease.pdf")).toBeInTheDocument();
  });
});

describe("UploadProgress — analyzing (indeterminate)", () => {
  it("exposes aria-valuetext='Analysing' with no numeric aria-valuenow", () => {
    renderProgress({ phase: "analyzing" });
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "Analysing");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).not.toHaveAttribute("aria-valuemax");
  });

  it("shows the one fixed 'Reading the document…' stage label", () => {
    renderProgress({ phase: "analyzing" });
    expect(screen.getByText("Reading the document…")).toBeInTheDocument();
  });
});

describe("UploadProgress — a11y", () => {
  it("has no axe violations in either phase", async () => {
    const uploading = renderProgress({ phase: "uploading", percent: 55 });
    expect(await axe(uploading.container)).toHaveNoViolations();
    uploading.unmount();

    const analyzing = renderProgress({ phase: "analyzing" });
    expect(await axe(analyzing.container)).toHaveNoViolations();
  });
});
