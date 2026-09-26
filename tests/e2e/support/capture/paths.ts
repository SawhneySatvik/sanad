import path from "node:path";
import type { ThemeOption } from "./types";

export type ViewportName = "desktop" | "phone";

export interface ViewportSpec {
  name: ViewportName;
  width: number;
  height: number;
  isMobile: boolean;
}

// Matches playwright.config.ts's own four projects exactly, so a capture and an e2e spec of the
// same screen are never comparing different viewports.
export const VIEWPORTS: ViewportSpec[] = [
  { name: "desktop", width: 1440, height: 900, isMobile: false },
  { name: "phone", width: 390, height: 844, isMobile: true },
];

export const THEMES: ThemeOption[] = ["light", "dark"];

/** `<outDir>/<screen>/<state>-<viewport>-<theme>.png`. */
export function screenshotPath(outDir: string, screen: string, state: string, viewport: ViewportName, theme: ThemeOption): string {
  return path.join(outDir, screen, `${state}-${viewport}-${theme}.png`);
}
