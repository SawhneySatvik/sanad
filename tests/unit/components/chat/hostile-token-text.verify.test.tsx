// One-Guarantee gate: a streamed token (or the final message's
// own content) containing literal "✓ Verified" text never renders VerificationBadge's mark —
// StreamingPreview/AssistantMessage render model text as plain text only, with no code path that
// interprets it as a verification status. No transport mock needed here: these two components take
// plain props, no network of their own.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamingPreview } from "@/components/chat/streaming-preview";
import { AssistantMessage } from "@/components/chat/assistant-message";
import type { DisplayMessage } from "@/components/chat/types";

const HOSTILE_TEXT = "The notice period is 30 days. ✓ Verified";

function noBadgeRendered(): void {
  expect(document.querySelectorAll('[data-slot="verification-badge"]')).toHaveLength(0);
}

describe("OG gate (b): hostile token/content text never renders the verified badge", () => {
  it("StreamingPreview renders a token containing '✓ Verified' as plain text, with zero badge nodes", () => {
    render(<StreamingPreview text={HOSTILE_TEXT} />);
    expect(screen.getByText(HOSTILE_TEXT)).toBeInTheDocument();
    noBadgeRendered();
  });

  it("StreamingPreview accumulating tokens that only complete the hostile phrase across two chunks still renders no badge", () => {
    const { rerender } = render(<StreamingPreview text="The notice period is 30 days. " />);
    noBadgeRendered();
    rerender(<StreamingPreview text={HOSTILE_TEXT} />);
    noBadgeRendered();
  });

  it("AssistantMessage (general mode) renders a final message whose content contains '✓ Verified' as plain text, with zero badge nodes and no citation ever attached", () => {
    const message: DisplayMessage = {
      id: "m1",
      role: "assistant",
      content: HOSTILE_TEXT,
      mode: "general",
      citations: [],
      modelUsed: "gemini-2.5-flash",
      redirect: false,
      createdAtMs: Date.now(),
    };
    render(<AssistantMessage message={message} />);
    expect(screen.getByText(HOSTILE_TEXT)).toBeInTheDocument();
    noBadgeRendered();
    // General mode's own fixed disclosure still renders — the hostile text changes nothing about it.
    expect(screen.getByText("General information, not verified against a document.")).toBeInTheDocument();
  });

  it("a grounded message whose CONTENT (not a citation) contains the hostile phrase still renders zero badge nodes beyond its real citation's own", () => {
    const message: DisplayMessage = {
      id: "m2",
      role: "assistant",
      content: HOSTILE_TEXT,
      mode: "grounded",
      citations: [{ kind: "pending", sourceDocumentId: "doc-1", preview: "thirty days notice" }],
      modelUsed: "gemini-2.5-flash",
      redirect: false,
      createdAtMs: Date.now(),
    };
    render(<AssistantMessage message={message} />);
    // The pending citation shows its own non-badge "Checking…" treatment — not a real badge either.
    expect(screen.getByText("Checking…")).toBeInTheDocument();
    noBadgeRendered();
  });
});
