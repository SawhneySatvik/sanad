// npm run e2e:server — the process playwright.config.ts's webServer spawns. Brings up, in order:
// the fake provider (tests/e2e/support/fake-provider), a freshly migrated .pglite-e2e/, then
// `next dev` on port 3100 with SABOOT_E2E=1 and every provider/secret env var set explicitly (never
// left to `.env` — see buildChildEnv below). Playwright and its specs reach the app over HTTP only;
// nothing here opens .pglite-e2e/ from a second process while `next dev` is running.

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "../src/db/migrate";

const NEXT_PORT = 3100;
const FAKE_PROVIDER_PORT = Number(process.env.SABOOT_E2E_PROVIDER_PORT ?? "4100");
const DATA_DIR = path.resolve(process.cwd(), ".pglite-e2e");

function randomSecret(): string {
  return randomBytes(32).toString("hex");
}

// Explicit values for every env var any src/ module reads (found by grepping requireEnv/optionalEnv/
// process.env across src/), so `next dev`'s own automatic .env* loading — which only fills a key
// that isn't already set — can never let a real secret or a real DATABASE_URL leak into this run.
// Never written to .env; passed through the child's environment only.
function buildChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The flags this whole harness exists to exercise.
    SABOOT_E2E: "1",
    SABOOT_E2E_PROVIDER_URL: `http://127.0.0.1:${FAKE_PROVIDER_PORT}`,
    SABOOT_E2E_PROVIDER_PORT: String(FAKE_PROVIDER_PORT),
    // Passed through only if the invoking shell set it — never defaulted short here, or a session
    // could expire mid-suite; unset means "use the ordinary 3-hour default."
    SABOOT_E2E_GUEST_TTL_SECONDS: process.env.SABOOT_E2E_GUEST_TTL_SECONDS ?? "",
    TRUSTED_PROXY_HOPS: "1",
    VERCEL: "",
    DATABASE_URL: DATA_DIR,
    // Low enough that the IP-isolation spec exhausts one bucket in a quick burst, high enough that a
    // screen spec's real backend calls at several workers never do; every spec also uses its own
    // distinct x-forwarded-for.
    RATE_LIMIT_IP_PER_MINUTE: process.env.RATE_LIMIT_IP_PER_MINUTE ?? "60",
    // Every LLM-side limit knob wide open — this harness is never really calling a provider (every
    // request is redirected to the fake), so nothing here should ever throttle a spec; only the
    // per-IP route limit above stays tight, for the isolation spec.
    RATE_LIMIT_PRINCIPAL_PER_MINUTE: "10000",
    RATE_LIMIT_PRINCIPAL_PER_DAY: "10000",
    RATE_LIMIT_IP_LLM_PER_MINUTE: "10000",
    RATE_LIMIT_IP_LLM_PER_DAY: "10000",
    RATE_LIMIT_GEMINI_PER_MINUTE: "10000",
    RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE: "10000",
    RATE_LIMIT_GEMMA_PER_MINUTE: "10000",
    RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE: "10000",
    // Throwaway secrets, generated fresh per run — never persisted, never the same twice.
    GUEST_SESSION_SECRET: randomSecret(),
    GUEST_SESSION_SECRET_PREVIOUS: "",
    DEV_SESSION_SECRET: randomSecret(),
    LOCAL_STORAGE_SIGNING_SECRET: randomSecret(),
    RATE_LIMIT_IP_HASH_SECRET: randomSecret(),
    // Dummy provider keys: requireEnv() only demands non-empty, and every real call this harness
    // makes is redirected to the fake provider before any of these values are ever sent anywhere.
    GEMINI_API_KEY: "e2e-fake-gemini-key",
    NVIDIA_API_KEY: "e2e-fake-nvidia-key",
    OPENROUTER_API_KEY: "e2e-fake-openrouter-key",
    // Model-id overrides cleared so the built-in defaults apply — a real .env's values must not
    // silently change which model id a fixture was scripted against.
    GEMINI_MODEL: "",
    GEMINI_FALLBACK_MODEL: "",
    GEMMA_MODEL: "",
    GEMMA_MODEL_GOOGLE: "",
    GEMMA_MODEL_NIM: "",
    GEMMA_MODEL_OPENROUTER: "",
    // @google/genai and openai read these implicitly; cleared so neither SDK can be redirected to a
    // real endpoint by an ambient value this script didn't set.
    GOOGLE_API_KEY: "",
    GOOGLE_GENAI_USE_VERTEXAI: "",
    GOOGLE_APPLICATION_CREDENTIALS: "",
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    // Cleared so this harness's cache is always memory-only: local dev and prod can share one real
    // Upstash instance, and this run's fake-provider answers must never land in it under a real key.
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    KV_REST_API_URL: "",
    KV_REST_API_TOKEN: "",
  };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet — retried below.
    }
    if (Date.now() > deadline) throw new Error(`e2e-server: ${url} did not become healthy within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function killAll(children: ChildProcess[]): void {
  for (const child of children) {
    if (child.pid !== undefined && !child.killed) child.kill("SIGTERM");
  }
}

export const PRODUCTION_REFUSAL_MESSAGE = "e2e-server: refusing to start — NODE_ENV=production. SABOOT_E2E is never used in production.";

/** Exported for its own unit test: the same check main() runs before doing anything else. */
export function assertNotProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error(PRODUCTION_REFUSAL_MESSAGE);
  }
}

async function main(): Promise<void> {
  assertNotProductionEnv();

  await rm(DATA_DIR, { recursive: true, force: true });

  const env = buildChildEnv();
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  process.on("SIGINT", () => {
    shuttingDown = true;
    killAll(children);
  });
  process.on("SIGTERM", () => {
    shuttingDown = true;
    killAll(children);
  });

  const fakeProvider = spawn("npx", ["tsx", "tests/e2e/support/fake-provider/start.ts"], {
    stdio: "inherit",
    env,
  });
  children.push(fakeProvider);
  fakeProvider.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`e2e-server: fake-provider exited unexpectedly (code ${code}) — shutting down.`);
      killAll(children);
      process.exitCode = 1;
    }
  });
  await waitForHealth(`http://127.0.0.1:${FAKE_PROVIDER_PORT}/__control__/health`, 15_000);

  console.log(`e2e-server: migrating a fresh PGlite at ${DATA_DIR}`);
  const migrationClient = new PGlite(DATA_DIR);
  try {
    const applied = await applyMigrations(migrationClient);
    console.log(`e2e-server: applied ${applied.length} migration(s): ${applied.join(", ") || "(already up to date)"}`);
  } finally {
    await migrationClient.close();
  }

  const nextDev = spawn("npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", String(NEXT_PORT)], {
    stdio: "inherit",
    env,
  });
  children.push(nextDev);
  nextDev.on("exit", (code) => {
    if (!shuttingDown) {
      killAll(children);
      process.exitCode = code ?? 1;
    }
  });
}

// Runs only when this file is the actual entry point — never as a side effect of a test importing
// assertNotProductionEnv/PRODUCTION_REFUSAL_MESSAGE above, which would otherwise spawn real
// child processes the moment the module loads.
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error("e2e-server: failed to start:", error);
    process.exitCode = 1;
  });
}
