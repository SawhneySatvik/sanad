import { describe, expect, it, vi } from "vitest";
import RootLayout, { viewport } from "@/app/layout";

// next/font/google only works inside Next's compiler; the layout needs just each face's variable class.
vi.mock("next/font/google", () => {
  const face = (name: string) => () => ({ variable: `font-${name}`, className: name });
  return {
    Source_Serif_4: face("source-serif"),
    IBM_Plex_Sans: face("plex-sans"),
    IBM_Plex_Sans_Devanagari: face("devanagari"),
    Literata: face("literata"),
    IBM_Plex_Mono: face("plex-mono"),
  };
});

describe("RootLayout", () => {
  it("sets lang=\"en\" and suppressHydrationWarning on <html> (next-themes' own documented requirement)", () => {
    const element = RootLayout({ children: <p>content</p> });
    expect(element.props.lang).toBe("en");
    expect(element.props.suppressHydrationWarning).toBe(true);
  });

  it("puts every face's variable on <html>, so content portalled into <body> uses the same faces", () => {
    const element = RootLayout({ children: <p>content</p> });
    for (const face of ["source-serif", "plex-sans", "devanagari", "literata", "plex-mono"]) {
      expect(element.props.className).toContain(`font-${face}`);
    }
  });

  it("renders the given children inside <body>", () => {
    const element = RootLayout({ children: <p>marker-content</p> });
    // <body><Providers>{children}</Providers></body> — Providers is the one child of <body>.
    const body = element.props.children;
    expect(body.type).toBe("body");
  });
});

describe("root viewport export", () => {
  it("sets viewportFit: cover so env(safe-area-inset-*) resolves on iOS Safari", () => {
    expect(viewport.viewportFit).toBe("cover");
  });
});
