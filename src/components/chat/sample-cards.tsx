"use client";

/**
 * "Try a sample" cards. onOpen calls POST /api/samples/:sampleId/open, which returns
 * {documentId} only — the host then reads the sample through the ordinary, always-re-verify
 * GET /api/documents/:id, never trusting a richer body from the open call itself (a sample is
 * server data re-checked the same way any other document is, never a shortcut around verify()).
 * This component owns no network call itself; the host passes back per-card state (opening/error)
 * once it knows it. Compact cards — a document-type glyph and a one-line gist, never a grey image
 * slot standing in for art that doesn't exist yet.
 */

import { Briefcase, Fingerprint, FileSignature, Home, Lock, type LucideIcon } from "lucide-react";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { canonicalErrorMessage, type CanonicalErrorCode } from "@/lib/copy/errors";
import { Card } from "@/components/ui/card";
import type { SampleId, SampleSummary } from "./catalogue";

// One glyph per document type — never a check/shield-check shape, which would read as this
// screen's own verification claim rather than a plain document-type icon.
const SAMPLE_ICON: Record<SampleId, LucideIcon> = {
  lease: Home,
  offer_letter: FileSignature,
  nda: Lock,
  privacy_policy: Fingerprint,
  freelance: Briefcase,
};

export interface SampleCardError {
  code: CanonicalErrorCode;
  retryAfterSeconds?: number;
}

export interface SampleCardsProps {
  samples: readonly SampleSummary[];
  onOpen: (sampleId: string) => void;
  /** The sampleId whose open call is currently in flight — that card alone shows a spinner. */
  openingSampleId?: string | null;
  errors?: Partial<Record<string, SampleCardError>>;
  /** Every card disables (same treatment as the composer) when there's no connection to open one with. */
  disabled?: boolean;
}

function SampleCardError({ error }: { error: SampleCardError }) {
  if (error.code === "RATE_LIMITED") return <RetryAfterNotice kind="RATE_LIMITED" retryAfterSeconds={error.retryAfterSeconds} />;
  return <p className="text-xs text-destructive">{canonicalErrorMessage(error.code)}</p>;
}

export function SampleCards({ samples, onOpen, openingSampleId, errors, disabled }: SampleCardsProps) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">Or try a sample document</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {samples.map((sample) => {
          const opening = openingSampleId === sample.sampleId;
          const error = errors?.[sample.sampleId];
          const Icon = SAMPLE_ICON[sample.sampleId];
          return (
            <Card key={sample.sampleId} size="sm" className="gap-2 p-3">
              <button
                type="button"
                disabled={disabled || Boolean(openingSampleId)}
                aria-label={sample.accessibleName}
                onClick={() => onOpen(sample.sampleId)}
                className="flex w-full flex-col items-start gap-1.5 text-left disabled:opacity-60"
              >
                <Icon aria-hidden="true" className="size-5 text-muted-foreground" strokeWidth={1.75} />
                <span className="text-sm font-medium text-foreground">{sample.label}</span>
                <span className="text-xs text-muted-foreground">{sample.gist}</span>
                {opening && <span className="text-xs text-muted-foreground">Opening…</span>}
              </button>
              {error && <SampleCardError error={error} />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
