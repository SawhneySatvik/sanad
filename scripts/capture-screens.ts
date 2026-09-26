// The screenshot harness used to review UI states across routes and viewports: builds a throwaway
// copy of the WORKING TREE, not the index (captures happen before commit, so in-progress edits must
// show), boots the real e2e server inside that copy on tests/e2e's own ports, then drives a headless
// Chromium through every requested state at 1440x900 and 390x844, light and dark, writing PNGs to an
// absolute path in the real repo so they survive deleting the copy.
//
//   npm run capture:screens -- --screen <name> --states default,loading,error
//
// This script never takes a lock itself — it shares tests/e2e's own fixed ports (3100 next dev, 4100
// the fake provider), so running it concurrently with another instance, or with `npm run test:e2e`,
// races those ports; serialize invocations yourself if you run more than one.
//
// It reuses scripts/e2e-server.ts wholesale (spawned with its cwd inside the copy) rather than
// re-deriving its throwaway-secret/provider-redirect env pins here: that list is security-critical
// and this way a later addition to it is picked up automatically, never silently missing from a
// second, drifted copy. The preflight port check below refuses with a clear message instead of
// silently racing whatever else is bound to them.
//
// A new screen needs no edit to this file — see
// tests/e2e/support/capture/types.ts's header comment for the state-registry extension contract.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../tests/e2e/support/capture/args";
import { installLifecycleSignals, memoizeCleanup } from "../tests/e2e/support/capture/lifecycle";
import { isValidScreenName, loadStateRegistry, pickStates } from "../tests/e2e/support/capture/registry";
import { runCaptures } from "../tests/e2e/support/capture/runner";
import { assertNotProductionEnv } from "./e2e-server";

const NEXT_PORT = 3100;
const FAKE_PROVIDER_PORT = 4100;
const READY_TIMEOUT_MS = 120_000; // matches playwright.config.ts's own webServer timeout — a cold Turbopack compile is slow.
const SHUTDOWN_GRACE_MS = 4_000;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, "127.0.0.1");
  });
}

async function assertPortsFree(): Promise<void> {
  for (const port of [NEXT_PORT, FAKE_PROVIDER_PORT]) {
    if (!(await isPortFree(port))) {
      throw new Error(
        `capture-screens: port ${port} is already in use. This harness shares tests/e2e's ports and never runs ` +
          `concurrently with a real e2e run — stop whatever is bound to it first.`,
      );
    }
  }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${output}`))));
  });
}

function tail(output: string[]): string {
  return output.join("").split("\n").slice(-60).join("\n");
}

/** `hasExited` lets a crashed server fail this immediately — otherwise a crash on startup holds the heavy lock for the full timeout for nothing. */
async function waitForHealth(url: string, timeoutMs: number, output: string[], hasExited: () => number | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exitCode = hasExited();
    if (exitCode !== null) {
      throw new Error(`capture-screens: the server exited (code ${exitCode}) before ${url} ever answered — server output:\n${tail(output)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet — retried below.
    }
    if (Date.now() > deadline) {
      throw new Error(`capture-screens: ${url} did not become healthy within ${timeoutMs}ms — server output:\n${tail(output)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// -pid addresses the whole process group: scripts/e2e-server.ts's own spawn calls for the fake
// provider and `next dev` inherit the group of the detached process below, so one signal reaches
// all three — never kill by port or process name, which could hit an unrelated process.
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  assertNotProductionEnv();

  const args = parseArgs(process.argv.slice(2));
  if (!isValidScreenName(args.screen)) {
    throw new Error(`capture-screens: "${args.screen}" is not a valid screen name (letters, digits, "-", "_" only)`);
  }
  // Fails fast on an unknown screen/state before anything is copied or spawned.
  const registry = await loadStateRegistry(args.screen);
  pickStates(registry, args.states);

  await assertPortsFree();

  const repoRoot = process.cwd();
  const outDir = path.resolve(args.outDir ?? process.env.SABOOT_CAPTURE_OUT ?? path.join(repoRoot, ".impeccable", "review"));
  const copyDir = await mkdtemp(path.join(os.tmpdir(), `saboot-capture-${args.screen}-`));

  let server: ChildProcess | undefined;
  const serverOutput: string[] = [];
  let exitCode = 0;

  const waitWhile = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  // Memoized: the normal finally-block path below and a signal arriving mid-cleanup both call this
  // same function, and both must await the exact same in-flight run rather than racing a second
  // kill/rm attempt against the same process group and temp dir.
  const cleanup = memoizeCleanup(async (): Promise<void> => {
    if (server?.pid !== undefined) {
      const pid = server.pid;
      killGroup(pid, "SIGTERM");
      await waitWhile(() => isGroupAlive(pid));
      if (isGroupAlive(pid)) {
        killGroup(pid, "SIGKILL");
        // `nice 10`'d processes can take a moment to actually release their ports even once the
        // kill has landed — checked again below, not assumed to be instant.
        await waitWhile(() => isGroupAlive(pid));
      }
    }
    await rm(copyDir, { recursive: true, force: true });
    for (const port of [NEXT_PORT, FAKE_PROVIDER_PORT]) {
      let free = await isPortFree(port);
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (!free && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        free = await isPortFree(port);
      }
      if (!free) {
        exitCode = 1;
        console.error(`capture-screens: port ${port} is still bound after cleanup`);
      }
    }
  });

  let interrupted = false;
  // Installed for SIGINT, SIGTERM AND SIGHUP (a hung-up controlling terminal) alike — released only
  // once cleanup has actually completed (see the finally block below), so a second Ctrl-C arriving
  // WHILE that cleanup is still running still reaches this handler instead of falling through to the
  // OS's own default, uncleaned termination.
  const signals = installLifecycleSignals(process, (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`capture-screens: received ${signal}, cleaning up`);
    cleanup()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });

  try {
    console.log(`capture-screens: copying the working tree to ${copyDir}`);
    await run(
      "rsync",
      [
        "-a",
        "--exclude",
        "node_modules",
        "--exclude",
        ".next",
        "--exclude",
        ".git",
        "--exclude",
        ".pglite-e2e",
        // Never read here, and never copied either: scripts/e2e-server.ts already pins every
        // security-critical env var explicitly, so this is defense in depth, not a dependency.
        "--exclude",
        ".env*",
        // Previous review PNGs — irrelevant to a running server, and copying them just wastes time.
        "--exclude",
        ".impeccable",
        `${repoRoot}/`,
        `${copyDir}/`,
      ],
      repoRoot,
    );
    // -c clones (APFS copy-on-write) rather than duplicating bytes — never a symlink, so `next
    // dev`'s own writes inside the copy (.next/, generated types) never touch the real repo's tree.
    await run("cp", ["-Rc", path.join(repoRoot, "node_modules"), path.join(copyDir, "node_modules")], repoRoot);

    const tsxBin = path.join(copyDir, "node_modules", ".bin", "tsx");
    server = spawn(tsxBin, ["scripts/e2e-server.ts"], {
      cwd: copyDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Captures repeat many navigations against the same handful of routes; the e2e suite's
        // own IP-isolation gate is what needs this tight, not us.
        RATE_LIMIT_IP_PER_MINUTE: "10000",
        // `next dev`'s own telemetry ping is a real external request this harness's browser-side
        // network guard can never see or block, since it never goes through a page's context.
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
    server.stdout?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString()));
    let serverExitCode: number | null = null;
    server.on("exit", (code) => (serverExitCode = code ?? -1));

    // /api/e2e/ping (not "/"): it only answers once SABOOT_E2E=1 actually took effect, so this also
    // proves the copy's server came up in the mode this whole harness depends on.
    await waitForHealth(`http://127.0.0.1:${NEXT_PORT}/api/e2e/ping`, READY_TIMEOUT_MS, serverOutput, () => serverExitCode);

    // Compiles each route once outside a page.goto()'s own navigation timeout — a cold Turbopack
    // route can take longer than that timeout is willing to wait.
    for (const route of new Set(pickStates(registry, args.states).map((entry) => entry.state.route))) {
      await fetch(`http://127.0.0.1:${NEXT_PORT}${route}`).catch(() => undefined);
    }

    const results = await runCaptures({
      baseUrl: `http://127.0.0.1:${NEXT_PORT}`,
      screen: args.screen,
      stateNames: args.states,
      outDir,
    });
    for (const result of results) {
      console.log(`capture-screens: wrote ${path.relative(repoRoot, result.file)} (${result.bytes} bytes)`);
    }
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.message : error);
    if (serverOutput.length > 0) {
      console.error(`--- server output (tail) ---\n${serverOutput.join("").split("\n").slice(-60).join("\n")}`);
    }
  } finally {
    // cleanup() first, signals.release() after — the listeners must stay armed for the whole
    // duration of this cleanup, not fall away a step early, so a signal landing mid-cleanup still
    // reaches the handler above instead of the OS's own default action.
    if (!interrupted) await cleanup();
    signals.release();
  }

  process.exitCode = exitCode;
}

// Runs only when this file is the actual entry point — never as a side effect of a test importing
// something else from this module, the same guard scripts/e2e-server.ts uses for its own main().
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error("capture-screens: failed:", error);
    process.exitCode = 1;
  });
}
