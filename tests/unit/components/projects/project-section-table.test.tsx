// jsdom's own matchMedia stub (tests/setup/jsdom.ts) always reports matches:false, so a bare render
// already exercises the desktop <table> branch; mockMobileViewport below flips it for the phone-list
// branch, restored afterward so it never leaks into another file sharing this same jsdom global.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { ProjectSectionTable, type ProjectSectionRow } from "@/components/projects/project-section-table";

const ROWS: ProjectSectionRow[] = [
  { id: "doc-1", title: "Lease.pdf", secondary: "Updated 2 h ago", href: "/documents/doc-1" },
  { id: "doc-2", title: "NDA.pdf", href: "/documents/doc-2" },
];

let originalMatchMedia: typeof window.matchMedia;

function mockMobileViewport(): void {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

afterEach(() => {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
});

describe("ProjectSectionTable — desktop", () => {
  it("renders a real table with a header row, and an always-visible row action (no showOnHover)", () => {
    render(<ProjectSectionTable rows={ROWS} onRename={vi.fn()} onRemoveFromProject={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Actions for Lease.pdf" });
    expect(action.className).not.toMatch(/opacity-0/);
  });
});

describe("ProjectSectionTable — phone", () => {
  it("drops the table header row for a plain list, action still always visible", () => {
    mockMobileViewport();
    render(<ProjectSectionTable rows={ROWS} onRename={vi.fn()} onRemoveFromProject={vi.fn()} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lease.pdf" })).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Actions for Lease.pdf" });
    expect(action.className).not.toMatch(/opacity-0/);
  });
});
