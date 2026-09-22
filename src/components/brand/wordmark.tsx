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
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary font-display text-sm font-medium text-primary-foreground"
        >
          S
        </span>
      ) : (
        <span className="font-display text-lg font-medium">Saboot</span>
      )}
    </Link>
  );
}
