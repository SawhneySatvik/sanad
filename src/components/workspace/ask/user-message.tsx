import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";

export interface UserMessageProps {
  content: string;
}

/** A user's own turn — plain text, never re-parsed as markup. */
export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
      <bdi style={BIDI_ISOLATE_STYLE}>{content}</bdi>
    </div>
  );
}
