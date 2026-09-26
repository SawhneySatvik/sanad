// Split out from export-menu.tsx so a test can mock this one call — jsdom's own Clipboard API
// implementation resists being stubbed directly (its `navigator.clipboard` accessor doesn't honour
// a test-time override the way a plain module import does).
export function writeToClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
