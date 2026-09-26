"use client";

/**
 * The guest retention notice — reads guestTtlHours off the caller's already-fetched session query,
 * never a hard-coded number, so this can't drift from the server's real guest-data TTL. Renders
 * only while a guest's session is actually resolved: no notice, and no guessed/default number,
 * while it's still loading or failed, and none at all for a signed-in user.
 */

import { InlineNotice } from "@/components/feedback/inline-notice";
import { guestRetentionNoticeText } from "./copy";

export interface UploadRetentionNoticeProps {
  isSignedIn: boolean;
  /** Undefined while ['session'] is still loading or has failed — renders nothing in either case. */
  guestTtlHours?: number;
}

export function UploadRetentionNotice({ isSignedIn, guestTtlHours }: UploadRetentionNoticeProps) {
  if (isSignedIn || guestTtlHours === undefined) return null;
  return <InlineNotice tone="info">{guestRetentionNoticeText(guestTtlHours)}</InlineNotice>;
}
