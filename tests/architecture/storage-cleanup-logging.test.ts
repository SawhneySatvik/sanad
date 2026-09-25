import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("the local cleanup CLI logs a fixed failure message", () => {
  const source = readFileSync(path.join(process.cwd(), "scripts/storage-cleanup.ts"), "utf8");
  expect(source).toContain('console.error("Storage cleanup failed.")');
  expect(source).not.toMatch(/console\.error\(\s*error\s*\)/);
});

it("the principal-less storage-ref functions stay reachable only from the cleanup worker and delete acknowledgement", () => {
  const names = ["hasLiveStorageRef", "pendingStorageCleanup", "processQueuedStorageRef"];
  const allowed = new Set(["src/server/data/library.ts", "src/server/storage/cleanup-worker.ts", "src/server/services/library.ts"]);
  const files = (readdirSync(path.join(process.cwd(), "src"), { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file)).map((file) => path.join("src", file));
  const offenders = files.filter((file) => !allowed.has(file) &&
    names.some((name) => readFileSync(path.join(process.cwd(), file), "utf8").includes(name)));
  expect(offenders).toEqual([]);
});
