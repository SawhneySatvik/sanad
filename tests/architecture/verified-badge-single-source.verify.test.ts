// Only VerificationBadge (and globals.css, which merely defines the --verified token) may render
// the verified mark anywhere in src/app/**, src/components/** or src/lib/** — including
// src/app/(marketing)/**, since the landing-page verifier demo is real UI, not exempt. This is the
// "only one binder" guarantee's display-side twin to bindSpan()'s "only one binding site."

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findFiles, isSourceFile, repoRelative } from "./route-conventions";
import { findViolations, findViolationsInFile, GLOBALS_CSS_FILE, VERIFICATION_BADGE_FILE } from "./verified-badge-single-source";

const ROOT = process.cwd();
// findFiles does a manual recursive readdir, not a glob — a glob library would treat the
// parenthesised route-group directory (marketing) as group syntax and silently skip it.
const SCAN_ROOTS = ["src/app", "src/components", "src/lib"];

function realTreeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const root of SCAN_ROOTS) {
    const dir = path.join(ROOT, root);
    // Any .css file, not just the one literally named globals.css — a second stylesheet defining or
    // referencing the token elsewhere in the tree must be scanned too, not silently skipped.
    for (const file of findFiles(dir, (name) => isSourceFile(name) || name.endsWith(".css"))) {
      const rel = repoRelative(file);
      if (rel === GLOBALS_CSS_FILE || /\.(tsx?|css)$/.test(rel)) files[rel] = readFileSync(file, "utf8");
    }
  }
  return files;
}

describe("the real tree: VerificationBadge is the only renderer of the verified mark", () => {
  it("positive: no file outside VerificationBadge's own file (or globals.css) references the verified icon, token or exact label", () => {
    expect(findViolations(realTreeFiles())).toEqual([]);
  });

  it("the scanned file set actually includes the marketing route group — a scan whose own roots silently dropped it would pass vacuously", () => {
    const files = realTreeFiles();
    expect(Object.keys(files).some((file) => file.startsWith("src/app/(marketing)/"))).toBe(true);
  });

  it("VerificationBadge's own file is exempt from all three checks (it legitimately does all three)", () => {
    const source = readFileSync(path.join(ROOT, VERIFICATION_BADGE_FILE), "utf8");
    expect(findViolationsInFile(VERIFICATION_BADGE_FILE, source)).toEqual([]);
  });

  it("globals.css legitimately defines the --verified/--verified-surface tokens, and is exempt", () => {
    const source = readFileSync(path.join(ROOT, GLOBALS_CSS_FILE), "utf8");
    expect(source).toMatch(/--verified:/);
    expect(findViolationsInFile(GLOBALS_CSS_FILE, source)).toEqual([]);
  });

  it("red-proof: a throwaway file under the marketing route group importing the reserved icon is caught by this same scan", () => {
    const marketingFile = "src/app/(marketing)/__throwaway-verified-violation.tsx";
    const source = `import { BadgeCheck } from "lucide-react";\nexport function Demo() { return <BadgeCheck />; }\n`;
    expect(findViolationsInFile(marketingFile, source)).toEqual(["imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)"]);
  });
});

describe("negative: class-token blind spots — variant prefixes, opacity, important, and Tailwind v4's bracketless arbitrary-value form", () => {
  it.each(["hover:text-verified", "dark:bg-verified-surface", "sm:hover:text-verified", "text-verified/90", "text-verified!", "!text-verified"])(
    "a decorated class token (%s) still reduces to the same reserved shape underneath",
    (className) => {
      const source = `function X() { return <div className="${className}" />; }\n`;
      expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
        "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
      ]);
    },
  );

  it.each(["text-(--verified)", "bg-(--color-verified-surface)", "dark:bg-(--color-verified-surface)"])(
    "Tailwind v4's own bracketless arbitrary-value syntax (%s) is caught, not only a raw var() call",
    (className) => {
      const source = `function X() { return <div className="${className}" />; }\n`;
      expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
        "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
      ]);
    },
  );
});

describe("negative: class-token blind spots — a class string reaching the DOM through something other than a className attribute wrapping cn()", () => {
  it("a plain const string, never passed through cn() or a className attribute directly", () => {
    const source = `const ROGUE_TONE = "text-verified";\nfunction X() { return <div className={ROGUE_TONE} />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("a cva() variant map, several object levels deep", () => {
    const source = [
      'import { cva } from "class-variance-authority";',
      "const badge = cva(\"base\", { variants: { tone: { rogue: \"bg-verified-surface\", plain: \"bg-muted\" } } });",
      "function X() { return <div className={badge({ tone: \"rogue\" })} />; }",
      "",
    ].join("\n");
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("a twMerge() call", () => {
    const source = 'import { twMerge } from "tailwind-merge";\nfunction X() { return <div className={twMerge("p-2", "text-verified")} />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });
});

describe("negative: icon-import blind spots — deep paths, re-exports, and require()", () => {
  it("a deep import path naming the icon's own file, as a default import (lucide-react has no default export of its own to catch this any other way)", () => {
    const source = 'import BadgeCheck from "lucide-react/dist/esm/icons/badge-check";\nfunction X() { return <BadgeCheck />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("export { BadgeCheck } from \"lucide-react\" — a re-export under the reserved name", () => {
    const source = 'export { BadgeCheck } from "lucide-react";\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it('export * from "lucide-react" — a wildcard re-export can reach the icon under any name', () => {
    const source = 'export * from "lucide-react";\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it('export * as Icons from "lucide-react" — the export-side twin of a namespace import', () => {
    const source = 'export * as Icons from "lucide-react";\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("require(\"lucide-react\")", () => {
    const source = 'function X() { const { BadgeCheck } = require("lucide-react"); return BadgeCheck; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("a deep dynamic import() naming the icon's own file", () => {
    const source = 'async function X() { const mod = await import("lucide-react/dist/esm/icons/badge-check"); return mod.default; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("an unrelated package merely prefixed by the same name is never flagged", () => {
    const source = 'import { BadgeCheck } from "lucide-react-native";\nfunction X() { return <BadgeCheck />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([]);
  });
});

describe("negative: label-text blind spots — aria-label/title, a checkmark prefix, shouting case, and a trimmed expression", () => {
  it('aria-label="Verified"', () => {
    const source = 'function X() { return <button aria-label="Verified" />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('title="verified" (case-insensitive)', () => {
    const source = 'function X() { return <span title="verified" />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('"✓ Verified" as JSX text', () => {
    const source = "function X() { return <span>✓ Verified</span>; }\n";
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('"VERIFIED" (shouting case) as JSX text', () => {
    const source = "function X() { return <span>VERIFIED</span>; }\n";
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('a string expression with trailing whitespace, {"Verified "}', () => {
    const source = 'function X() { return <span>{"Verified "}</span>; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('an aria-label mentioning the word "verified" as part of a real sentence is never flagged — only an exact match is', () => {
    const source = 'function X() { return <button aria-label="Jump to citation in Document A, verified" />; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([]);
  });
});

describe("negative: CSS blind spots — @apply with a variant prefix, opacity, important, and the arbitrary-value form", () => {
  it("@apply hover:text-verified dark:bg-verified-surface;", () => {
    const source = ".rogue {\n  @apply hover:text-verified dark:bg-verified-surface;\n}\n";
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("@apply text-verified/90;", () => {
    const source = ".rogue {\n  @apply text-verified/90;\n}\n";
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("@apply bg-(--color-verified-surface);", () => {
    const source = ".rogue {\n  @apply bg-(--color-verified-surface);\n}\n";
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("a class mentioned only inside a /* */ comment is never flagged", () => {
    const source = "/* do not use text-verified here */\n.rogue { color: red; }\n";
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([]);
  });
});

describe("negative: the prose allow-list holds under the broadened const/CSS scanning too", () => {
  it('a const holding an ordinary English sentence using "re-verified" as a flowing word is never flagged', () => {
    const source = 'const NOTE = "This finding was re-verified last week";\nfunction X() { return <p>{NOTE}</p>; }\n';
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([]);
  });

  it('the same "re-verified" prose word inside a CSS comment or declaration value is never flagged', () => {
    const source = '.rogue::before { content: "re-verified"; }\n';
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([]);
  });
});

describe("negative: each of the three independent checks catches its own violation kind, in isolation", () => {
  it("an import of the icon under its primary export name, with no other violation", () => {
    const source = `import { BadgeCheck } from "lucide-react";\nfunction X() { return <BadgeCheck className="size-4" />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("the same icon component reached under a DIFFERENT export name entirely (lucide-react aliases one icon under several names) — a hard-coded single-name check would miss this", () => {
    const source = `import { Verified } from "lucide-react";\nfunction X() { return <Verified className="size-4" />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("a namespace import of the whole icon package, which can reach the icon under any name without a matching named-import specifier", () => {
    const source = `import * as Icons from "lucide-react";\nfunction X() { return <Icons.BadgeCheck className="size-4" />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("a dynamic import() of the icon package", () => {
    const source = `async function X() { const { BadgeCheck } = await import("lucide-react"); return BadgeCheck; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "imports the reserved verified icon from lucide-react (by name or via a namespace/dynamic import)",
    ]);
  });

  it("a Tailwind utility referencing the verified token family, with a different icon entirely", () => {
    const source = `import { CircleCheck } from "lucide-react";\nfunction X() { return <CircleCheck className="text-verified" />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it.each(["border-l-verified", "divide-verified", "shadow-verified", "accent-verified", "caret-verified", "ring-offset-verified", "placeholder-verified"])(
    "a less-common Tailwind colour utility prefix (%s) still trips the generic shape match",
    (className) => {
      const source = `function X() { return <div className="${className}" />; }\n`;
      expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
        "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
      ]);
    },
  );

  it("a raw CSS variable reference (var(--verified) or var(--color-verified-surface)), outside globals.css", () => {
    const source = `function X() { return <div style={{ color: "var(--verified)" }} />; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it("a second stylesheet (not globals.css) referencing the token", () => {
    const source = `.rogue { background: var(--verified-surface); }\n`;
    expect(findViolationsInFile("src/components/example/rogue.module.css", source)).toEqual([
      "references a verified-family token (a Tailwind utility class or a --verified/--color-verified CSS variable)",
    ]);
  });

  it('the literal JSX text "Verified", alone, as a text child', () => {
    const source = `function X() { return <span>Verified</span>; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it('the literal JSX text "Verified" as a bare string-literal expression child ({"Verified"})', () => {
    const source = `function X() { return <span>{"Verified"}</span>; }\n`;
    expect(findViolationsInFile("src/components/example/rogue.tsx", source)).toEqual(['renders the literal JSX text "Verified"']);
  });

  it("all three at once in one rogue file are all reported together", () => {
    const source = `import { BadgeCheck } from "lucide-react";\nfunction X() { return <div className="text-verified"><BadgeCheck />Verified</div>; }\n`;
    const reasons = findViolationsInFile("src/components/example/rogue.tsx", source);
    expect(reasons).toHaveLength(3);
  });
});

describe("the allow-list: prose mentioning the word 'verified' is never a substring match", () => {
  it("a landing-page sentence like 'Verified means verified' is not flagged — it is not an exact match for the label", () => {
    const source = `function X() { return <p>Verified means verified.</p>; }\n`;
    expect(findViolationsInFile("src/app/(marketing)/page.tsx", source)).toEqual([]);
  });

  it("a tooltip explaining the badge's own info copy ('found word for word in the document') is not flagged", () => {
    const source = `function X() { return <p>This finding's words were found word for word in the document.</p>; }\n`;
    expect(findViolationsInFile("src/components/example/info.tsx", source)).toEqual([]);
  });

  it("an unrelated identifier sharing a substring with the token family (a disjoint cached-status literal spelled without a hyphen) is not flagged", () => {
    const source = `type UnverifiedCachedStatus = "cached_verified" | "cached_approximate";\nfunction isUnverifiedCachedStatus(s: string) { return s === "cached_verified"; }\n`;
    expect(findViolationsInFile("src/lib/example/guest-thread-store.ts", source)).toEqual([]);
  });
});
