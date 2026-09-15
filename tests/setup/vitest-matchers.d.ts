// A separate file from jest-axe.d.ts on purpose: this one augments vitest's own real Assertion
// type, which only works from module scope (a top-level import/export makes TypeScript treat the
// file as a module, so `declare module "vitest"` merges with the real module instead of replacing
// it outright — the replacement failure mode a global script would hit here, unlike jest-axe.d.ts,
// which needs the opposite because "jest-axe" has no real types yet to merge with).

export {};

declare module "vitest" {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): void;
  }
}
