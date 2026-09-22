import { beforeEach, describe, expect, it, vi } from "vitest";

// Same SDK-boundary fake as marketing-fonts.test.ts — see its own comment for why.
function fakeLoader(variable: string) {
  return vi.fn((options: unknown) => {
    void options; // the mock only needs to record the call — toHaveBeenCalledWith reads its args
    return { variable };
  });
}

const sourceSerif4 = fakeLoader("--font-source-serif");
const ibmPlexSans = fakeLoader("--font-plex-sans");
const ibmPlexSansDevanagari = fakeLoader("--font-devanagari");
const literata = fakeLoader("--font-literata");
const ibmPlexMono = fakeLoader("--font-plex-mono");

vi.mock("next/font/google", () => ({
  Source_Serif_4: (options: unknown) => sourceSerif4(options),
  IBM_Plex_Sans: (options: unknown) => ibmPlexSans(options),
  IBM_Plex_Sans_Devanagari: (options: unknown) => ibmPlexSansDevanagari(options),
  Literata: (options: unknown) => literata(options),
  IBM_Plex_Mono: (options: unknown) => ibmPlexMono(options),
}));

describe("(app)/fonts.ts", () => {
  // The module is a singleton per import — without resetting the registry, a later test's
  // import() would just return the first test's already-evaluated module and never re-invoke
  // these loader mocks, so it would falsely report "0 calls" for a real, correct implementation.
  beforeEach(() => {
    vi.resetModules();
  });

  it("preloads latin-ext on Plex Sans and Literata, the two faces rendering money figures on first paint", async () => {
    await import("@/app/(app)/fonts");

    expect(ibmPlexSans).toHaveBeenCalledWith(expect.objectContaining({ subsets: ["latin", "latin-ext"] }));
    expect(literata).toHaveBeenCalledWith(expect.objectContaining({ subsets: ["latin", "latin-ext"], axes: ["opsz"] }));
  });

  it("keeps Source Serif 4 and Plex Mono on latin-only — no currency renders in either", async () => {
    await import("@/app/(app)/fonts");

    expect(sourceSerif4).toHaveBeenCalledWith(expect.objectContaining({ subsets: ["latin"] }));
    expect(ibmPlexMono).toHaveBeenCalledWith(expect.objectContaining({ subsets: ["latin"] }));
  });

  it("loads the Devanagari fallback with preload: false — only fetched once Devanagari text appears", async () => {
    await import("@/app/(app)/fonts");

    expect(ibmPlexSansDevanagari).toHaveBeenCalledWith(
      expect.objectContaining({ subsets: ["devanagari"], preload: false, variable: "--font-devanagari" }),
    );
  });

  it("exposes all five faces", async () => {
    const mod = await import("@/app/(app)/fonts");
    expect(Object.keys(mod).sort()).toEqual(["devanagari", "literata", "plexMono", "plexSans", "sourceSerif"]);
  });
});
