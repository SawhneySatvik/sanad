"use client";

/**
 * Resolves and owns the active lens for /documents/[id]/prepare. Unlike the workspace's own
 * useLensState (zero-network, history.replaceState only), a lens change here is a genuinely new
 * model call — so setSelectedLens does a real router.push, giving Back/Forward real history entries
 * to step through. The option list is derived from this document's own findings, never a client
 * import of LENS_IDS_BY_DOCUMENT_TYPE (the same rule the workspace's LensToggle already follows) —
 * resolveDefaultLens is reused rather than reimplemented, so the two screens can never quietly
 * disagree about what "the default lens" means for a given document.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { collectLensOptions, resolveDefaultLens, type LensOption } from "@/components/workspace/lens/resolve-default-lens";
import { useSituation } from "@/components/chat/use-situation";
import type { FindingOutput } from "@/shared/contracts/documents";

export interface UsePrepareLensResult {
  options: LensOption[];
  /** null only when this document's findings offer no lens at all (no documentType, or a findings
   * set with no lensExplanations — every finding a missing_clause). */
  selectedLens: string | null;
  setSelectedLens: (lens: string) => void;
}

export function usePrepareLens(
  documentId: string,
  findings: readonly FindingOutput[],
  documentType: string | null,
  initialLensParam: string | null,
): UsePrepareLensResult {
  const router = useRouter();
  const [chipRole] = useSituation();
  const options = useMemo(() => collectLensOptions(findings), [findings]);

  const [selectedLens, setSelectedLensState] = useState<string | null>(() =>
    resolveDefaultLens({ options, documentType, urlLens: initialLensParam, chipRole }),
  );

  // A bad/missing ?lens= is corrected once, silently, before any POST fires — never a pushed
  // history entry (a Back from here must not land back on the invalid URL).
  useEffect(() => {
    if (selectedLens && initialLensParam !== selectedLens) {
      router.replace(`/documents/${documentId}/prepare?lens=${encodeURIComponent(selectedLens)}`);
    }
    // Deliberately mount-only: this is a one-time correction of the URL this hook was first given,
    // never re-applied as options/documentType resolve further (they're already final by the time
    // this hook runs — see PrepareClient's own GET-gating).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSelectedLens = useCallback(
    (lens: string) => {
      setSelectedLensState(lens);
      router.push(`/documents/${documentId}/prepare?lens=${encodeURIComponent(lens)}`, { scroll: false });
    },
    [documentId, router],
  );

  return { options, selectedLens, setSelectedLens };
}
