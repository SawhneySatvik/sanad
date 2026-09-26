"use client";

/**
 * The app-wide session hook every screen defers to for `signInAvailable`/`kind`. `staleTime:
 * Infinity` because nothing here changes except through an explicit invalidation (sign-in,
 * sign-out, claim, delete-all) — polling would just be wasted requests. `retry: false` because the
 * session-failure notice ("Try again") is meant to appear on the first failure — the default
 * client-wide retry count would silently hold the sidebar's skeleton open for several seconds of
 * exponential backoff before a user ever sees the failure or the retry action.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import { SessionOutput } from "@/shared/contracts/session";

export const SESSION_QUERY_KEY = ["session"] as const;

/** One canonical sentence, reused everywhere a failed session fetch needs to say so — the sidebar
 * footer, Settings' own Data section and the phone top-bar's own copy of it — so the three never
 * drift into slightly different wording for the same condition. */
export const SESSION_FAILURE_NOTICE = "We couldn't check your session, so some features are hidden.";

/** Exported so sync.ts's post-clear() refetch uses the exact same fetch, not a second copy of it. */
export async function fetchSession(): Promise<SessionOutput> {
  return apiFetchJson<SessionOutput>("/api/session");
}

export function useSession(): UseQueryResult<SessionOutput> {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * A failed session fetch is a first-class state, never an error boundary escape hatch: every
 * signed-in/nudge affordance treats `signInAvailable` as false rather than holding a skeleton open
 * forever waiting on a response that already failed.
 */
export function sessionSignInAvailable(session: UseQueryResult<SessionOutput>): boolean {
  if (session.isError) return false;
  return session.data?.signInAvailable ?? false;
}

/** Which sign-in form the client should show, mirroring sessionSignInAvailable's own "error reads as unavailable" rule. */
export function sessionSignInMethod(session: UseQueryResult<SessionOutput>): "dev" | "email" | null {
  if (session.isError) return null;
  return session.data?.signInMethod ?? null;
}
