"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAnnounce } from "@/components/layout-primitives/live-region";

interface AppErrorProps {
  error: Error & { digest?: string; correlationId?: string };
  reset: () => void;
}

const MESSAGE = "Something went wrong. Please try again.";

/**
 * An unhandled exception inside an (app) route segment. AppShell is still mounted (this file lives
 * inside the (app) group, so its own layout stays around the boundary) — no re-import needed here.
 */
export default function AppError({ error, reset }: AppErrorProps) {
  const announce = useAnnounce();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // A route silently swapping to an error state must be announced, not just visually shown.
    announce(MESSAGE, "assertive");
    // A genuine route-segment error boundary is a real navigation-shaped event (unlike a chat
    // thread's own in-place local-to-server id swap), so the usual focus-on-heading rule applies:
    // move real keyboard focus here, not just visually show it.
    headingRef.current?.focus();
  }, [announce]);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 ref={headingRef} tabIndex={-1} className="font-display text-xl font-medium">
        Something went wrong
      </h1>
      <p className="text-sm text-muted-foreground">{MESSAGE}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button asChild>
          <Link href="/chat">Go to chat</Link>
        </Button>
      </div>
      {error.correlationId && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 font-mono text-[0.8125rem]">{error.correlationId}</p>
        </details>
      )}
    </div>
  );
}
