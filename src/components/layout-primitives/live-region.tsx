"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type Politeness = "polite" | "assertive";

/**
 * One of the app's two standing live regions. A visually-hidden node whose text content an
 * assistive technology reads aloud whenever it changes — never a `role`, which would make it a
 * second, differently-labelled region a screen reader announces twice.
 */
export function LiveRegion({ politeness, message }: { politeness: Politeness; message: string }) {
  return (
    <div aria-live={politeness} aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}

interface AnnounceContextValue {
  announce: (message: string, politeness?: Politeness) => void;
}

const AnnounceContext = createContext<AnnounceContextValue | null>(null);

/** The announce() helper any component can call — never talks to the DOM directly itself. */
export function useAnnounce(): AnnounceContextValue["announce"] {
  const ctx = useContext(AnnounceContext);
  if (!ctx) throw new Error("useAnnounce must be called within a LiveRegionProvider");
  return ctx.announce;
}

/**
 * Mounts both standing regions unconditionally, so a later announce() always has somewhere to
 * land. A live region only fires on an actual text change — re-announcing the same message twice
 * in a row (for example, the same "Showing this obligation in the document" on a second jump to
 * the same finding) needs a clear-then-set, or the second call is silently a no-op. WCAG 4.1.3
 * Status Messages: this is the one mechanism a status update reaches assistive tech through
 * without moving focus.
 */
export function LiveRegionProvider({ children }: { children: ReactNode }) {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const pendingTimeouts = useRef<Partial<Record<Politeness, ReturnType<typeof setTimeout>>>>({});

  const announce = useCallback((message: string, politeness: Politeness = "polite") => {
    const setMessage = politeness === "assertive" ? setAssertiveMessage : setPoliteMessage;
    const pending = pendingTimeouts.current[politeness];
    if (pending) clearTimeout(pending);
    setMessage("");
    pendingTimeouts.current[politeness] = setTimeout(() => setMessage(message), 0);
  }, []);

  return (
    <AnnounceContext.Provider value={{ announce }}>
      {children}
      <LiveRegion politeness="polite" message={politeMessage} />
      <LiveRegion politeness="assertive" message={assertiveMessage} />
    </AnnounceContext.Provider>
  );
}

/**
 * The "announce once on appearance" pattern several feedback components share (OfflineBanner,
 * InlineNotice, ErrorState, RetryAfterNotice all mount conditionally on their own trigger
 * condition, and each wants exactly one announcement per occurrence, not one per render). A ref,
 * not the effect's dependency array, is what keeps it to once: React's Strict Mode double-invokes
 * an effect on the same mount, and the array alone can't tell that replay apart from a real second
 * occurrence — the ref remembers "already announced" across the replay but resets on a genuine
 * unmount/remount. An empty message is a no-op: a sibling component composed alongside this one
 * (RetryAfterNotice inside ErrorState, for instance) may own the real announcement itself, and
 * announcing "" would still clear-and-reset the shared live region, stepping on that sibling's
 * pending announcement.
 */
export function useAnnounceOnMount(message: string, politeness: Politeness = "polite"): void {
  const announce = useAnnounce();
  const announced = useRef(false);

  useEffect(() => {
    if (announced.current || !message) return;
    announced.current = true;
    announce(message, politeness);
  }, [announce, message, politeness]);
}
