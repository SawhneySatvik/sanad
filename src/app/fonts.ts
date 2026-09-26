// Every face, applied once as CSS variables on <html>: dialogs, sheets, menus and toasts portal
// into <body>, outside any route group's wrapper, so a variable scoped lower than <html> leaves
// them on the system font. latin-ext is preloaded on the two faces that render money figures
// (findings, quotes, comparison changes) on first paint.

import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Devanagari, Literata, Source_Serif_4 } from "next/font/google";

export const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-source-serif",
  display: "swap",
});

export const plexSans = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

export const devanagari = IBM_Plex_Sans_Devanagari({
  subsets: ["devanagari"],
  weight: ["400", "500", "600"],
  variable: "--font-devanagari",
  preload: false, // only fetched once Devanagari text is actually on the page
  display: "swap",
});

export const literata = Literata({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  variable: "--font-literata",
  display: "swap",
});

export const plexMono = IBM_Plex_Mono({
  subsets: ["latin"], // correlation ids/hashes only, never currency — no latin-ext preload need
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});
