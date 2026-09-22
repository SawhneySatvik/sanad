"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";

/**
 * Every route group's shared client-side context, mounted once at the root: theme, server-state
 * cache, tooltips, toasts and the standing live regions. A single Toaster/live-region pair here
 * already satisfies "mounted once" for the whole route tree — no route group needs its own copy.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Created inside useState's lazy initializer, not at module scope: a module-scoped client would
  // be shared across requests on the server, leaking one visitor's cached data into another's.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider attribute="class" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <LiveRegionProvider>
            {children}
            <Toaster />
          </LiveRegionProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
