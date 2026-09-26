// Pass/fail rules for a single capture, pulled out of runner.ts so they can be red-proven without
// booting a browser or a server.

import type { ViewportName } from "./paths";

// Calibrated by measuring one line of body text on the app's own themed background against a
// solid-colour page, at both viewports: desktop measured ~5.85KB blank vs ~12.3KB with the text,
// phone ~2.74KB blank vs ~8.86KB with the text. Each floor sits below every "with text" measurement
// and comfortably above every blank one. Phone's own floor is lower than desktop's because a
// phone-width solid-colour PNG compresses smaller to begin with, not because phone content is
// expected to be sparser.
export const MIN_BYTES_BY_VIEWPORT: Record<ViewportName, number> = {
  desktop: 7_000,
  phone: 4_000,
};

export function isTooSmall(byteLength: number, minBytes: number): boolean {
  return byteLength < minBytes;
}

export function isThemeIdentical(light: Buffer, dark: Buffer): boolean {
  return light.equals(dark);
}
