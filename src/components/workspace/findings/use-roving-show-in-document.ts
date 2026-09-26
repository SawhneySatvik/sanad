"use client";

/**
 * Roving-tabindex arrow navigation between each FindingCard's "Show in document" control, scoped to
 * FindingsPane — not a global shortcut, and not the whole card
 * (the card is an <article>, never a <button>; only the primary control participates in the roving
 * set. "Test this quote" and the badge's info button are ordinary tab stops, reached by Tab from a
 * focused "Show in document", not part of this arrow-key set). WCAG 2.1.1 Keyboard: the arrow keys
 * are additive to Tab, never a replacement for it — every control here stays reachable by Tab alone.
 */

import { useCallback, useRef, useState, type KeyboardEvent, type FocusEvent } from "react";

const SELECTOR = '[data-roving="show-in-document"]';

export interface UseRovingShowInDocumentResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocusCapture: (event: FocusEvent<HTMLDivElement>) => void;
  /** 0 for the roving set's current member (or the first rendered one before any focus has landed here), -1 for every other. */
  tabIndexFor: (findingId: string, isFirstRendered: boolean) => 0 | -1;
}

export function useRovingShowInDocument(): UseRovingShowInDocumentResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rovingId, setRovingId] = useState<string | null>(null);

  const getButtons = useCallback((): HTMLButtonElement[] => {
    if (!containerRef.current) return [];
    return Array.from(containerRef.current.querySelectorAll<HTMLButtonElement>(SELECTOR));
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement;
      if (!target.matches(SELECTOR)) return;
      const buttons = getButtons();
      const index = buttons.indexOf(target as HTMLButtonElement);
      if (index === -1) return;
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      const next = buttons[nextIndex];
      next?.focus();
      setRovingId(next?.dataset.findingId ?? null);
    },
    [getButtons],
  );

  const onFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches(SELECTOR) && target.dataset.findingId) setRovingId(target.dataset.findingId);
  }, []);

  const tabIndexFor = useCallback(
    (findingId: string, isFirstRendered: boolean): 0 | -1 => {
      if (rovingId === findingId) return 0;
      if (rovingId === null && isFirstRendered) return 0;
      return -1;
    },
    [rovingId],
  );

  return { containerRef, onKeyDown, onFocusCapture, tabIndexFor };
}
