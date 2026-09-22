import { describe, it } from "vitest";

/**
 * Proves the jsdom project's own setupFiles entry for the network guard is what blocks a live call
 * here — unlike tests/setup/no-network.test.ts, this file imports nothing from the guard module
 * itself, so it can't accidentally install the guard on its own the way that file's own import of
 * the guard's internals does. If the jsdom project's setupFiles entry were ever dropped, this is
 * the file that would actually go red.
 */
describe("the jsdom project's ambient network guard (no import of the guard module)", () => {
  // it.fails inverts pass/fail: the guard's own afterEach hook throws when a blocked call's
  // rejection is caught and never acknowledged — exactly what this test does on purpose, mirroring
  // the guard module's own "violation self-check". Without the guard installed, the fetch goes out
  // for real, nothing throws, and this wrapped test would incorrectly pass — flipping the outer
  // it.fails to a failure, which is the signal that the guard is missing.
  it.fails("a bare fetch to a non-local host is blocked even when the caller swallows the rejection", async () => {
    try {
      await fetch("https://192.0.2.1");
    } catch {
      // swallowed on purpose — see the comment above
    }
  });
});
