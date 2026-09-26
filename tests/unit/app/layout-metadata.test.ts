import { describe, expect, it, vi } from "vitest";
import { metadata } from "@/app/layout";

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

function titleStrings(): string[] {
  const title = metadata.title;
  if (typeof title === "string") return [title];
  if (title && typeof title === "object" && "default" in title) {
    const strings = [String(title.default)];
    if ("template" in title && title.template) strings.push(String(title.template));
    return strings;
  }
  return [];
}

describe("root layout metadata (product name)", () => {
  it("the title contains 'Saboot'", () => {
    const strings = titleStrings();
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.some((s) => s.includes("Saboot"))).toBe(true);
  });

  it("the title never contains 'Lawyer Up' or 'V3'", () => {
    for (const s of titleStrings()) {
      expect(s).not.toMatch(/Lawyer Up/i);
      expect(s).not.toMatch(/\bV3\b/);
    }
  });

  it("the description mentions Saboot and never 'Lawyer Up' or 'V3'", () => {
    const description = String(metadata.description);
    expect(description).toMatch(/Saboot/);
    expect(description).not.toMatch(/Lawyer Up/i);
    expect(description).not.toMatch(/\bV3\b/);
  });
});
