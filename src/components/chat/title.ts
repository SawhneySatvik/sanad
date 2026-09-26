/** A signed-in thread needs a title the instant it's created, before any answer exists to summarize — the opening query itself is the only text available yet. */

const MAX_DERIVED_TITLE_CHARS = 60;

export function deriveTitle(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) return "New chat";
  return trimmed.length > MAX_DERIVED_TITLE_CHARS ? `${trimmed.slice(0, MAX_DERIVED_TITLE_CHARS).trimEnd()}…` : trimmed;
}
