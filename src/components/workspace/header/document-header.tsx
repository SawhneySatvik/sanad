"use client";

/**
 * The right pane's own header (desktop) / the base document view's top bar (phone) — the direction
 * contract's FIRST VIEWPORT is explicit that the title/type/"Viewing as" live in the right pane on
 * desktop, not above the document column; the Phone layout section keeps it visible on the base view
 * instead of burying it inside the sheet.
 */

import { forwardRef } from "react";
import Link from "next/link";
import type { AnalysisOutput, DocumentOutput } from "@/shared/contracts/documents";
import type { LensOption } from "../lens/resolve-default-lens";
import { LensToggle } from "../lens/lens-toggle";
import { AnalysedByNote } from "./analysed-by-note";
import { DocumentMenu } from "./document-menu";
import { documentTypeIcon } from "./document-type-icons";
import { PREPARE_LABEL, COMPARE_LABEL, DRAFT_REPLY_LABEL } from "../copy";

export interface DocumentHeaderProps {
  document: DocumentOutput;
  analysis: AnalysisOutput | null;
  lensOptions: readonly LensOption[];
  activeLens: string | null;
  onLensChange: (lens: string) => void;
  signInAvailable: boolean;
  isGuest: boolean;
  /** Phone has no room for a dedicated Prepare/Compare/Draft row above the fold — those three move
   * into DocumentMenu's own ••• menu instead of this header's body. Desktop keeps the row. */
  isDesktop: boolean;
}

/**
 * `ref` lands on the `<h1>` itself — the App Router doesn't reset focus on a client-side navigation
 * by default, so the workspace's own mount effect moves real keyboard focus here.
 */
export const DocumentHeader = forwardRef<HTMLHeadingElement, DocumentHeaderProps>(function DocumentHeader(
  { document, analysis, lensOptions, activeLens, onLensChange, signInAvailable, isGuest, isDesktop },
  headingRef,
) {
  const TypeIcon = documentTypeIcon(document.documentType);
  const prepareHref = `/documents/${document.id}/prepare${activeLens ? `?lens=${encodeURIComponent(activeLens)}` : ""}`;
  const compareHref = `/compare?a=${encodeURIComponent(document.id)}`;
  const draftHref = `/drafts/new?grounding=${encodeURIComponent(document.id)}`;

  return (
    <header className="flex flex-col gap-3 border-b border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <TypeIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          {/* focus-visible:outline-none is scoped to this one element on purpose: tabIndex={-1}
              means it can never become a real Tab stop, so the only way it ever receives focus is
              the route-entry mount effect below moving it there programmatically. Chromium's own
              :focus-visible heuristic still paints a ring for that first-paint, no-prior-interaction
              case, which reads as a stray box around the title rather than a keyboard user's own
              focus outline — suppressing it here loses nothing a keyboard user could otherwise see,
              since they can never land here by tabbing. */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="min-w-0 truncate font-display text-lg font-medium text-foreground focus-visible:outline-none"
          >
            {document.title}
          </h1>
        </div>
        <DocumentMenu
          documentId={document.id}
          title={document.title}
          signInAvailable={signInAvailable}
          isGuest={isGuest}
          phoneLinks={
            isDesktop
              ? undefined
              : [
                  { label: PREPARE_LABEL, href: prepareHref },
                  { label: COMPARE_LABEL, href: compareHref },
                  { label: DRAFT_REPLY_LABEL, href: draftHref },
                ]
          }
        />
      </div>

      {lensOptions.length > 0 && activeLens && <LensToggle options={lensOptions} value={activeLens} onChange={onLensChange} />}

      {isDesktop && (
        <div className="flex flex-wrap gap-2">
          <Link href={prepareHref} prefetch={false} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {PREPARE_LABEL}
          </Link>
          <Link href={compareHref} prefetch={false} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {COMPARE_LABEL}
          </Link>
          <Link href={draftHref} prefetch={false} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            {DRAFT_REPLY_LABEL}
          </Link>
        </div>
      )}

      {analysis && <AnalysedByNote modelUsed={analysis.modelUsed} sampleId={document.sampleId} />}
    </header>
  );
});
