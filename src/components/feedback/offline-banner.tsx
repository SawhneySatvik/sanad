"use client";

import { useIsOffline } from "@/lib/api/offline-status";
import { OFFLINE_MESSAGE } from "@/lib/copy/errors";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { Alert, AlertDescription } from "@/components/ui/alert";

function Announcement() {
  // A fresh component instance per offline transition (mounted only while OfflineBanner itself
  // renders, below) — its own useAnnounceOnMount ref naturally resets each time, so each
  // transition announces once.
  useAnnounceOnMount(OFFLINE_MESSAGE, "assertive");
  return null;
}

/**
 * The standing "you're offline" chrome banner. Renders full-width, pushing content down rather
 * than overlaying it — callers compose it above their own content, this component itself has no
 * positioning opinion beyond that.
 */
export function OfflineBanner() {
  const offline = useIsOffline();
  if (!offline) return null;

  return (
    <Alert role="note" className="rounded-none border-x-0 border-t-0">
      <Announcement />
      <AlertDescription>{OFFLINE_MESSAGE}</AlertDescription>
    </Alert>
  );
}
