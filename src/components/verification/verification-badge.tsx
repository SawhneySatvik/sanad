import { BadgeCheck, CircleDashed, SearchX, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { VerificationOutput } from "@/shared/contracts/common";

export interface VerificationBadgeProps {
  verification: VerificationOutput;
}

interface StatusMeta {
  Icon: LucideIcon;
  label: string;
  tone: string;
}

// Reserved to this file (and globals.css, which only defines the token): see
// tests/architecture/verified-badge-single-source.verify.test.ts. Icon choice: approximate reads
// "close, not exact" without borrowing verified's solid check; not_found reads "could not find,"
// never "error" (never CircleX/TriangleAlert, which read as risk).
const STATUS_META: Record<VerificationOutput["status"], StatusMeta> = {
  verified: { Icon: BadgeCheck, label: "Verified", tone: "bg-verified-surface text-verified" },
  approximate: { Icon: CircleDashed, label: "Approximate", tone: "bg-approximate-surface text-approximate" },
  not_found: { Icon: SearchX, label: "Not found in your document", tone: "bg-not-found-surface text-not-found" },
};

/**
 * The only component that may render the verified mark: an icon plus the server-derived status,
 * never a clickable trigger of its own (so it composes safely inside CitationChip's chip button or
 * QuoteBlock's <blockquote> without becoming a second nested control). Structurally unforgeable —
 * driven solely by `verification.status`, never by any text a model could have written, so a
 * claimedQuote reading "[VERIFIED]" or "✓ Verified" rendered nearby (QuoteBlock) can never produce
 * this icon or this exact label. WCAG 1.4.1 Use of Color: every status renders its own icon and
 * label text — `tone` colours the badge but is never the only distinguishing cue.
 */
export function VerificationBadge({ verification }: VerificationBadgeProps) {
  const { Icon, label, tone } = STATUS_META[verification.status];
  return (
    <Badge
      variant="outline"
      data-slot="verification-badge"
      data-verification-status={verification.status}
      className={cn("gap-1 border-transparent px-2 py-0.5", tone)}
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
      {label}
    </Badge>
  );
}
