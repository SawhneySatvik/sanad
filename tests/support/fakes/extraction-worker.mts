// A scripted stand-in for src/server/deterministic/extract/worker.mts, for testing how the sandbox
// classifies the way a parse worker ends. `workerData.behavior` picks the script. Node runs this file
// unbundled, like the real worker, so it imports only `node:` builtins — and, for "slow-start", the
// real worker itself.

import { parentPort, workerData } from "node:worker_threads";

const { behavior, startDelayMs } = workerData as { behavior: string; startDelayMs?: number };

if (behavior === "slow-start") {
  // The real worker, loaded only after a delay: a startup slowed by a busy machine. workerData
  // carries the real parse request too; the real worker reports ready and posts the result itself.
  await new Promise((resolve) => setTimeout(resolve, startDelayMs));
  await import(new URL("../../../src/server/deterministic/extract/worker.mts", import.meta.url).href);
} else if (behavior === "throw-before-ready") {
  throw new Error("failed while loading");
} else if (behavior === "exit-before-ready") {
  process.exit(0);
} else if (behavior === "hang-before-ready") {
  setInterval(() => undefined, 1_000);
} else {
  // Like the real worker: ready, then act only once the sandbox answers.
  parentPort?.postMessage({ kind: "ready" });
  parentPort?.once("message", () => {
    if (behavior === "ready-then-throw") throw new Error("the parser threw");
    if (behavior === "ready-then-result") parentPort?.postMessage({ kind: "docx", text: "Clause text." });
    if (behavior === "ready-then-hang") setInterval(() => undefined, 1_000);
    // "ready-then-exit": nothing is left to run, so the thread exits 0 with no result — the shape of
    // a parse whose promise never settles.
  });
}
