import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installLifecycleSignals, memoizeCleanup, LIFECYCLE_SIGNALS, type LifecycleSignal } from "../../e2e/support/capture/lifecycle";

describe("installLifecycleSignals", () => {
  it("arms all three lifecycle signals (SIGINT, SIGTERM, SIGHUP) — a hung-up terminal must clean up exactly like Ctrl-C", () => {
    const emitter = new EventEmitter();
    installLifecycleSignals(emitter, () => {});
    for (const signal of LIFECYCLE_SIGNALS) expect(emitter.listenerCount(signal)).toBeGreaterThan(0);
  });

  it("calls onSignal with the exact signal name for each of the three", () => {
    const emitter = new EventEmitter();
    const onSignal = vi.fn();
    installLifecycleSignals(emitter, onSignal);

    emitter.emit("SIGINT");
    emitter.emit("SIGTERM");
    emitter.emit("SIGHUP");

    expect(onSignal.mock.calls.map((call) => call[0])).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  it("release() removes every listener this call installed, leaving the emitter clean", () => {
    const emitter = new EventEmitter();
    const handle = installLifecycleSignals(emitter, () => {});
    handle.release();
    for (const signal of LIFECYCLE_SIGNALS) expect(emitter.listenerCount(signal)).toBe(0);
  });

  it("release() never touches a listener installed by someone else on the same emitter", () => {
    const emitter = new EventEmitter();
    const other = () => {};
    emitter.on("SIGINT", other);
    const handle = installLifecycleSignals(emitter, () => {});
    handle.release();
    expect(emitter.listenerCount("SIGINT")).toBe(1);
    expect(emitter.listeners("SIGINT")).toEqual([other]);
  });

  // The actual guarantee this module provides: unlike a one-shot listener, this module's own handler
  // stays reusable until release() runs — so a second signal arriving while the caller is still busy
  // (mid-cleanup) reaches onSignal again, rather than the OS's default action taking over silently.
  // A caller earning this guarantee still has to defer its own release() until cleanup finishes —
  // this test proves the listener itself never disappears on its own after firing once.
  it("does not remove itself after firing once — a repeated signal before release() still reaches onSignal every time", () => {
    const emitter = new EventEmitter();
    const onSignal = vi.fn();
    installLifecycleSignals(emitter, onSignal);

    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    emitter.emit("SIGINT");

    expect(onSignal).toHaveBeenCalledTimes(3);
    for (const signal of LIFECYCLE_SIGNALS) expect(emitter.listenerCount(signal)).toBeGreaterThan(0);
  });

  it("red-proof: release() called BEFORE the guarded work finishes leaves nothing armed for a signal arriving in that gap — this is the exact ordering bug the caller must avoid, reproduced here at the listener level", () => {
    const emitter = new EventEmitter();
    const onSignal = vi.fn();
    const handle = installLifecycleSignals(emitter, onSignal);

    handle.release(); // simulates the old, buggy "release before cleanup" ordering
    emitter.emit("SIGINT"); // a second Ctrl-C landing in that now-unarmed gap

    expect(onSignal).not.toHaveBeenCalled();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });
});

describe("memoizeCleanup", () => {
  it("runs the wrapped function exactly once even when called twice before the first call resolves", async () => {
    let calls = 0;
    let resolveFirst: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls++;
          resolveFirst = resolve;
        }),
    );
    const cleanup = memoizeCleanup(run);

    const first = cleanup();
    const second = cleanup();
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);

    resolveFirst();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("both concurrent callers await the very same in-flight promise, not two independent ones", () => {
    const cleanup = memoizeCleanup(() => new Promise<void>(() => {}));
    expect(cleanup()).toBe(cleanup());
  });
});

// Compile-time check that LifecycleSignal is exactly Node's own signal-name literals this harness
// cares about — a typo here would silently arm the wrong OS signal.
const _typeCheck: LifecycleSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
void _typeCheck;
