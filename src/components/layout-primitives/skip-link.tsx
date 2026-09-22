/**
 * Visually hidden until focused, so a keyboard/screen-reader user reaches it first on every route
 * without a sighted user ever seeing it — jumping straight past the sidebar to the route's own
 * content.
 */
export function SkipLink({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg"
    >
      Skip to main content
    </a>
  );
}
