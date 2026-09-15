import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not part of the app tree — planning/tooling dirs, gitignored.
    ".planning/**",
    ".superpowers/**",
    ".claude/**",
    // Generated test/coverage output, gitignored — never hand-edited.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@tests/*", "**/tests/**"], message: "Production code never imports test support (tests/)." }] },
      ],
    },
  },
  {
    // src/components/ui/** is vendored (shadcn) — not held to this repo's own file-size convention.
    files: ["src/**"],
    ignores: ["src/components/ui/**"],
    rules: {
      "max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }],
    },
  },
]);

export default eslintConfig;
