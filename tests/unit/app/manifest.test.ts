import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("PWA manifest (product name)", () => {
  const output = manifest();

  it("names the product Saboot, never 'Lawyer Up' or 'V3'", () => {
    expect(output.name).toBe("Saboot");
    expect(output.short_name).toBe("Saboot");
    for (const value of [output.name, output.short_name, output.description]) {
      const text = String(value ?? "");
      expect(text).not.toMatch(/Lawyer Up/i);
      expect(text).not.toMatch(/\bV3\b/);
    }
  });

  it("points every icon at the app's own public/icons/ path", () => {
    for (const icon of output.icons ?? []) {
      expect(icon.src).toMatch(/^\/icons\//);
    }
  });

  it("declares the 192, 512 and 512-maskable sizes with the right purpose", () => {
    const bySize = Object.fromEntries((output.icons ?? []).map((icon) => [`${icon.sizes}:${icon.purpose}`, icon]));
    expect(bySize["192x192:any"]).toBeDefined();
    expect(bySize["512x512:any"]).toBeDefined();
    expect(bySize["512x512:maskable"]).toBeDefined();
  });

  it("is a standalone-display app starting at /", () => {
    expect(output.start_url).toBe("/");
    expect(output.display).toBe("standalone");
  });
});
