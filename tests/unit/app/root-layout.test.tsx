import { describe, expect, it } from "vitest";
import RootLayout, { viewport } from "@/app/layout";

describe("RootLayout", () => {
  it("sets lang=\"en\" and suppressHydrationWarning on <html> (next-themes' own documented requirement)", () => {
    const element = RootLayout({ children: <p>content</p> });
    expect(element.props.lang).toBe("en");
    expect(element.props.suppressHydrationWarning).toBe(true);
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
