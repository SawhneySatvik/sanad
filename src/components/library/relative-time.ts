/** A coarse "just now / N min ago / N h ago / N d ago" label — shared by LibraryTable and ProjectCard. */
export function relativeTimeLabel(whenMs: number, now: number = Date.now()): string {
  const minutes = Math.round((now - whenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
