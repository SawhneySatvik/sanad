/** One user turn. Plain text, no special role — a visually-hidden "You said" label carries the log's per-message identity. */

export interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="sr-only">You said</span>
      <p className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">{content}</p>
    </div>
  );
}
