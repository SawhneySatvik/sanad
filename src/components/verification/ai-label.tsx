import { GENERAL_MODE_LABEL } from "@/shared/contracts/threads";

export type AiLabelProps = { provenance: "ai_generated" | "templated" } | { generalModeLabel: typeof GENERAL_MODE_LABEL };

// Fixed literal copy, never reworded per screen — a paraphrase here would let two surfaces silently
// disagree about what "AI-generated" means. The not-legal-advice line is DisclaimerLine's job, not
// this label's; AiLabel never carries it.
const PROVENANCE_COPY = { ai_generated: "AI-generated", templated: "Fixed text" } as const;

/** The AI-generated / templated / general-mode disclosure label. Plain non-interactive text. */
export function AiLabel(props: AiLabelProps) {
  const text = "generalModeLabel" in props ? props.generalModeLabel : PROVENANCE_COPY[props.provenance];
  return <span className="inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{text}</span>;
}
