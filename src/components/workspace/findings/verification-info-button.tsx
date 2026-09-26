"use client";

/**
 * The badge's own info affordance — a real, independently focusable button sibling to
 * VerificationBadge, never a hover-only tooltip nested inside QuoteBlock, and never itself nested
 * inside another interactive element. Reused by FindingCard and CitationChip alike (both place this
 * outside their own primary control, per the same rule).
 */

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { VerificationOutput } from "@/shared/contracts/common";
import { verificationInfoCopy } from "./verification-info-copy";

export interface VerificationInfoButtonProps {
  status: VerificationOutput["status"];
}

export function VerificationInfoButton({ status }: VerificationInfoButtonProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="What this verification status means"
          className="relative inline-flex size-6 items-center justify-center rounded-full text-muted-foreground before:absolute before:-inset-2.5 before:content-[''] hover:text-foreground"
        >
          <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 text-sm">{verificationInfoCopy(status)}</PopoverContent>
    </Popover>
  );
}
