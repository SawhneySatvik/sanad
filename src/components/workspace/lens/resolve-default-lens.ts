/**
 * Pure lens-resolution logic — no DOM, no fetch, so the precedence rule (URL > remembered chip role
 * > the document type's first lens) is unit-testable against a plain findings array instead of a
 * running page. `LensToggle`'s own option list is derived from the open document's findings, never
 * the server lens registry — a lens this document's own analysis never used can't appear as an
 * option no matter what the registry knows about.
 */

import { LENS_STAGES, LENS_IDS_BY_DOCUMENT_TYPE, type LensStage } from "@/shared/lens-labels";
import type { FindingOutput } from "@/shared/contracts/documents";

export interface LensOption {
  id: string;
  role: string;
  stage: LensStage;
}

/** Splits `${role}_${stage}` back into its parts — stage is always one of exactly two literals. */
export function parseLensId(id: string): LensOption | null {
  for (const stage of LENS_STAGES) {
    const suffix = `_${stage}`;
    if (id.endsWith(suffix)) {
      const role = id.slice(0, -suffix.length);
      if (role.length === 0) return null;
      return { id, role, stage };
    }
  }
  return null;
}

/** Every lens id this document's own findings actually used, deduped, in first-seen order. */
export function collectLensOptions(findings: readonly FindingOutput[]): LensOption[] {
  const seen = new Set<string>();
  const options: LensOption[] = [];
  for (const finding of findings) {
    for (const explanation of finding.lensExplanations) {
      if (seen.has(explanation.lens)) continue;
      const parsed = parseLensId(explanation.lens);
      if (!parsed) continue; // a malformed id from a future server change is dropped, never rendered raw
      seen.add(explanation.lens);
      options.push(parsed);
    }
  }
  return options;
}

export interface ResolveDefaultLensInput {
  options: readonly LensOption[];
  documentType: string | null;
  /** A valid id present in `options` wins over everything else. An invalid one is treated as absent. */
  urlLens?: string | null;
  /** The remembered SituationChips role (tenant/employee/freelancer), if any. */
  chipRole?: string | null;
}

/**
 * Precedence, first match wins: a valid `?lens=`; then the remembered chip role, if it has a
 * matching lens for this document's own options; then the document type's own first lens (read
 * from the shared table, so LensToggle and Prepare agree on "first" without a server round-trip).
 * Returns null only when there is no lens to switch between at all.
 */
export function resolveDefaultLens(input: ResolveDefaultLensInput): string | null {
  const { options, documentType, urlLens, chipRole } = input;
  if (options.length === 0) return null;

  if (urlLens && options.some((option) => option.id === urlLens)) return urlLens;

  if (chipRole) {
    const match = options.find((option) => option.role === chipRole);
    if (match) return match.id;
  }

  const firstOfType = documentType ? LENS_IDS_BY_DOCUMENT_TYPE[documentType]?.[0] : undefined;
  if (firstOfType && options.some((option) => option.id === firstOfType.id)) return firstOfType.id;

  return options[0].id;
}
