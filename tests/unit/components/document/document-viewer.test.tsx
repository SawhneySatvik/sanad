import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "jest-axe";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { DocumentViewer, SPAN_NOT_LOCATED_ANNOUNCEMENT, type DocumentViewerJump } from "@/components/document/document-viewer";
import { segmentDocumentText, type BoundEntry } from "@/lib/verification/segmentDocumentText";

const TEXT = "The rent is due monthly. <script>alert(1)</script> The **deposit** is refundable.";

function renderViewer(props: Partial<React.ComponentProps<typeof DocumentViewer>> = {}) {
  return render(
    <LiveRegionProvider>
      <DocumentViewer documentId="doc-1" segments={segmentDocumentText(TEXT, [])} inputMode="text" {...props} />
    </LiveRegionProvider>,
  );
}

function politeRegionText(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? "";
}

describe("DocumentViewer — plain text only, never HTML or Markdown", () => {
  it("renders hostile <script> and markdown-looking text as literal, inert text — no real <script> element, no <strong>", () => {
    const { container } = renderViewer();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.getByRole("region")).toHaveTextContent("<script>alert(1)</script>");
    expect(screen.getByRole("region")).toHaveTextContent("**deposit**");
  });

  it("a tone: null segment renders no <mark> at all — only a bound finding gets a mark", () => {
    const bound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }];
    const { container } = renderViewer({ segments: segmentDocumentText(TEXT, bound) });
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("rent");
    // Nothing outside that one bound segment is wrapped in a mark.
    expect(container.textContent).toBe(TEXT);
  });

  it("every element under the pane is a bdi, a mark, or the Back button — nothing renders as interpreted HTML, and each bdi/mark holds only a text node", () => {
    const bound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }];
    const { container } = renderViewer({ segments: segmentDocumentText(TEXT, bound) });
    const region = container.querySelector('[aria-label="Document text"]')!;
    for (const child of Array.from(region.children)) {
      expect(["BDI", "MARK", "BUTTON"]).toContain(child.tagName);
      if (child.tagName === "BDI" || child.tagName === "MARK") {
        expect(Array.from(child.childNodes).every((n) => n.nodeType === Node.TEXT_NODE)).toBe(true);
      }
    }
  });

  it("a matched mark's textContent equals the bound spanText exactly", () => {
    const bound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }];
    const { container } = renderViewer({ segments: segmentDocumentText(TEXT, bound) });
    expect(container.querySelector("mark")).toHaveTextContent("rent");
  });

  it("has no axe violations, plain and with a bound highlight", async () => {
    const bound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "approximate" }];
    const { container } = renderViewer({ segments: segmentDocumentText(TEXT, bound) });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("DocumentViewer — the keyboard/focus path on selecting a finding", () => {
  const boundSegments = segmentDocumentText(TEXT, [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }]);

  it("a bound jump moves focus to the mark and announces the host's found-case string, politely", async () => {
    const returnFocusTo = document.createElement("button");
    document.body.appendChild(returnFocusTo);
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "Showing this obligation in the document", returnFocusTo };

    renderViewer({ segments: boundSegments, jump });

    await waitFor(() => expect(document.activeElement?.tagName).toBe("MARK"));
    expect(document.activeElement).toHaveTextContent("rent");
    await waitFor(() => expect(politeRegionText()).toBe("Showing this obligation in the document"));
  });

  it("a jump for a finding with no bound segment leaves focus alone and announces the fixed null-bind string", async () => {
    const before = document.activeElement;
    const jump: DocumentViewerJump = { findingId: "missing", seq: 1, announcement: "Showing this obligation in the document", returnFocusTo: null };

    renderViewer({ segments: boundSegments, jump });

    await waitFor(() => expect(politeRegionText()).toBe(SPAN_NOT_LOCATED_ANNOUNCEMENT));
    expect(document.activeElement).toBe(before);
    expect(document.querySelector("mark")).not.toHaveFocus();
  });

  it("Esc returns focus to the finding's own control after a bound jump", async () => {
    const user = userEvent.setup();
    const returnFocusTo = document.createElement("button");
    returnFocusTo.textContent = "Show in document";
    document.body.appendChild(returnFocusTo);
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "Showing this obligation in the document", returnFocusTo };

    renderViewer({ segments: boundSegments, jump });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MARK"));

    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(returnFocusTo);
  });

  it('the "Back to finding" control appears after a bound jump, sits after the mark, and returns focus on click', async () => {
    const user = userEvent.setup();
    const returnFocusTo = document.createElement("button");
    returnFocusTo.textContent = "Show in document";
    document.body.appendChild(returnFocusTo);
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "Showing this obligation in the document", returnFocusTo };

    renderViewer({ segments: boundSegments, jump });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MARK"));

    const back = screen.getByRole("button", { name: "Back to finding" });
    await user.click(back);
    expect(document.activeElement).toBe(returnFocusTo);
  });

  it('a custom backLabel is honoured (Compare\'s "Back to changes")', async () => {
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "Showing this change in Document A.", returnFocusTo: null };
    renderViewer({ segments: boundSegments, jump, backLabel: "Back to changes" });
    await screen.findByRole("button", { name: "Back to changes" });
  });

  it("the back control disappears once focus leaves the document pane entirely", async () => {
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "Showing this obligation in the document", returnFocusTo: null };

    renderViewer({ segments: boundSegments, jump });
    await screen.findByRole("button", { name: "Back to finding" });

    outside.focus();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Back to finding" })).not.toBeInTheDocument());
  });

  it("re-activating the SAME finding a second time (a new seq) re-fires focus and the announcement — a repeat click is not a no-op", async () => {
    const announce = { current: 0 };
    function Host() {
      const [seq, setSeq] = useState(1);
      const jump: DocumentViewerJump = { findingId: "f1", seq, announcement: `Showing this obligation in the document (${seq})`, returnFocusTo: null };
      return (
        <>
          <button onClick={() => setSeq((s) => s + 1)}>reactivate</button>
          <DocumentViewer documentId="doc-1" segments={boundSegments} inputMode="text" jump={jump} />
        </>
      );
    }
    render(
      <LiveRegionProvider>
        <Host />
      </LiveRegionProvider>,
    );
    await waitFor(() => expect(politeRegionText()).toBe("Showing this obligation in the document (1)"));
    announce.current++;

    const user = userEvent.setup();
    // Move focus off the mark first, then reactivate — a real "Show in document" click each time.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.click(screen.getByRole("button", { name: "reactivate" }));
    await waitFor(() => expect(politeRegionText()).toBe("Showing this obligation in the document (2)"));
    expect(document.activeElement?.tagName).toBe("MARK");
  });

  it("once a finding has been jumped to, its mark stays a programmatic focus target (tabindex=-1) even after a later jump lands elsewhere — but is never a Tab stop", () => {
    const twoFindingSegments = segmentDocumentText(TEXT, [
      { findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" },
      { findingId: "f2", range: { spanStart: TEXT.indexOf("script"), spanEnd: TEXT.indexOf("script") + 6, spanText: "script" }, tone: "default" },
    ]);
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "x", returnFocusTo: null };
    const { rerender, container } = render(
      <LiveRegionProvider>
        <DocumentViewer documentId="doc-1" segments={twoFindingSegments} inputMode="text" jump={jump} />
      </LiveRegionProvider>,
    );
    const marks = () => Array.from(container.querySelectorAll("mark"));
    expect(marks()[0]).toHaveAttribute("tabindex", "-1");
    expect(marks()[1]).not.toHaveAttribute("tabindex");

    rerender(
      <LiveRegionProvider>
        <DocumentViewer
          documentId="doc-1"
          segments={twoFindingSegments}
          inputMode="text"
          jump={{ findingId: "f2", seq: 2, announcement: "y", returnFocusTo: null }}
        />
      </LiveRegionProvider>,
    );
    expect(marks()[0]).toHaveAttribute("tabindex", "-1"); // f1's mark keeps it, even though f2 is now the active jump
    expect(marks()[1]).toHaveAttribute("tabindex", "-1");
  });
});

describe("DocumentViewer — the pane itself", () => {
  it("is a scroll container reachable by keyboard (tabindex=0), labelled 'Document text' by default", () => {
    renderViewer();
    const region = screen.getByRole("region", { name: "Document text" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("honours a custom label (Compare's 'Document A: <title>')", () => {
    renderViewer({ label: "Document A: lease.pdf" });
    expect(screen.getByRole("region", { name: "Document A: lease.pdf" })).toBeInTheDocument();
  });

  it("shows ScannedNotice and the persistent, non-dismissible transcription label for native_document", () => {
    renderViewer({ inputMode: "native_document" });
    expect(screen.getByText(/read from a scanned image/)).toBeInTheDocument();
    expect(screen.getByText("Transcribed from an image — not independent evidence.")).toBeInTheDocument();
  });

  it("does not show the scanned label for a text-mode document", () => {
    renderViewer({ inputMode: "text" });
    expect(screen.queryByText("Transcribed from an image — not independent evidence.")).not.toBeInTheDocument();
  });
});

describe("DocumentViewer — bidi isolation (canonical_text is byte-exact, bidi controls included)", () => {
  const RLO = "‮"; // RIGHT-TO-LEFT OVERRIDE — can visually reorder text following it
  const HOSTILE_TEXT = `Pay ${RLO}txet nedih${RLO} on time.`;

  it("a plain (unbound) segment carrying a bidi override keeps byte-exact textContent and is isolated", () => {
    const segments = segmentDocumentText(HOSTILE_TEXT, []);
    const { container } = renderViewer({ segments });
    expect(container.textContent).toBe(HOSTILE_TEXT);
    const bdi = container.querySelector("bdi");
    expect(bdi).not.toBeNull();
    expect(bdi).toHaveTextContent(HOSTILE_TEXT.replace(/\s/g, " ")); // textContent, not a visual read
    expect(bdi!.textContent).toBe(HOSTILE_TEXT);
    expect((bdi as HTMLElement).style.unicodeBidi).toBe("isolate");
  });

  it("a bound mark carrying a bidi override keeps byte-exact textContent and is isolated", () => {
    const start = HOSTILE_TEXT.indexOf(RLO);
    const end = HOSTILE_TEXT.lastIndexOf(RLO) + RLO.length;
    const spanText = HOSTILE_TEXT.slice(start, end);
    const bound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: start, spanEnd: end, spanText }, tone: "default" }];
    const { container } = renderViewer({ segments: segmentDocumentText(HOSTILE_TEXT, bound) });

    const mark = container.querySelector("mark")!;
    expect(mark.textContent).toBe(spanText);
    expect(mark.style.unicodeBidi).toBe("isolate");
    expect(container.textContent).toBe(HOSTILE_TEXT);
  });
});

describe("DocumentViewer — a null bindSpan() result never reaches this component as a mark", () => {
  it("a finding the host's own bindSpan() rejected is simply absent from segments — nothing to render as a mark for it", () => {
    // The host is expected to filter bindSpan()'s null results out before calling
    // segmentDocumentText(), so this proves DocumentViewer renders correctly when handed exactly
    // that already-filtered input: the unbound finding contributes no BoundEntry, so it produces no
    // segment and no mark at all.
    const onlyOneOfTwoFindingsBound: BoundEntry[] = [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }];
    const { container } = renderViewer({ segments: segmentDocumentText(TEXT, onlyOneOfTwoFindingsBound) });
    expect(container.querySelectorAll("mark")).toHaveLength(1);
  });
});

describe("DocumentViewer — the pulse is a one-shot flash on the jumped-to mark, not a lasting style", () => {
  const boundSegments = segmentDocumentText(TEXT, [{ findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "rent" }, tone: "default" }]);

  it("a jump pulses its mark, and the pulse reverts on its own after the hold window elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const jump: DocumentViewerJump = { findingId: "f1", seq: 1, announcement: "x", returnFocusTo: null };
    const { container } = renderViewer({ segments: boundSegments, jump });

    expect(container.querySelector("mark")).toHaveAttribute("data-active", "true");
    await vi.advanceTimersByTimeAsync(1000);
    expect(container.querySelector("mark")).not.toHaveAttribute("data-active");
    vi.useRealTimers();
  });

  it("activeFindingId marks the current finding as an informational data attribute only — it does not itself pulse the mark", () => {
    const { container } = renderViewer({ segments: boundSegments, activeFindingId: "f1" });
    const mark = container.querySelector("mark")!;
    expect(mark).toHaveAttribute("data-current-finding", "true");
    expect(mark).not.toHaveAttribute("data-active");
  });
});

describe("DocumentViewer — overlapping findings: a jump covers the whole quote, not just its first rendered piece", () => {
  // A=[0,20), B=[10,30) overlap on [10,20) — segmentDocumentText cuts three pieces: [0,10) A-only,
  // [10,20) A+B, [20,30) B-only. A's own full quote is the first two; B's is the last two.
  const OVERLAP_TEXT = "abcdefghijklmnopqrstuvwxyzABCD";
  const overlapSegments = segmentDocumentText(OVERLAP_TEXT, [
    { findingId: "A", range: { spanStart: 0, spanEnd: 20, spanText: OVERLAP_TEXT.slice(0, 20) }, tone: "default" },
    { findingId: "B", range: { spanStart: 10, spanEnd: 30, spanText: OVERLAP_TEXT.slice(10, 30) }, tone: "default" },
  ]);

  it("jumping to A (the earlier finding) focuses its first piece, pulses both of its pieces, spares B's own piece, and sits the Back control after A's LAST piece — not mid-quote", async () => {
    const jump: DocumentViewerJump = { findingId: "A", seq: 1, announcement: "x", returnFocusTo: null };
    const { container } = render(
      <LiveRegionProvider>
        <DocumentViewer documentId="doc-1" segments={overlapSegments} inputMode="text" jump={jump} />
      </LiveRegionProvider>,
    );

    await waitFor(() => expect(document.activeElement?.tagName).toBe("MARK"));
    const marks = Array.from(container.querySelectorAll("mark"));
    expect(marks).toHaveLength(3);
    expect(document.activeElement).toBe(marks[0]); // [0,10) — the start of A's own quote

    expect(marks[0]).toHaveAttribute("data-active", "true"); // [0,10) — A only
    expect(marks[1]).toHaveAttribute("data-active", "true"); // [10,20) — A+B, still part of A's quote
    expect(marks[2]).not.toHaveAttribute("data-active"); // [20,30) — B only, no part of A's quote

    const back = screen.getByRole("button", { name: "Back to finding" });
    expect(back.previousElementSibling).toBe(marks[1]); // after A's LAST piece, never between marks[0] and marks[1]
  });

  it("jumping to B (the later finding) mirrors the same rule on the other finding", async () => {
    const jump: DocumentViewerJump = { findingId: "B", seq: 1, announcement: "x", returnFocusTo: null };
    const { container } = render(
      <LiveRegionProvider>
        <DocumentViewer documentId="doc-1" segments={overlapSegments} inputMode="text" jump={jump} />
      </LiveRegionProvider>,
    );

    await waitFor(() => expect(document.activeElement?.tagName).toBe("MARK"));
    const marks = Array.from(container.querySelectorAll("mark"));
    expect(document.activeElement).toBe(marks[1]); // [10,20) — the start of B's own quote

    expect(marks[0]).not.toHaveAttribute("data-active"); // [0,10) — A only, no part of B's quote
    expect(marks[1]).toHaveAttribute("data-active", "true"); // [10,20) — A+B, part of B's quote
    expect(marks[2]).toHaveAttribute("data-active", "true"); // [20,30) — B only, still part of B's quote

    const back = screen.getByRole("button", { name: "Back to finding" });
    expect(back.previousElementSibling).toBe(marks[2]); // after B's LAST piece
  });
});
