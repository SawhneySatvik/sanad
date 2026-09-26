import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";

export interface StreamingPreviewProps {
  text: string;
}

/** Unlabelled token text as it arrives — replaced by AssistantMessage once `final` lands. */
export function StreamingPreview({ text }: StreamingPreviewProps) {
  return (
    <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
      <bdi style={BIDI_ISOLATE_STYLE}>{text}</bdi>
    </div>
  );
}
