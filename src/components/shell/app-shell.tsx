"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { SkipLink } from "@/components/layout-primitives/skip-link";
import { OfflineBanner } from "@/components/feedback/offline-banner";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { Wordmark } from "@/components/brand/wordmark";
import { useSession, SESSION_FAILURE_NOTICE } from "@/lib/session/use-session";
import { useSessionBroadcastListener } from "@/lib/session/use-session-broadcast-listener";
import { AppSidebar } from "./app-sidebar";
import { useSidebarCollapsed } from "./use-sidebar-collapsed";

const MAIN_CONTENT_ID = "main-content";

// 264px expanded / 56px collapsed rail — shadcn's own Sidebar defaults (16rem / 3rem) are close but
// not these exact figures, so this app's own values win via the same CSS custom properties the
// vendored component already reads.
const SIDEBAR_WIDTH_VARS = {
  "--sidebar-width": "264px",
  "--sidebar-width-icon": "56px",
} as CSSProperties;

function MobileTopBar() {
  const { setOpenMobile } = useSidebar();
  return (
    <div className="flex h-14 items-center gap-2 border-b border-border px-4 md:hidden">
      <Button variant="ghost" size="icon" className="size-11" aria-label="Open menu" onClick={() => setOpenMobile(true)}>
        <Menu aria-hidden="true" className="size-5" />
      </Button>
      <Wordmark />
    </div>
  );
}

/**
 * The sidebar's own session-failure notice (AccountRow) sits inside the phone drawer, closed by
 * default — a phone visitor would never see it without opening the menu first. Mirrors
 * OfflineBanner's own slot (same position, same push-content-down behaviour) so this failure is
 * visible immediately instead.
 */
function MobileSessionFailureNotice() {
  const { isMobile } = useSidebar();
  const session = useSession();
  if (!isMobile || !session.isError) return null;

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <InlineNotice tone="warning">{SESSION_FAILURE_NOTICE}</InlineNotice>
      <div>
        <Button variant="outline" size="sm" onClick={() => session.refetch()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * The chrome every (app) route mounts inside. Providers.tsx already mounts LiveRegionProvider, the
 * Toaster and TooltipProvider at the root — this component must never mount a second copy of any of
 * them, or the live-region allow-list gate sees extra nodes it doesn't expect.
 *
 * Height contract for a route's own top-level element: this shell gives the region between the
 * mobile top bar and the footer a *definite* height (an `h-svh` main, `min-h-0` down the chain) —
 * a route that renders a full-height split (the workspace, later chat) can render `h-full` at its
 * own root and rely on that being real pixels, managing its own internal scrolling per pane, and
 * must never rely on the page/document itself scrolling. A route that's plain document flow
 * (settings, library) needs no special height handling at all: the wrapper div right below already
 * carries `overflow-y-auto`, so ordinary content taller than the viewport scrolls there exactly as
 * it would with no height constraint at all. The mobile top bar, offline banner and footer sit
 * outside that scrollable wrapper on purpose — fixed chrome a full-height route's own `h-full` calc
 * never has to account for, and a persistent bar a document-flow route's readers never lose track of
 * while scrolling past it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const pathname = usePathname();
  useSessionBroadcastListener();

  // /chat and /documents/[id] carry their own DisclaimerLine next to their own composer — this
  // chrome-level footer would otherwise repeat the exact same sentence a second time on those
  // routes. The <footer> landmark itself still always mounts (one of the app's three standing
  // landmarks), just without a disclaimer inside it there.
  const routeHasOwnDisclaimer =
    pathname === "/chat" || Boolean(pathname?.startsWith("/chat/")) || Boolean(pathname?.startsWith("/documents/"));

  return (
    <SidebarProvider open={!collapsed} onOpenChange={(open) => setCollapsed(!open)} style={SIDEBAR_WIDTH_VARS}>
      <SkipLink targetId={MAIN_CONTENT_ID} />
      <AppSidebar />
      <SidebarInset id={MAIN_CONTENT_ID} tabIndex={-1} className="h-svh overflow-hidden">
        <MobileTopBar />
        <OfflineBanner />
        <MobileSessionFailureNotice />
        <div data-slot="app-shell-content" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
        <footer className={routeHasOwnDisclaimer ? undefined : "border-t border-border px-4 py-2.5"}>
          {!routeHasOwnDisclaimer && <DisclaimerLine variant="footer" />}
        </footer>
      </SidebarInset>
    </SidebarProvider>
  );
}
