// Looks a screen's states up by dynamic import, not a static screen -> module map — see types.ts's
// header for why (a new screen must never edit a shared file to register itself).

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CaptureState, StateRegistry } from "./types";

const SCREEN_NAME_RE = /^[A-Za-z0-9_-]+$/;
const STATES_DIR = fileURLToPath(new URL("./states", import.meta.url));

/** A screen name must be shaped like a bare filename component — guards the dynamic import below against a `--screen` arg that tries to escape STATES_DIR. */
export function isValidScreenName(screen: string): boolean {
  return SCREEN_NAME_RE.test(screen);
}

/** Loads `./states/<screen>.ts`'s exported `states`. Throws a message naming the missing file, not a bare module-not-found. */
export async function loadStateRegistry(screen: string): Promise<StateRegistry> {
  if (!isValidScreenName(screen)) {
    throw new Error(`capture-screens: "${screen}" is not a valid screen name (letters, digits, "-", "_" only)`);
  }
  const file = path.join(STATES_DIR, `${screen}.ts`);
  if (!existsSync(file)) {
    throw new Error(
      `capture-screens: no state registry at tests/e2e/support/capture/states/${screen}.ts — add one to register states for "${screen}"`,
    );
  }
  const mod = (await import(pathToFileURL(file).href)) as { states?: StateRegistry };
  if (!mod.states) {
    throw new Error(`capture-screens: tests/e2e/support/capture/states/${screen}.ts must export "states"`);
  }
  return mod.states;
}

/** Picks the named states from a registry, in the order given. Throws listing what IS available, so a `--states` typo is easy to fix. */
export function pickStates(registry: StateRegistry, names: string[]): { name: string; state: CaptureState }[] {
  return names.map((name) => {
    const state = registry[name];
    if (!state) {
      throw new Error(`capture-screens: no state "${name}" — available: ${Object.keys(registry).join(", ") || "(none)"}`);
    }
    return { name, state };
  });
}
