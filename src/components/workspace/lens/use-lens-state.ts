"use client";

/**
 * The active lens, kept out of TanStack Query and Next's router entirely so a switch is genuinely
 * zero-network (workspace.lens-switch-is-free): `router.replace`/`push` re-runs the route's own data
 * fetching, which this screen's own "zero network calls between switches" gate would catch. The URL
 * is still kept in sync — a reload, a shared link, and the "Prepare" deep link all read it — via a
 * raw `history.replaceState`, which never triggers Next's own navigation machinery.
 *
 * The remembered SituationChips role (the app's own default-lens precedence, step two of three) has
 * no producer yet — that chip lives in the chat home's own surface, not built at the time this file
 * was written. Passing null here falls through to the document type's own first lens until that
 * lands; wiring the real remembered value is a one-line change once it exists (read the same
 * localStorage key the chat surface defines, not a second one this file invents).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { collectLensOptions, resolveDefaultLens, type LensOption } from "./resolve-default-lens";
import type { FindingOutput } from "@/shared/contracts/documents";

export interface UseLensStateResult {
  options: LensOption[];
  activeLens: string | null;
  setActiveLens: (lens: string) => void;
}

function replaceLensQueryParam(lens: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("lens", lens);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function useLensState(findings: readonly FindingOutput[], documentType: string | null, initialLensParam: string | null): UseLensStateResult {
  const options = useMemo(() => collectLensOptions(findings), [findings]);
  // Set only by an explicit setActiveLens call — until then, the resolved default tracks the
  // findings/documentType as they arrive (they load asynchronously; this hook is first called
  // before GET /api/documents/:id resolves, with an empty options array).
  const [userChoice, setUserChoice] = useState<string | null>(null);

  const resolvedDefault = useMemo(
    () => resolveDefaultLens({ options, documentType, urlLens: initialLensParam, chipRole: null }),
    [options, documentType, initialLensParam],
  );

  const activeLens = userChoice ?? resolvedDefault;

  const setActiveLens = useCallback((lens: string) => {
    setUserChoice(lens);
    replaceLensQueryParam(lens);
  }, []);

  // An invalid ?lens= (present in the URL but not among this document's own options) is corrected
  // in the address bar via replaceState, once options are known — never a pushed history entry, so
  // a back-navigation from here doesn't land back on the invalid url.
  useEffect(() => {
    if (userChoice) return;
    if (options.length === 0) return;
    if (initialLensParam && resolvedDefault && resolvedDefault !== initialLensParam) {
      replaceLensQueryParam(resolvedDefault);
    }
  }, [userChoice, options.length, initialLensParam, resolvedDefault]);

  return { options, activeLens, setActiveLens };
}
