"use client";

/**
 * This route segment's own error boundary — catches an uncaught render exception inside
 * WorkspaceClient specifically (the (app) group's own error.tsx would otherwise catch it, but one
 * level higher and with a generic "Go to chat" recovery that has no particular reason to name this
 * document). Matches (app)/error.tsx's own announce/focus pattern.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AssetPlaceholder } from "@/components/feedback/asset-placeholder";
import { Button } from "@/components/ui/button";
import { useAnnounce } from "@/components/layout-primitives/live-region";

interface DocumentWorkspaceErrorProps {
  error: Error & { digest?: string; correlationId?: string };
  reset: () => void;
}

const MESSAGE = "Something went wrong. Please try again.";

export default function DocumentWorkspaceError({ error, reset }: DocumentWorkspaceErrorProps) {
  const announce = useAnnounce();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    announce(MESSAGE, "assertive");
    headingRef.current?.focus();
  }, [announce]);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <AssetPlaceholder assetId="error-500" ratio="1 / 1" label="Something went wrong" sizePx={{ w: 160, h: 160 }} />
      <h1 ref={headingRef} tabIndex={-1} className="font-display text-xl font-medium">
        Something went wrong
      </h1>
      <p className="text-sm text-muted-foreground">{MESSAGE}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
        <Button asChild>
          <Link href="/library">Go to library</Link>
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
