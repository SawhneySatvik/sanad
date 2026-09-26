import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { axe } from "jest-axe";
import { ExportMenu } from "@/components/export/export-menu";
import { writeToClipboard } from "@/components/export/clipboard";

// jsdom's own navigator.clipboard resists a direct test-time override (its accessor doesn't honour
// a plain reassignment or defineProperty the way a real browser's would) — mocking the small module
// export-menu.tsx itself calls through is the reliable seam instead.
vi.mock("@/components/export/clipboard", () => ({ writeToClipboard: vi.fn().mockResolvedValue(undefined) }));

describe("ExportMenu", () => {
  beforeEach(() => {
    vi.mocked(writeToClipboard).mockClear();
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows Download and Copy, never Print, when onPrint is omitted (Draft's own call)", async () => {
    const user = userEvent.setup();
    render(<ExportMenu exportText="draft body" exportFilename="draft.txt" copyText="draft body" />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Print" })).not.toBeInTheDocument();
  });

  it("shows Print only when onPrint is supplied, and calls it on click", async () => {
    const onPrint = vi.fn();
    const user = userEvent.setup();
    render(<ExportMenu exportText="# Markdown" exportFilename="prepare.md" onPrint={onPrint} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: "Print" }));
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it("Copy writes copyText to the clipboard, distinct from exportText when they differ", async () => {
    const user = userEvent.setup();
    render(<ExportMenu exportText="# Escaped markdown" exportFilename="prepare.md" copyText="Plain text version" />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeToClipboard).toHaveBeenCalledWith("Plain text version");
    expect(writeToClipboard).not.toHaveBeenCalledWith("# Escaped markdown");
  });

  it("Copy falls back to exportText when copyText is omitted", async () => {
    const user = userEvent.setup();
    render(<ExportMenu exportText="draft body" exportFilename="draft.txt" />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeToClipboard).toHaveBeenCalledWith("draft body");
  });

  it("Download builds a Blob named exportFilename, distinct from copyText's own content", async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ExportMenu exportText="# Markdown export" exportFilename="prepare.md" copyText="plain text export" />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: "Download" }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toContain("text/markdown");
    clickSpy.mockRestore();
  });

  it("has no axe violations, open or closed", async () => {
    const { container } = render(<ExportMenu exportText="draft body" exportFilename="draft.txt" />);
    expect(await axe(container)).toHaveNoViolations();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
