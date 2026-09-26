/**
 * This route's own height, shared by both layout branches (desktop's ResizableWorkspaceSplit and
 * phone's root). AppShell's SidebarInset is `h-svh overflow-hidden`, and the content wrapper it
 * mounts every route's children into (`[data-slot="app-shell-content"]`) is
 * `flex min-h-0 flex-1 flex-col overflow-y-auto` — a real, definite height computed by flex, not a
 * bare `min-height` floor. `h-full` here consumes that height directly; `min-h-0` lets this flex
 * item shrink below its own content's natural height, which is what lets the internal
 * `overflow-y-auto` panes (ResizableWorkspaceSplit's Panels; the phone column below) do the
 * scrolling instead of the ancestor wrapper. A `dvh`-anchored estimate of AppShell's own chrome
 * (the mobile top bar, its footer) used to stand in here before AppShell gave routes a real height
 * of their own — that estimate also silently assumed a footer disclaimer line this route never
 * renders (AppShell suppresses it on /documents/*, this screen carries its own instead) and never
 * accounted for OfflineBanner/the guest session-failure notice, both of which flex-1 absorbs for
 * free without this route having to know they exist.
 */
export const WORKSPACE_HEIGHT_CLASS = "h-full min-h-0";
