/**
 * One DraftSectionOutput. Renders `provenance` via AiLabel only — never a VerificationBadge, since a
 * draft carries no verified status at all: there is no span/quote data on a draft section for a
 * badge to even bind against. `content` is plain text, `white-space: pre-wrap`, never Markdown,
 * never dangerouslySetInnerHTML.
 */

import { AiLabel } from "@/components/verification/ai-label";
import type { DraftSectionOutput } from "@/shared/contracts/drafts";

export interface DraftSectionProps {
  section: DraftSectionOutput;
}

export function DraftSection({ section }: DraftSectionProps) {
  return (
    <section className="flex flex-col gap-2 border-b border-border pb-6 last:border-b-0 last:pb-0" aria-labelledby={`draft-section-heading-${section.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`draft-section-heading-${section.key}`} className="font-display text-lg font-medium text-foreground">
          {section.heading}
        </h2>
        <AiLabel provenance={section.provenance} />
      </div>
      <p className="whitespace-pre-wrap font-reading text-base text-foreground">{section.content}</p>
    </section>
  );
}
