"use client";

/**
 * The one place a "selection" (a FindingCard's "Show in document," a CitationChip, a VerifierDemo
 * live mark) becomes a DocumentViewer jump. DocumentViewer itself decides the null-bind
 * announcement/focus-stays behaviour (SPAN_NOT_LOCATED_ANNOUNCEMENT) — this hook only ever supplies
 * `seq` (so a repeat activation of the same finding still re-fires focus/announce), the found-case
 * announcement text, and `returnFocusTo` (the exact element Esc/"Back to finding" returns focus to,
 * captured at activation time rather than re-derived from document.activeElement, which a click
 * doesn't always leave pointing at the control that triggered it).
 */

import { useCallback, useRef, useState } from "react";
import type { DocumentViewerJump } from "@/components/document/document-viewer";

export interface JumpTarget {
  findingId: string;
  announcement: string;
  returnFocusTo: HTMLElement | null;
}

export interface UseDocumentJumpResult {
  jump: DocumentViewerJump | null;
  /** The finding id most recently jumped to — drives FindingCard/CitationChip's own "active" styling. */
  activeFindingId: string | null;
  activate: (target: JumpTarget) => void;
}

export function useDocumentJump(): UseDocumentJumpResult {
  const seqRef = useRef(0);
  const [jump, setJump] = useState<DocumentViewerJump | null>(null);
  const [activeFindingId, setActiveFindingId] = useState<string | null>(null);

  const activate = useCallback((target: JumpTarget) => {
    seqRef.current += 1;
    setActiveFindingId(target.findingId);
    setJump({
      findingId: target.findingId,
      seq: seqRef.current,
      announcement: target.announcement,
      returnFocusTo: target.returnFocusTo,
    });
  }, []);

  return { jump, activeFindingId, activate };
}
