// Shared plumbing for `npm run validate:live`: env loading that never prints a value, a metered
// global fetch with a hard provider-call budget, and the production container wiring over an
// in-memory PGlite and a temp-dir storage root. The live run is the one place real provider calls
// are allowed; nothing here is imported by `npm test`.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, type TestDb } from "@tests/support/db";
import { createContainer, type Container, type LlmProviders, type RateLimitOverrides, type ServiceDeps } from "@/server/container";
import { AppError } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import type { AnalyzeInput } from "@/server/services/understand";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";

export const DEFAULT_CALL_BUDGET = 30;
export const LIVE_OUTPUT_DIR = path.join(process.cwd(), "docs", "live-validation");

// Names only — the report records which are set, never what they are set to.
const ENV_NAMES = [
  "GEMINI_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
  "GEMMA_MODEL_GOOGLE",
  "GEMMA_MODEL",
  "GEMMA_MODEL_NIM",
  "GEMMA_MODEL_OPENROUTER",
  "RATE_LIMIT_PRINCIPAL_PER_MINUTE",
  "RATE_LIMIT_IP_LLM_PER_MINUTE",
  "RATE_LIMIT_GEMINI_PER_MINUTE",
  "RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE",
  "RATE_LIMIT_GEMMA_PER_MINUTE",
  "RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE",
] as const;

export function loadEnvNames(): Record<string, "set" | "unset"> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name] ? "set" : "unset"]));
}

export type Provider = "gemini" | "nim" | "openrouter";

const PROVIDER_HOSTS: Record<string, Provider> = {
  "generativelanguage.googleapis.com": "gemini",
  "integrate.api.nvidia.com": "nim",
  "openrouter.ai": "openrouter",
};

export interface HttpCall {
  seq: number;
  op: string;
  provider: Provider;
  model: string | null;
  startedAt: string;
  latencyMs: number;
  // "aborted": the client-side timeout (or caller signal) fired before a response arrived.
  outcome: "response" | "aborted" | "network_error";
  status: number | null;
  // 429 only: which quota window the provider named, if its error body says.
  quotaWindow?: "per_day" | "per_minute" | "unstated";
  retryAfter?: string | null;
  // Non-2xx only: the provider's own error status and message (never `details`), capped and
  // redacted — the adapters normalise every provider error to a fixed safe message, so without this
  // a rejected request is undiagnosable.
  errorStatus?: string | null;
  errorMessage?: string | null;
  // Network errors / aborts only: the thrown error's name and its cause's code (e.g. ECONNRESET).
  failure?: string;
}

export interface BlockedCall {
  op: string;
  provider: Provider;
  model: string | null;
  at: string;
  // "budget": the run's total was spent. "cap": a deliberate per-model cap (a tier known to be out
  // of quota or unresponsive, or a quota shared across the ask/compare/draft parts) — expected, not a failure.
  reason?: "budget" | "cap";
}

// Every request to a provider host goes through here: counted, timed, and refused locally once the
// budget is spent. A refused attempt surfaces inside the SDK as a network error (so the product's
// fallback may try the next provider, which is refused too) — it is recorded as `blocked`, never as
// a provider failure. Only host, model, status and latency are recorded: never the URL (query
// strings), headers (keys) or bodies.
export class ProviderMeter {
  readonly calls: HttpCall[] = [];
  readonly blocked: BlockedCall[] = [];
  otherFetches = 0;
  op = "setup";

  // `caps`: per-model ceilings on requests actually sent, keyed `${provider}:${model}`.
  constructor(
    readonly budget: number,
    readonly caps: Readonly<Record<string, number>> = {},
  ) {}

  get used(): number {
    return this.calls.length;
  }

  sentTo(key: string): number {
    return this.calls.filter((call) => `${call.provider}:${call.model}` === key).length;
  }

  remainingFor(key: string): number {
    return (this.caps[key] ?? Infinity) - this.sentTo(key);
  }

  get remaining(): number {
    return this.budget - this.calls.length;
  }

  callsSince(seq: number): HttpCall[] {
    return this.calls.filter((call) => call.seq > seq);
  }

  // Must run before any provider client is constructed: the openai SDK captures globalThis.fetch in
  // its constructor (@google/genai reads it per call).
  install(): void {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => this.fetch(original, input, init);
  }

  async fetch(original: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = URL.parse(input instanceof Request ? input.url : String(input));
    const provider = url === null ? undefined : PROVIDER_HOSTS[url.hostname];
    if (url === null || provider === undefined) {
      this.otherFetches += 1;
      return original(input, init);
    }
    const model = modelOf(provider, url, init);
    const reason = this.remaining <= 0 ? "budget" : this.remainingFor(`${provider}:${model}`) <= 0 ? "cap" : null;
    if (reason) {
      this.blocked.push({ op: this.op, provider, model, at: new Date().toISOString(), reason });
      throw new Error(`validate-live: provider call refused locally (${reason}); request not sent`);
    }
    const call: HttpCall = {
      seq: this.calls.length + 1,
      op: this.op,
      provider,
      model,
      startedAt: new Date().toISOString(),
      latencyMs: 0,
      outcome: "response",
      status: null,
    };
    this.calls.push(call);
    const started = performance.now();
    try {
      const response = await original(input, init);
      call.latencyMs = Math.round(performance.now() - started);
      call.status = response.status;
      if (!response.ok) {
        const body = await response.clone().text().catch(() => "");
        Object.assign(call, providerError(body));
        if (response.status === 429) {
          call.quotaWindow = /PerDay/i.test(body) ? "per_day" : /PerMinute/i.test(body) ? "per_minute" : "unstated";
          call.retryAfter = response.headers.get("retry-after");
        }
      }
      return response;
    } catch (error) {
      call.latencyMs = Math.round(performance.now() - started);
      const aborted = init?.signal?.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      call.outcome = aborted ? "aborted" : "network_error";
      const cause = error instanceof Error ? (error.cause as { code?: unknown; name?: unknown } | undefined) : undefined;
      call.failure = [error instanceof Error ? error.name : "non-Error", cause?.code ?? cause?.name].filter((x) => typeof x === "string").join(" / ");
      throw error;
    }
  }
}

// Gemini: {error: {code, message, status, details}}; OpenAI-compatible gateways: {error: {message,
// code}} or {detail}. Anything token-shaped (a key, a bearer) is redacted before it is kept.
export function providerError(body: string): { errorStatus: string | null; errorMessage: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errorStatus: null, errorMessage: null };
  }
  const root = (parsed ?? {}) as { error?: { status?: unknown; code?: unknown; message?: unknown }; detail?: unknown };
  const status = root.error?.status ?? root.error?.code ?? null;
  const message = root.error?.message ?? root.detail ?? null;
  return {
    errorStatus: status === null ? null : redact(String(status)).slice(0, 60),
    errorMessage: typeof message === "string" ? redact(message).slice(0, 300) : null,
  };
}

function redact(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}|nvapi-[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{10,}|[0-9A-Za-z_-]{32,}/g, "[redacted]");
}

function modelOf(provider: Provider, url: URL, init?: RequestInit): string | null {
  if (provider === "gemini") return /\/models\/([^:/]+):/.exec(url.pathname)?.[1] ?? null;
  if (typeof init?.body !== "string") return null;
  try {
    const model = (JSON.parse(init.body) as { model?: unknown }).model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

export interface ValidationEnv {
  t: TestDb;
  container: Container;
  storage: LocalFsStorageAdapter;
  // A dedicated guest principal: the per-principal rate-limit tier charges it exactly as it would a user.
  principal: Principal;
  deps(): ServiceDeps;
  uploadText(filename: string, text: string): Promise<AnalyzeInput>;
  close(): Promise<void>;
}

const RUN_DAILY_CAP = 100_000;

// The production container (src/server/container.ts) with only its db and storage leaves swapped:
// in-memory PGlite with every migration applied, and the real local storage adapter over a temp
// directory with a per-run signing secret. `llm` is the same thunk shape production passes. The
// per-minute limits apply exactly as in production; the daily caps are lifted, because they bound one
// visitor's day and a run is many visitors' worth of calls from one principal.
export async function createValidationEnv(
  llm: () => LlmProviders,
  primaryModelId: string,
  rateLimits?: RateLimitOverrides,
): Promise<ValidationEnv> {
  const t = await createTestDb();
  const rootDir = await mkdtemp(path.join(tmpdir(), "validate-live-"));
  const signingSecret = randomBytes(32).toString("hex");
  const storage = new LocalFsStorageAdapter({ rootDir, signingSecret, accessCheck: canAccess });
  const container = createContainer({
    db: t.db,
    storage: () => storage,
    llm,
    localStorageSigningSecret: () => signingSecret,
    primaryModelId,
    rateLimits: { principalPerDay: RUN_DAILY_CAP, ipLlmPerDay: RUN_DAILY_CAP, ...rateLimits },
  });
  const principal: Principal = { type: "guest", guestSessionId: `live-validation-${randomUUID()}` };
  return {
    t,
    container,
    storage,
    principal,
    // One per logical request, as a route would get it.
    deps: () => container.forRequest(principal),
    // The upload relay's path: create target → write bytes → the caller confirms via analyze().
    async uploadText(filename, text) {
      const bytes = new TextEncoder().encode(text);
      const target = await storage.createUploadTarget(principal, { filename, mimeType: "text/plain", sizeBytes: bytes.byteLength });
      await storage.writeRelayed(principal, target.ref, bytes);
      return { storageRef: target.ref, filename, mimeType: "text/plain" };
    },
    async close() {
      await t.close();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

// Never the error object itself: DocumentAnalysisError carries a cause chain, and a non-AppError's
// message is not vetted, so it is key-redacted and capped. AppError messages are the fixed safe messages.
export function describeError(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${redact(error.message).slice(0, 200)}`;
  return "non-Error thrown";
}

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeOutput(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return file;
}

export async function readJsonOutput<T>(dir: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(dir, name), "utf8")) as T;
}

export function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

export function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Markdown table cell: one line, pipes escaped, long text cut.
export function cell(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
