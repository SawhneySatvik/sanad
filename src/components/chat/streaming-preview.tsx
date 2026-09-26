/**
 * The in-flight token text before `final`. Never shows a citation or badge — nothing is verified
 * before the stream completes, whatever the raw token text itself happens to contain (a hostile
 * "✓ Verified" string included — this component has no verification-rendering code path at all to
 * smuggle one through).
 */

export interface StreamingPreviewProps {
  text: string;
}

export function StreamingPreview({ text }: StreamingPreviewProps) {
  return (
    <div className="flex flex-col gap-1" data-testid="streaming-preview">
      <span className="animate-pulse text-xs font-medium text-muted-foreground motion-reduce:animate-none">Saboot is answering…</span>
      <p className="whitespace-pre-wrap text-sm text-foreground">{text}</p>
    </div>
  );
}
