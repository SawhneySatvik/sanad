"use client";

/**
 * The inline "Sign in to keep this" nudge at a value-capture moment. Built here for the upload
 * flow's own second-upload trigger; the shape is generic (context/onSignIn) on purpose, so the
 * sidebar's guest "Save to project" and other value-capture moments elsewhere in the app can reuse
 * this same component rather than each building their own, even though it currently lives in an
 * upload-specific directory.
 *
 * Never a modal, never role="alert" — announces once through the assertive LiveRegion instead,
 * matching OfflineBanner/InlineNotice. Per-session dismissible, never persisted.
 */

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { SIGN_IN_NUDGE_COPY } from "./copy";

export interface SignInNudgeProps {
  context: "save" | "second_upload" | "claim";
  onSignIn: () => void;
}

export function SignInNudge({ context, onSignIn }: SignInNudgeProps) {
  const [dismissed, setDismissed] = useState(false);
  const message = SIGN_IN_NUDGE_COPY[context];

  // A fresh mount per genuine occurrence (the caller controls whether this renders at all) — the
  // ref inside useAnnounceOnMount keeps a Strict Mode double-invoke from announcing twice, and
  // dismissal here is a local unmount-equivalent, not a second announceable state.
  useAnnounceOnMount(dismissed ? "" : message, "assertive");

  if (dismissed) return null;

  return (
    <Alert role="note" className="items-start gap-3">
      <AlertDescription className="flex flex-1 items-center justify-between gap-3">
        <span>{message}</span>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" onClick={onSignIn}>
            Sign in
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="relative before:absolute before:-inset-3 before:content-['']"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
