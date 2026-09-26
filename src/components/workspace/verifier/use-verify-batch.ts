"use client";

/**
 * "Try to fool the verifier." Debounces POST /api/verify-batch at >=600ms idle, one request
 * in flight at a time (a newer edit supersedes rather than queues), every request sequence-tagged so
 * a stale response for since-edited text is discarded, never rendered. The badge shown is always
 * exactly `results[0]` from a response whose own request text still equals the field's current
 * value at the moment it lands — never a client-computed status (the One Guarantee's UI half).
 *
 * The badge/field-text pairing is the guarantee this hook exists to hold: `lastChecked` is the only
 * {text, result} pair ever shown together. While typing (phase "checking") no badge renders at all,
 * even if a prior lastChecked exists — a badge must never sit beside text that hasn't itself been
 * checked in the last 600ms. On a 403/429/500, "the field reverts to its last known status" is read
 * literally: the field's own text is restored to lastChecked's text (discarding the edit that
 * triggered the error), so the badge shown afterward is never paired with text that was never
 * actually checked. With no prior lastChecked, an error shows no badge at all.
 *
 * The client-side soft cap is a different case, handled as its own "throttled" phase rather than
 * folded into "error": no request was ever sent, so there is nothing the server disagreed with and
 * nothing to revert — the field's own text stays exactly as typed, phase just leaves "checking" (so
 * no badge renders, satisfying the same never-stale-badge rule) with an honest message, and a single
 * retry is armed for the moment the rolling window frees up. A later edit's own debounce timer
 * supersedes that armed retry the same way it supersedes an ordinary one.
 *
 * Never mutates the stored finding: this hook only ever writes its own local state, never
 * `['documents', id]`'s cache.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetchJson, ApiError } from "@/lib/api";
import { canonicalErrorMessage } from "@/lib/copy/errors";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { VERIFY_BATCH_MAX_QUOTE_CHARS, type VerifyBatchOutput } from "@/shared/contracts/verify-batch";
import type { VerificationOutput } from "@/shared/contracts/common";
import { verificationInfoCopy } from "../findings/verification-info-copy";
import { VERIFIER_TOO_LONG_MESSAGE } from "../copy";

export type VerifierPhase = "checking" | "result" | "error" | "too-long" | "throttled";

export interface UseVerifyBatchResult {
  text: string;
  setText: (text: string) => void;
  phase: VerifierPhase;
  /** The pair currently safe to render together — null until the first successful check lands. */
  lastChecked: { text: string; result: VerificationOutput } | null;
  errorMessage: string | null;
}

const DEBOUNCE_MS = 600;
// Leaves headroom under the server's shared 60/min-per-IP route budget — a soft, best-effort
// ceiling on this one control alone, not a substitute for the server's own limit.
const SOFT_CAP_PER_MINUTE = 20;
const SOFT_CAP_WINDOW_MS = 60_000;
const SOFT_CAP_MESSAGE = "Too many checks in a minute — try again shortly";

function isOverCap(text: string): boolean {
  return text.length > VERIFY_BATCH_MAX_QUOTE_CHARS;
}

export function useVerifyBatch(documentId: string, initialText: string): UseVerifyBatchResult {
  const [text, setTextState] = useState(initialText);
  // Computed directly from the seed, never assigned via an effect: the seeded text (spanText for an
  // approximate finding) was never itself checked, so this never starts on a stale "result" phase.
  const [phase, setPhase] = useState<VerifierPhase>(() => (isOverCap(initialText) ? "too-long" : "checking"));
  const [lastChecked, setLastChecked] = useState<UseVerifyBatchResult["lastChecked"]>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(() => (isOverCap(initialText) ? VERIFIER_TOO_LONG_MESSAGE : null));
  const announce = useAnnounce();

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestTimestampsRef = useRef<number[]>([]);
  // Mirrors lastChecked without waiting for the next render — the error branch below needs the
  // freshest value synchronously, and reading state set earlier in the very same call would be stale.
  const lastCheckedRef = useRef<UseVerifyBatchResult["lastChecked"]>(null);
  // The "latest callback" ref pattern — kept in sync by its own effect below, right after runCheck
  // itself is (re)created. The throttled reschedule reads through this ref rather than closing over
  // `runCheck` by name, since a setTimeout callback created inside runCheck's own body can only ever
  // see the identity that existed at that call, never a later one the memoization might produce; the
  // effect always commits well before any such timeout can fire.
  const runCheckRef = useRef<(candidateText: string) => Promise<void>>(async () => {});

  const runCheck = useCallback(
    async (candidateText: string) => {
      const now = Date.now();
      requestTimestampsRef.current = requestTimestampsRef.current.filter((t) => now - t < SOFT_CAP_WINDOW_MS);
      if (requestTimestampsRef.current.length >= SOFT_CAP_PER_MINUTE) {
        setErrorMessage(SOFT_CAP_MESSAGE);
        setPhase("throttled");
        // Reuses timerRef (not a second ref) on purpose: setText's own clearTimeout already
        // supersedes this the instant a further edit arrives, exactly like an ordinary debounce.
        const oldest = requestTimestampsRef.current[0];
        const waitMs = Math.max(0, oldest + SOFT_CAP_WINDOW_MS - now);
        timerRef.current = setTimeout(() => void runCheckRef.current(candidateText), waitMs);
        return;
      }
      requestTimestampsRef.current.push(now);

      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await apiFetchJson<VerifyBatchOutput>("/api/verify-batch", {
          method: "POST",
          json: { citations: [{ documentId, quote: candidateText }] },
          signal: controller.signal,
        });
        if (seq !== seqRef.current) return; // superseded by a later edit — never rendered
        const [next] = response.results;
        if (!next) return;
        const pair = { text: candidateText, result: next };
        lastCheckedRef.current = pair;
        setLastChecked(pair);
        setPhase("result");
        announce(verificationInfoCopy(next.status), "polite");
      } catch (err) {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        // "Reverts to its last known status": the field's own text goes back with it, so a badge
        // never renders beside text that was never itself checked. No prior success -> no badge.
        if (lastCheckedRef.current) setTextState(lastCheckedRef.current.text);
        setErrorMessage(err instanceof ApiError ? canonicalErrorMessage(err.code, { retryAfterSeconds: err.retryAfterSeconds }) : "Something went wrong. Please try again.");
        setPhase("error");
      }
    },
    [documentId, announce],
  );
  useEffect(() => {
    runCheckRef.current = runCheck;
  }, [runCheck]);

  const setText = useCallback(
    (next: string) => {
      setTextState(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();

      if (isOverCap(next)) {
        setPhase("too-long");
        setErrorMessage(VERIFIER_TOO_LONG_MESSAGE);
        return;
      }
      setErrorMessage(null);
      setPhase("checking");
      timerRef.current = setTimeout(() => void runCheck(next), DEBOUNCE_MS);
    },
    [runCheck],
  );

  // Schedules the first check for the seeded text too (see the file header) — never a direct
  // setState call in the effect body itself, only starting the same debounce timer setText's own
  // typing path uses; `phase`/`errorMessage`'s initial values above already reflect the seed.
  // StrictMode's double-invoke is harmless: a second timer is cleared by this same cleanup before it
  // could ever fire twice.
  useEffect(() => {
    if (isOverCap(initialText)) return;
    timerRef.current = setTimeout(() => void runCheck(initialText), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
    // Only the mount-time seed matters; a parent re-render must never restart the debounce mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { text, setText, phase, lastChecked, errorMessage };
}
