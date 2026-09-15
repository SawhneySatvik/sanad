// jest-axe ships no types of its own; this ambient module mirrors its real runtime shape (see
// node_modules/jest-axe/index.js) against axe-core's own published types, which are installed.
//
// Deliberately a global script (no top-level import/export): "jest-axe" has no real types
// anywhere to augment, so this declaration must create the module outright, which only a global
// `declare module` can do — inside a module file the same block would try to augment a module
// that doesn't exist yet and silently declare nothing. The vitest Assertion augmentation lives in
// its own file (vitest-matchers.d.ts) for the opposite reason: vitest already has real types, and
// a `declare module "vitest"` here would need module scope to merge instead of replace them.

declare module "jest-axe" {
  import type AxeCore from "axe-core";

  export function axe(html: Element | Document | string, options?: AxeCore.RunOptions): Promise<AxeCore.AxeResults>;
  export function configureAxe(options?: AxeCore.RunOptions & { globalOptions?: AxeCore.Spec }): typeof axe;

  // An index signature, not a named interface: vitest's own expect.extend() takes
  // Record<string, RawMatcherFn>, which a plain named interface (no index signature of its own)
  // does not structurally satisfy.
  export const toHaveNoViolations: Record<string, (received: AxeCore.AxeResults) => { pass: boolean; message(): string }>;
}
