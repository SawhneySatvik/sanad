export interface DisclaimerLineProps {
  variant?: "footer" | "composer";
}

/** The exact wording is fixed; exported so a test can pin the literal string in one place. */
export const DISCLAIMER_TEXT = "Saboot explains documents. It isn't legal advice.";

/** One quiet line under every composer, and in the app footer area. */
export function DisclaimerLine({ variant = "composer" }: DisclaimerLineProps) {
  return <p className={variant === "footer" ? "text-center text-xs text-muted-foreground" : "text-xs text-muted-foreground"}>{DISCLAIMER_TEXT}</p>;
}
