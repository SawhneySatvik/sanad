/**
 * "Delete all my data" clears every saboot:*-prefixed localStorage key this or any other product
 * surface writes — a blanket prefix sweep, not a hand-maintained list, so a future `saboot:layout:*`
 * key a later surface adds is cleared too without this file needing an update.
 * next-themes' own key ("theme") carries no `saboot:` prefix, so it survives untouched by
 * construction — a display preference, not user content.
 */
export function clearSabootLocalStorage(): void {
  if (typeof window === "undefined") return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith("saboot:")) keysToRemove.push(key);
  }
  for (const key of keysToRemove) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best effort — a mid-sweep quota/permission error still leaves every key already removed gone.
    }
  }
}
