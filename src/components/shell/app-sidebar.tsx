"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import {
  FilePen,
  Files,
  FolderKanban,
  GitCompare,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/layout-primitives/theme-toggle";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { useSession, SESSION_FAILURE_NOTICE } from "@/lib/session/use-session";
import { notifySessionChanged } from "@/lib/session/sync";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import { RecentsList } from "./recents-list";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/library", label: "Library", icon: Files },
  { href: "/compare", label: "Compare", icon: GitCompare },
  { href: "/drafts/new", label: "Draft", icon: FilePen },
  // Projects is a plain link — no flyout, no expando listing individual projects.
  { href: "/projects", label: "Projects", icon: FolderKanban },
] as const;

function CollapseToggle({ compact = false }: { compact?: boolean }) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <Button
      variant="ghost"
      size={compact ? "icon-sm" : "icon"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      onClick={toggleSidebar}
      // Button's own default ring-offset assumes the main content surface — every instance of it
      // rendered on the sidebar's own (differently-toned) surface needs this override instead.
      className="hidden md:inline-flex focus-visible:ring-offset-sidebar"
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

function AccountRow() {
  const session = useSession();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  if (session.isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  if (session.isError) {
    return (
      <div className="flex flex-col gap-2">
        <InlineNotice tone="warning">{SESSION_FAILURE_NOTICE}</InlineNotice>
        <Button variant="outline" size="sm" className="focus-visible:ring-offset-sidebar" onClick={() => session.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const { kind, displayName, signInAvailable } = session.data;

  if (kind === "user") {
    return (
      <Button
        variant="ghost"
        className="w-full justify-start focus-visible:ring-offset-sidebar"
        onClick={async () => {
          try {
            await apiFetch("/api/session/sign-out", { method: "POST" });
            await notifySessionChanged(queryClient);
            setOpenMobile(false);
          } catch (err) {
            // The session cookie may still be intact server-side — surfacing this rather than
            // silently leaving the sidebar showing "Sign out" for a request that never landed.
            toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
          }
        }}
      >
        <span className="truncate">{displayName ?? "Signed in"}</span>
        <span className="ml-auto text-muted-foreground">Sign out</span>
      </Button>
    );
  }

  if (!signInAvailable) return null;

  return (
    <SidebarMenuButton asChild isActive={pathname === "/sign-in"} onClick={() => setOpenMobile(false)}>
      <Link href="/sign-in" aria-current={pathname === "/sign-in" ? "page" : undefined}>
        Sign in
      </Link>
    </SidebarMenuButton>
  );
}

/** Wordmark, "New chat," primary nav, RecentsList, account/theme/settings footer. */
export function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile, state } = useSidebar();
  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <nav aria-label="Primary" className="flex h-full min-h-0 flex-col">
        <SidebarHeader>
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <Wordmark collapsed={false} />
            <CollapseToggle />
          </div>
          <Button asChild className="h-10 w-full focus-visible:ring-offset-sidebar">
            <Link href="/chat" onClick={closeMobile}>
              New chat
            </Link>
          </Button>
        </SidebarHeader>

        <SidebarContent>
          <SidebarMenu className="px-2">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton asChild isActive={active} tooltip={label} onClick={closeMobile}>
                    <Link href={href} aria-current={active ? "page" : undefined}>
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>

          <RecentsList />
        </SidebarContent>

        <SidebarFooter>
          <AccountRow />
          <div className="flex items-center justify-between gap-1">
            <ThemeToggle />
            <SidebarMenuButton
              asChild
              isActive={pathname === "/settings"}
              tooltip="Settings"
              onClick={closeMobile}
              className="flex-1"
            >
              <Link href="/settings" aria-current={pathname === "/settings" ? "page" : undefined}>
                <SettingsIcon aria-hidden="true" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
            {/* The header's own toggle already reaches expand/collapse; this footer twin is only
                worth the extra control once collapsed, when the header row has no room to spare. */}
            {state === "collapsed" && <CollapseToggle compact />}
          </div>
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
