/**
 * "Try a sample" catalogue: a static client-side constant, never fetched — no `GET /api/samples`
 * listing endpoint exists (only `POST /api/samples/:sampleId/open`). Pinned by a parity unit test
 * against src/server/samples/registry.ts's exported SAMPLE_IDS (an exact match, never merely a
 * superset — the registry's own ids are duplicated here as a literal, not imported, since a client
 * bundle must never pull in server code).
 *
 * assetId follows the art manifest's own hyphenated convention and is deliberately independent of
 * sampleId's underscored one — a manifest rename never silently breaks a card's art lookup.
 */

export type SampleId = "lease" | "offer_letter" | "nda" | "privacy_policy" | "freelance";

/** Mirrors src/server/samples/registry.ts's SAMPLE_IDS exactly — order is display order. */
export const SAMPLE_IDS: readonly SampleId[] = ["lease", "offer_letter", "nda", "privacy_policy", "freelance"];

export interface SampleSummary {
  sampleId: SampleId;
  assetId: string;
  label: string;
  /** Full accessible name for the card's button — e.g. "Try a sample: leave-and-license agreement". */
  accessibleName: string;
  /** One line naming what the sample actually shows — the card's own gist, shown under its label
   * instead of a placeholder image. Hand-written to match this catalogue's own label/sampleId, not
   * imported from src/server/samples/registry.ts (a client bundle never pulls in server code). */
  gist: string;
}

export const SAMPLE_CATALOGUE: readonly SampleSummary[] = [
  {
    sampleId: "lease",
    assetId: "sample-lease",
    label: "Leave & License Agreement",
    accessibleName: "Try a sample: leave-and-license agreement",
    gist: "A residential rental agreement — rent, deposit and notice period.",
  },
  {
    sampleId: "offer_letter",
    assetId: "sample-offer-letter",
    label: "Job Offer Letter",
    accessibleName: "Try a sample: job offer letter",
    gist: "A job offer — role, compensation and probation terms.",
  },
  {
    sampleId: "nda",
    assetId: "sample-nda",
    label: "Non-Disclosure Agreement",
    accessibleName: "Try a sample: non-disclosure agreement",
    gist: "A mutual confidentiality agreement between two parties.",
  },
  {
    sampleId: "privacy_policy",
    assetId: "sample-privacy-policy",
    label: "Privacy Policy",
    accessibleName: "Try a sample: privacy policy",
    gist: "What an app or website collects, and how it's used.",
  },
  {
    sampleId: "freelance",
    assetId: "sample-freelance",
    label: "Freelance Service Agreement",
    accessibleName: "Try a sample: freelance service agreement",
    gist: "A freelance contract — scope, payment and timeline.",
  },
];

export type SituationRole = "tenant" | "employee" | "freelancer" | "other";

/** Selecting a role surfaces its most relevant sample first; "other"/no chip leaves the baseline order untouched. */
const FIRST_SAMPLE_BY_ROLE: Partial<Record<SituationRole, SampleId>> = {
  tenant: "lease",
  employee: "offer_letter",
  freelancer: "freelance",
};

export function orderedSamples(role: SituationRole | null): readonly SampleSummary[] {
  const firstId = role ? FIRST_SAMPLE_BY_ROLE[role] : undefined;
  if (!firstId) return SAMPLE_CATALOGUE;
  const first = SAMPLE_CATALOGUE.find((s) => s.sampleId === firstId);
  if (!first) return SAMPLE_CATALOGUE;
  return [first, ...SAMPLE_CATALOGUE.filter((s) => s.sampleId !== firstId)];
}
