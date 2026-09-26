// The pure, testable half of capture-screens.ts's own signal handling: which OS signals must
// trigger "stop and clean up the detached server's process group," and the rule that the listeners
// stay installed until the caller's own cleanup has actually finished. Real OS signals and a real
// spawned child process aren't reproducible in a unit test — this module only does the listener
// bookkeeping, against any object shaped like Node's EventEmitter (process itself, or a fake one).

export type LifecycleSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

// Ctrl-C, a graceful kill, and a hung-up controlling terminal — every one of them means the same
// thing here ("stop and clean up"), never a per-signal distinction, so one handler serves all three.
export const LIFECYCLE_SIGNALS: readonly LifecycleSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The subset of Node's EventEmitter this module needs — `process` itself satisfies it already. */
export interface SignalEmitter {
  on(event: LifecycleSignal, listener: () => void): unknown;
  off(event: LifecycleSignal, listener: () => void): unknown;
}

export interface LifecycleHandle {
  /** Removes every listener this call installed. Call only once cleanup has fully settled — never
   * a step earlier "just in case," since that's the exact gap that let an old second Ctrl-C escape
   * uncleaned (the OS's own default action for an unhandled signal is immediate termination). */
  release(): void;
}

/**
 * Installs `onSignal` against every lifecycle signal, and returns the handle that removes them
 * again. Each signal gets its own listener closing over its own name — `emitter.emit(signal)` isn't
 * guaranteed to pass the signal name as an argument, so this doesn't rely on that.
 */
export function installLifecycleSignals(emitter: SignalEmitter, onSignal: (signal: LifecycleSignal) => void): LifecycleHandle {
  const installed = LIFECYCLE_SIGNALS.map((signal) => {
    const listener = () => onSignal(signal);
    emitter.on(signal, listener);
    return { signal, listener };
  });

  return {
    release: () => {
      for (const { signal, listener } of installed) emitter.off(signal, listener);
    },
  };
}

/**
 * Wraps an async cleanup function so every caller — the normal finally-block path and a signal
 * arriving mid-cleanup alike — awaits the exact same in-flight run rather than kicking off a second,
 * concurrent teardown attempt (a double kill/rm race against the same temp dir and process group).
 */
export function memoizeCleanup(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= run());
}
