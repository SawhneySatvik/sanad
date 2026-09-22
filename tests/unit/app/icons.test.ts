import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// PNG dimensions read straight from the IHDR chunk (signature: 8 bytes, then a 4-byte length, the
// 4-byte "IHDR" tag, then big-endian width/height) — no image library dependency needed just to
// confirm a raster's own declared size.
function pngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const root = process.cwd();

describe("src/app/icon.svg (the hand-authored app icon)", () => {
  const svg = readFileSync(path.join(root, "src/app/icon.svg"), "utf8");

  it("is a square viewBox, so it scales cleanly to every favicon/PWA size", () => {
    const match = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(match?.[2]);
  });

  it("never references an external URL — the mark is fully self-contained", () => {
    // The XML namespace declaration is a required identifier, never a fetched resource — strip
    // that one known-safe string before checking for a real external reference.
    const withoutNamespace = svg.replace("http://www.w3.org/2000/svg", "");
    expect(withoutNamespace).not.toMatch(/https?:\/\//);
  });

  it("renders no checkmark/badge shape and no BadgeCheck-style content — never a second verified mark", () => {
    // Scoped to markup, not the explanatory comment above it, which names "checkmark" only to say
    // the mark deliberately isn't one.
    const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toMatch(/BadgeCheck|checkmark/i);
  });
});

describe("the derived raster set", () => {
  it("src/app/apple-icon.png is exactly 180x180, the standard apple-touch-icon size", () => {
    const buffer = readFileSync(path.join(root, "src/app/apple-icon.png"));
    expect(pngDimensions(buffer)).toEqual({ width: 180, height: 180 });
  });

  it("public/icons/icon-192.png is exactly 192x192", () => {
    const buffer = readFileSync(path.join(root, "public/icons/icon-192.png"));
    expect(pngDimensions(buffer)).toEqual({ width: 192, height: 192 });
  });

  it("public/icons/icon-512.png and icon-512-maskable.png are exactly 512x512", () => {
    for (const name of ["icon-512.png", "icon-512-maskable.png"]) {
      const buffer = readFileSync(path.join(root, "public/icons", name));
      expect(pngDimensions(buffer)).toEqual({ width: 512, height: 512 });
    }
  });

  it("src/app/favicon.ico exists — the literal root-probed path some crawlers request directly", () => {
    expect(existsSync(path.join(root, "src/app/favicon.ico"))).toBe(true);
  });

  it("favicon.ico is a real ICO container (the 'ICO' reserved+type header), not a renamed PNG", () => {
    const buffer = readFileSync(path.join(root, "src/app/favicon.ico"));
    expect(buffer.readUInt16LE(0)).toBe(0); // reserved
    expect(buffer.readUInt16LE(2)).toBe(1); // type: icon
    expect(buffer.readUInt16LE(4)).toBeGreaterThanOrEqual(1); // at least one embedded image
  });
});
