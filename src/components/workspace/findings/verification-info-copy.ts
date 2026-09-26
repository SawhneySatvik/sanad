/**
 * The badge's own info-button copy — prose *about* each status, never the bare label itself (the
 * architecture test that keeps VerificationBadge the sole renderer of the exact word "Verified"
 * scans every file under src/components/**, this one included).
 */

import type { VerificationOutput } from "@/shared/contracts/common";

const INFO_COPY: Record<VerificationOutput["status"], string> = {
  verified: "This exact wording was found, word for word, in your document.",
  approximate: "Saboot found similar wording nearby, but not an exact match.",
  not_found: "Saboot couldn't find this wording anywhere in your document.",
};

export function verificationInfoCopy(status: VerificationOutput["status"]): string {
  return INFO_COPY[status];
}
