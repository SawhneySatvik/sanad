import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@/components/ui/sidebar";
import { LibraryTable } from "@/components/library/library-table";
import type { LibraryRow } from "@/components/library/library-row";
import { NextRouterStub } from "@tests/support/next-router-stub";

function baseRow(overrides: Partial<LibraryRow> = {}): LibraryRow {
  return {
    itemType: "document",
    id: "doc-1",
    title: "Lease.pdf",
    href: "/documents/doc-1",
    updatedAtMs: Date.now() - 60_000,
    createdAtMs: Date.now() - 120_000,
    expiresAt: null,
    projectId: null,
    isLocal: false,
    documentType: "leave_and_license",
    analysisState: "complete",
    processingStatus: "ready",
    inputMode: "text",
    sampleId: null,
    ...overrides,
  } as LibraryRow;
}

function renderTable(rows: LibraryRow[], overrides: Partial<React.ComponentProps<typeof LibraryTable>> = {}) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <NextRouterStub>
        <SidebarProvider>
          <LibraryTable
            tab="all"
            rows={rows}
            onRename={vi.fn()}
            onDelete={vi.fn()}
            signInAvailable={false}
            isGuest={false}
            onSignIn={vi.fn()}
            onSaveToProject={vi.fn()}
            {...overrides}
          />
        </SidebarProvider>
      </NextRouterStub>
    </QueryClientProvider>,
  );
}

// jsdom's own matchMedia stub (tests/setup/jsdom.ts) always reports matches:false, so a bare
// render already exercises the desktop <table> branch — this flips it for the phone-list branch,
// restored afterward so it never leaks into a later test in this same file.
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
  vi.unstubAllGlobals();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
});

describe("LibraryTable", () => {
  it("renders each row's title as a real link to its own route", () => {
    renderTable([baseRow(), baseRow({ id: "cmp-1", itemType: "comparison", title: "A vs B", href: "/compare/cmp-1" })]);
    expect(screen.getByRole("link", { name: "Lease.pdf" })).toHaveAttribute("href", "/documents/doc-1");
    expect(screen.getByRole("link", { name: "A vs B" })).toHaveAttribute("href", "/compare/cmp-1");
  });

  it("shows a 'Not analysed' pill only in the Documents tab's Analysis column", () => {
    renderTable([baseRow({ analysisState: "not_analyzed", processingStatus: "pending" })], { tab: "document" });
    expect(screen.getByText("Not analysed")).toBeInTheDocument();
  });

  it("shows a distinct 'Couldn't be read' pill for extraction_failed, never folded into 'Not analysed'", () => {
    renderTable([baseRow({ analysisState: "not_analyzed", processingStatus: "extraction_failed" })], { tab: "document" });
    expect(screen.getByText("Couldn't be read")).toBeInTheDocument();
    expect(screen.queryByText("Not analysed")).not.toBeInTheDocument();
  });

  it("desktop shows the draft's mode in its own Kind column", () => {
    renderTable(
      [baseRow({ id: "d1", itemType: "draft", title: "NDA draft", href: "/drafts/d1", documentType: "nda", mode: "from_scratch", revisionCount: 3 })],
      { tab: "draft" },
    );
    expect(screen.getByText("From scratch")).toBeInTheDocument();
  });

  it("phone shows the revision count in the meta line", () => {
    mockMobileViewport();
    renderTable(
      [baseRow({ id: "d1", itemType: "draft", title: "NDA draft", href: "/drafts/d1", documentType: "nda", mode: "from_scratch", revisionCount: 3 })],
      { tab: "draft" },
    );
    expect(screen.getByText((text) => text.includes("3 revisions"))).toBeInTheDocument();
  });

  // jsdom never resolves CSS specificity, so it can't prove the override actually WINS over the
  // action's own md:opacity-0 (that needs a real browser — the recaptured screenshot proves it);
  // this only proves the override class the fix depends on is really wired onto an ancestor.
  function hasAlwaysVisibleOverride(action: HTMLElement): boolean {
    for (let node: HTMLElement | null = action; node; node = node.parentElement) {
      if (node.className.includes("[&_[data-sidebar=menu-action]]:opacity-100")) return true;
    }
    return false;
  }

  it("phone drops the table header row for a plain list; the ellipsis action stays reachable at rest", () => {
    mockMobileViewport();
    renderTable([baseRow()]);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Actions for Lease.pdf" });
    expect(hasAlwaysVisibleOverride(action)).toBe(true);
  });

  it("desktop keeps the real table, with the row action's always-visible override wired up (never only on hover)", () => {
    renderTable([baseRow()]);
    expect(screen.getByRole("table")).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Actions for Lease.pdf" });
    expect(hasAlwaysVisibleOverride(action)).toBe(true);
  });

  it("the mobile meta line shows the real expiry, never the bare word 'expires'", () => {
    mockMobileViewport();
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    renderTable([baseRow({ expiresAt: soon })]);
    expect(screen.queryByText(/^expires$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Deletes in about \d+ h/)).toBeInTheDocument();
  });

  it("never renders a verification/status/spanText/claimedQuote key even if a malformed row carries one", () => {
    const malformed = { ...baseRow(), status: "verified", verification: { status: "verified" }, spanText: "should never render", claimedQuote: "also never" } as unknown as LibraryRow;
    renderTable([malformed]);
    expect(screen.queryByText("should never render")).not.toBeInTheDocument();
    expect(screen.queryByText("also never")).not.toBeInTheDocument();
    expect(screen.queryByText(/^verified$/i)).not.toBeInTheDocument();
  });

  it("has no axe violations with a populated table", async () => {
    const { container } = renderTable([baseRow(), baseRow({ id: "d2", title: "Offer.pdf", href: "/documents/d2" })]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
