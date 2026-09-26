import { LEGAL_ADVICE_COPY } from "@/shared/copy/legal-advice";

export interface DisclaimerLineProps {
  variant?: "footer" | "composer";
}

/** The exact wording is fixed; exported so a test can pin the literal string in one place. */
export const DISCLAIMER_TEXT = LEGAL_ADVICE_COPY.short;

/** One quiet line under every composer, and in the app footer area. */
export function DisclaimerLine({ variant = "composer" }: DisclaimerLineProps) {
  return <p className={variant === "footer" ? "text-center text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>{DISCLAIMER_TEXT}</p>;
}
