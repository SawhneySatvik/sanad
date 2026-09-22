"use client";

import { useEffect, useState } from "react";
import { formatRetryTime } from "@/lib/format/retry-time";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";

export interface RetryAfterNoticeProps {
  retryAfterSeconds?: number;
  kind: "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE";
}

// The canonical error-copy table's fixed prefix each kind keeps regardless of whether a usable
// retry time is available.
const PREFIX: Record<RetryAfterNoticeProps["kind"], string> = {
  RATE_LIMITED: "You've reached your limit for now.",
  UPSTREAM_UNAVAILABLE: "The AI providers are busy right now.",
};

const FALLBACK_SUFFIX: Record<RetryAfterNoticeProps["kind"], string> = {
  RATE_LIMITED: "Try again in a little while.",
  UPSTREAM_UNAVAILABLE: "Try again in a few minutes.",
};

function hasUsableRetryTime(seconds: number | undefined): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

function messageFor(kind: RetryAfterNoticeProps["kind"], seconds: number | undefined): string {
  const suffix = hasUsableRetryTime(seconds) ? `Try again in ${formatRetryTime(seconds)}.` : FALLBACK_SUFFIX[kind];
  return `${PREFIX[kind]} ${suffix}`;
}

/** Countdown/retry copy for 429/503, cited from the one canonical error-copy table. */
export function RetryAfterNotice({ retryAfterSeconds, kind }: RetryAfterNoticeProps) {
  const initialRemaining = hasUsableRetryTime(retryAfterSeconds) ? Math.round(retryAfterSeconds) : undefined;
  const [remaining, setRemaining] = useState(initialRemaining);
  // React's own "adjusting state when a prop changes" pattern (a direct setState call during
  // render, not inside an effect) — a fresh countdown for a genuinely new retryAfterSeconds value,
  // without the extra render+flicker an effect-based reset would cost.
  const [trackedRetryAfterSeconds, setTrackedRetryAfterSeconds] = useState(retryAfterSeconds);
  if (retryAfterSeconds !== trackedRetryAfterSeconds) {
    setTrackedRetryAfterSeconds(retryAfterSeconds);
    setRemaining(initialRemaining);
  }

  // Announced once on appearance, from whatever the retry time was at mount — never re-announced
  // as the visual countdown ticks down each second.
  const [initialMessage] = useState(() => messageFor(kind, retryAfterSeconds));
  useAnnounceOnMount(initialMessage, "assertive");

  useEffect(() => {
    if (!hasUsableRetryTime(retryAfterSeconds)) return;
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev === undefined || prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfterSeconds]);

  return <p className="text-sm text-foreground">{messageFor(kind, remaining)}</p>;
}
