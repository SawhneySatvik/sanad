import Link from "next/link";

export interface WordmarkProps {
  /** The icon-only mark when the sidebar is the icon rail. */
  collapsed?: boolean;
}

/** "Saboot," links to /chat. No logo asset — the mark is set in code. */
export function Wordmark({ collapsed = false }: WordmarkProps) {
  return (
    <Link href="/chat" aria-label="Saboot, home" className="inline-flex items-center gap-2 text-foreground">
      {collapsed ? (
        <span
          aria-hidden="true"
          // Not a filled brand-accent tile — the collapsed rail sits next to a lot of other icons,
          // and a solid --primary square there reads as a nav/action button rather than the mark.
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground font-display text-sm font-medium text-background"
        >
          S
        </span>
      ) : (
        <span className="font-display text-xl font-medium tracking-[-0.01em]">Saboot</span>
      )}
    </Link>
  );
}
