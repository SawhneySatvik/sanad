// Importing scripts/e2e-server.ts must never itself spawn a fake provider or `next dev` — only
// running it as the actual entry point does (its own isEntryPoint guard). Most of this file proves
// that by importing the module and calling assertNotProductionEnv directly, with no process ever
// spawned. The one exception is the "main()'s production refusal" describe block below, which runs
// the real script as a subprocess — the only way to prove main() actually CALLS the guard (deleting
// the call site inside main() leaves every other test in this file green).

import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNotProductionEnv, PRODUCTION_REFUSAL_MESSAGE } from "../../../scripts/e2e-server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertNotProductionEnv", () => {
  it("throws when NODE_ENV=production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertNotProductionEnv()).toThrow(PRODUCTION_REFUSAL_MESSAGE);
  });

  it("does not throw for any other NODE_ENV", () => {
    for (const value of ["development", "test"] as const) {
      vi.stubEnv("NODE_ENV", value);
      expect(() => assertNotProductionEnv(), value).not.toThrow();
    }
  });

  it("takes an explicit env object too, not only the ambient process.env", () => {
    expect(() => assertNotProductionEnv({ ...process.env, NODE_ENV: "production" })).toThrow(PRODUCTION_REFUSAL_MESSAGE);
    expect(() => assertNotProductionEnv({ ...process.env, NODE_ENV: "development" })).not.toThrow();
  });
});

describe("main()'s production refusal at the actual entry point", () => {
  const SCRIPT_PATH = path.join(process.cwd(), "scripts", "e2e-server.ts");
  const TSX_BIN = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const SUBPROCESS_TIMEOUT_MS = 20_000;

  // NODE_ENV=production: main() must refuse before it ever rm()s .pglite-e2e/ or spawns the fake
  // provider / next dev — a subprocess is the only way to prove main() genuinely calls
  // assertNotProductionEnv(), not just that the exported helper throws in isolation (a deleted call
  // site inside main() would leave every test above this one green).
  it(
    "exits 1 with PRODUCTION_REFUSAL_MESSAGE on stderr, without starting anything",
    async () => {
      // detached: true makes this child its own process-group leader; every process IT spawns
      // (the fake provider, next dev) inherits that same group. If the guard is ever missing, that
      // group — not just this one pid — must be killable in one shot, or a regression here would
      // strand a fake-provider/next-dev pair bound to 4100/3100 for whoever runs this suite next.
      const child = spawn(TSX_BIN, [SCRIPT_PATH], {
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      };

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        // A correctly-refusing run never writes to stdout at all (the refusal goes to stderr
        // before anything else runs). Any stdout byte here means main() got past the guard and
        // started the fake provider — kill the whole group immediately rather than wait out the
        // timeout below, so next dev never gets a chance to bind 3100 or rewrite tsconfig.json.
        killGroup();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          killGroup();
          reject(new Error(`e2e-server subprocess did not exit within ${SUBPROCESS_TIMEOUT_MS}ms — stdout=${stdout} stderr=${stderr}`));
        }, SUBPROCESS_TIMEOUT_MS);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? -1);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(exitCode, `stdout=${stdout} stderr=${stderr}`).toBe(1);
      expect(stderr).toContain(PRODUCTION_REFUSAL_MESSAGE);
      // Never reaches the fake-provider/next dev startup lines main() would log next.
      expect(stdout).toBe("");
    },
    SUBPROCESS_TIMEOUT_MS + 5_000,
  );
});
