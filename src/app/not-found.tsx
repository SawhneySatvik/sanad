import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";

/**
 * A genuinely unmatched route renders only under the root layout — Next never runs a route group's
 * own layout for a path that never matched any of its segments — so this file wraps AppShell itself
 * rather than assuming (app)/layout.tsx already did. (app)/error.tsx needs no such wrapping: an
 * error thrown from inside an (app) route is still inside that segment, so its own layout already
 * ran and stays mounted around the error boundary.
 */
export default function NotFound() {
  return (
    <div
      className="flex min-h-full flex-1 flex-col"
    >
      <AppShell>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
          <h1 className="font-display text-xl font-medium">Page not found</h1>
          <p className="text-sm text-muted-foreground">This page doesn&apos;t exist, or it was deleted.</p>
          <Button asChild>
            <Link href="/chat">Go to chat</Link>
          </Button>
        </div>
      </AppShell>
    </div>
  );
}
