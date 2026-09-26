import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { RevisionTimeline } from "@/components/draft/revision-timeline";
import type { DraftRevisionEntry } from "@/components/draft/types";

// tests/setup/jsdom.ts stubs window.matchMedia to always report matches:false (the phone shape) —
// this file's own desktop-mode tests need the (min-width: 1024px) query to report true instead, so
// each one restores the original stub afterward rather than leaking a desktop-only matchMedia into
// every other suite that shares this same jsdom global.
let originalMatchMedia: typeof window.matchMedia;

function mockDesktopViewport(): void {
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: query === "(min-width: 1024px)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

function revision(overrides: Partial<DraftRevisionEntry>): DraftRevisionEntry {
  return {
    id: "rev-0",
    parentDraftId: null,
    revisionNumber: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    modelUsed: "gemini-2.5-flash",
    userInstructions: "Draft the first version",
    isCurrent: false,
    isLatest: false,
    ...overrides,
  };
}

describe("RevisionTimeline — renders oldest to newest, aria-current, branch notes (desktop: inline)", () => {
  beforeEach(mockDesktopViewport);
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  const chain: DraftRevisionEntry[] = [
    revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    revision({
      id: "rev-2",
      parentDraftId: "rev-1",
      revisionNumber: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
      isCurrent: true,
      isLatest: true,
    }),
  ];

  it("marks the isCurrent entry with aria-current=true", () => {
    const { container } = render(<RevisionTimeline revisions={chain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    const current = container.querySelector('[aria-current="true"]');
    expect(current).not.toBeNull();
    expect(current).toHaveTextContent("Revision 2");
  });

  it("hides 'Go to latest' when the current entry is already the latest", () => {
    render(<RevisionTimeline revisions={chain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Go to latest" })).not.toBeInTheDocument();
  });

  it("shows 'Go to latest' when the loaded revision isn't the chain's latest, and it navigates to whichever entry has isLatest — never merely the last array item", () => {
    // A deliberately reordered, 3-entry fixture where the isLatest entry is NOT last in the array —
    // this is the one shape that would fail a naive "array.at(-1)" implementation while still
    // passing a correct one that reads `isLatest` off each entry directly.
    const reordered: DraftRevisionEntry[] = [
      revision({ id: "rev-3", parentDraftId: "rev-2", revisionNumber: 3, createdAt: "2026-01-03T00:00:00.000Z", isLatest: true }),
      revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      revision({ id: "rev-2", parentDraftId: "rev-1", revisionNumber: 2, createdAt: "2026-01-02T00:00:00.000Z", isCurrent: true }),
    ];
    const onGoToLatest = vi.fn();
    render(<RevisionTimeline revisions={reordered} onSelectRevision={vi.fn()} onGoToLatest={onGoToLatest} />);

    const goToLatest = screen.getByRole("button", { name: "Go to latest" });
    fireEvent.click(goToLatest);
    expect(onGoToLatest).toHaveBeenCalledTimes(1);

    // Rendered order is still oldest-to-newest regardless of the fixture's own array order.
    const revisionButtons = screen.getAllByRole("button").filter((el) => el.textContent?.startsWith("Revision"));
    expect(revisionButtons.map((el) => el.textContent?.slice(0, "Revision 1".length))).toEqual(["Revision 1", "Revision 2", "Revision 3"]);
  });

  it("hides 'Go to latest' when the current entry is isLatest even though it ISN'T the temporally-last entry — the one fixture a client-side createdAt comparison gets wrong", () => {
    // A clock-skewed pair: rev-2 (isLatest, isCurrent) has an EARLIER createdAt than rev-1's own
    // later timestamp. Sorting by createdAt (which this component's own render order still does)
    // puts rev-1 last in the rendered list, but rev-2 is still the real isLatest/isCurrent entry —
    // any implementation that infers "is this the latest" from array/timestamp position instead of
    // reading the isLatest flag itself would wrongly show "Go to latest" here.
    const skewed: DraftRevisionEntry[] = [
      revision({ id: "rev-2", parentDraftId: "rev-1", revisionNumber: 2, createdAt: "2026-01-01T00:00:00.000Z", isCurrent: true, isLatest: true }),
      revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    render(<RevisionTimeline revisions={skewed} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Go to latest" })).not.toBeInTheDocument();
  });

  it("shows a 'from revision N' note only on an entry that branches off a non-immediate parent", () => {
    const branched: DraftRevisionEntry[] = [
      revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
      revision({ id: "rev-2", parentDraftId: "rev-1", revisionNumber: 2, createdAt: "2026-01-02T00:00:00.000Z" }),
      // A sibling of rev-2, branching from rev-1 again — not the entry immediately before it.
      revision({
        id: "rev-2b",
        parentDraftId: "rev-1",
        revisionNumber: 2,
        createdAt: "2026-01-03T00:00:00.000Z",
        isCurrent: true,
        isLatest: true,
      }),
    ];
    render(<RevisionTimeline revisions={branched} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(screen.getByText("from revision 1")).toBeInTheDocument();
  });

  it("shows 'Instructions not recorded' for a legacy entry whose userInstructions is null", () => {
    const legacyChain: DraftRevisionEntry[] = [
      revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z", userInstructions: null }),
      revision({
        id: "rev-2",
        parentDraftId: "rev-1",
        revisionNumber: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
        userInstructions: "shorten the notice period",
        isCurrent: true,
        isLatest: true,
      }),
    ];
    render(<RevisionTimeline revisions={legacyChain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(screen.getByText("Instructions not recorded")).toBeInTheDocument();
    expect(screen.getByText("shorten the notice period")).toBeInTheDocument();
  });

  it("clicking a non-current entry calls onSelectRevision with that entry's id", () => {
    const onSelectRevision = vi.fn();
    render(<RevisionTimeline revisions={chain} onSelectRevision={onSelectRevision} onGoToLatest={vi.fn()} />);
    fireEvent.click(screen.getByText("Revision 1").closest("button")!);
    expect(onSelectRevision).toHaveBeenCalledWith("rev-1");
  });

  it("has no axe violations", async () => {
    const { container } = render(<RevisionTimeline revisions={chain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("RevisionTimeline — phone: collapses behind a 'Revisions (N)' trigger", () => {
  // No mockDesktopViewport() override here — tests/setup/jsdom.ts's own stub already reports
  // matches:false for every query, the phone shape this screen asks for.
  const chain: DraftRevisionEntry[] = [
    revision({ id: "rev-1", parentDraftId: null, revisionNumber: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    revision({
      id: "rev-2",
      parentDraftId: "rev-1",
      revisionNumber: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
      isCurrent: true,
      isLatest: true,
    }),
  ];

  it("shows exactly one 'Revisions (N)' trigger, no inline list, until opened", () => {
    render(<RevisionTimeline revisions={chain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Revisions (2)" })).toBeInTheDocument();
    expect(screen.queryByText("Revision 1")).not.toBeInTheDocument();
  });

  it("opens the sheet, revealing exactly one aria-current entry — never a second, hidden inline copy", () => {
    render(<RevisionTimeline revisions={chain} onSelectRevision={vi.fn()} onGoToLatest={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revisions (2)" }));
    expect(screen.getAllByText("Revision 2")).toHaveLength(1);
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });
});
