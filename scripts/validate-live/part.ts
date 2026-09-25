// Shared plumbing for the Ask, Compare and Draft parts: one metered production chain per part, with
// per-model caps so the parts together never send more than their shared Flash-Lite allocation, and
// documents ingested through the real upload and extraction path without spending a model call.

import type { LlmProviders } from "@/server/container";
import { optionalEnv } from "@/server/core/env";
import { AppError } from "@/server/core/errors";
import { getDocument, type Document } from "@/server/data/documents";
import { FakeLlmClient, type FakeLlmScript } from "@tests/support/fakes/llm-client";
import { createGeminiClient, createGemmaClient, geminiModelId } from "@/server/llm/providers";
import { analyze, DocumentAnalysisError } from "@/server/services/understand";
import type { LiveValidationSet } from "../../tests/fixtures/live-validation/load";
import {
  type BlockedCall,
  cell,
  createValidationEnv,
  formatMs,
  type HttpCall,
  loadEnvNames,
  ProviderMeter,
  sleep,
  type ValidationEnv,
  writeOutput,
} from "./harness";
import { type DryRunMode, type OpRecord, providerSaid } from "./understand";

export interface PartOptions {
  outDir: string;
  // This part's share of the Flash-Lite allocation shared across ask/compare/draft (the only tier answering).
  flashLite: number;
  dryRun: DryRunMode | null;
}

// Pacing between live operations. Every Gemini-side attempt charges the global `gemini` bucket
// (7/min), refused primary attempts and their retry included, so 13 s is not enough headroom here.
const MIN_GAP_BETWEEN_LIVE_OPS_MS = 20_000;

// The chain's model ids, resolved the way src/server/llm/providers.ts resolves them (its defaults
// are module-private, so they are repeated here). A tier whose id did not match would still be
// bounded by the part's total.
export function tierModels() {
  return {
    primary: geminiModelId(),
    flashLite: optionalEnv("GEMINI_FALLBACK_MODEL") ?? "gemini-3.5-flash-lite",
    gemmaGoogle: optionalEnv("GEMMA_MODEL_GOOGLE") ?? "gemma-4-31b-it",
    nim: optionalEnv("GEMMA_MODEL_NIM") ?? optionalEnv("GEMMA_MODEL") ?? "google/gemma-4-31b-it",
    openrouter: optionalEnv("GEMMA_MODEL_OPENROUTER") ?? optionalEnv("GEMMA_MODEL") ?? "google/gemma-4-31b-it:free",
  };
}

export type TierModels = ReturnType<typeof tierModels>;

// Why each cap: the primary's daily quota is scarce, so one real request per part is enough to
// prove it live and the rest are refused locally (its breaker opens after three failures);
// Flash-Lite is the shared allocation; NIM has never answered this account (0 of 12), so it is not
// sent a request; Gemma on Google and OpenRouter get one attempt each if Flash-Lite ever fails.
export function partCaps(models: TierModels, flashLite: number): Record<string, number> {
  return {
    [`gemini:${models.primary}`]: 1,
    [`gemini:${models.flashLite}`]: flashLite,
    [`gemini:${models.gemmaGoogle}`]: 1,
    [`nim:${models.nim}`]: 0,
    [`openrouter:${models.openrouter}`]: 1,
  };
}

export interface PartMeta {
  part: string;
  mode: "live" | `dry-run:${DryRunMode}`;
  startedAt: string;
  finishedAt: string | null;
  wallTimeMs: number | null;
  flashLiteAllocation: number;
  caps: Record<string, number>;
  models: TierModels;
  callsSent: number;
  blocked: BlockedCall[];
  otherFetches: number;
  env: Record<string, string>;
  stops: string[];
}

export interface Part {
  set: LiveValidationSet;
  venv: ValidationEnv;
  meter: ProviderMeter;
  meta: PartMeta;
  dryRun: DryRunMode | null;
  // Upload → confirm → server-side extraction through understand.analyze(), whose analysis call is
  // declined: the document ends `ready` (extracted, not analysed) and no provider is called.
  ingest(filename: string, text: string): Promise<Document>;
  pace(): Promise<void>;
  // Why the remaining live items must be skipped, or null.
  stopReason(): string | null;
  observe(op: OpRecord): void;
  save(write: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export async function openPart(part: string, set: LiveValidationSet, opts: PartOptions, fake: FakeLlmScript): Promise<Part> {
  const env = opts.dryRun ? {} : loadEnvNames();
  const models = tierModels();
  const caps = partCaps(models, opts.flashLite);
  const meter = new ProviderMeter(opts.dryRun ? 0 : Object.values(caps).reduce((sum, n) => sum + n, 0), caps);
  meter.install();
  const providers: () => LlmProviders = opts.dryRun
    ? () => ({
        primary: new FakeLlmClient({ modelUsed: "dry-run-fake", defaultResponse: fake }),
        secondary: new FakeLlmClient({
          modelUsed: "dry-run-fake-secondary",
          defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "dry run: the secondary never answers") },
        }),
      })
    : () => ({ primary: createGeminiClient(), secondary: createGemmaClient() });
  // A dry run is not paced: its limiter clock moves each check into a fresh minute (see understand.ts).
  let tick = 0;
  const dryRunClock = { now: () => new Date(Date.now() + 61_000 * tick++) };
  const primaryModelId = opts.dryRun ? "dry-run-fake" : models.primary;
  const venv = await createValidationEnv(providers, primaryModelId, opts.dryRun ? { clock: dryRunClock } : undefined);
  const started = Date.now();
  const meta: PartMeta = {
    part,
    mode: opts.dryRun ? `dry-run:${opts.dryRun}` : "live",
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    wallTimeMs: null,
    flashLiteAllocation: opts.flashLite,
    caps,
    models,
    callsSent: 0,
    blocked: [],
    otherFetches: 0,
    env,
    stops: [],
  };
  console.log(`[validate-live ${part}] mode=${meta.mode} flash-lite allocation=${opts.flashLite} caps=${JSON.stringify(caps)}`);
  if (!opts.dryRun) console.log(`[validate-live ${part}] env: ${Object.entries(env).map(([n, s]) => `${n}=${s}`).join(" ")}`);

  const flashKey = `gemini:${models.flashLite}`;
  let lastStart = 0;
  let lastErrorCode: string | null = null;
  let sameCodeFailures = 0;
  let schemaFailed = false;
  let stopped: string | null = null;

  return {
    set,
    venv,
    meter,
    meta,
    dryRun: opts.dryRun,
    async ingest(filename, text) {
      const before = meter.used + meter.blocked.length;
      const decliner = new FakeLlmClient({
        defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "validation harness: the analysis call is declined") },
      });
      const input = await venv.uploadText(filename, text);
      let documentId: string;
      try {
        await analyze({ db: venv.t.db, storage: venv.storage, llm: decliner, modelId: primaryModelId }, venv.principal, input);
        throw new Error(`ingest ${filename}: the declining analysis client answered`);
      } catch (error) {
        if (!(error instanceof DocumentAnalysisError)) throw error;
        documentId = error.documentId;
      }
      const document = await getDocument(venv.t.db, venv.principal, documentId);
      if (document.processingStatus !== "ready" || document.canonicalText === null || document.canonicalTextHash === null) {
        throw new Error(`ingest ${filename}: not ready after extraction (${document.processingStatus})`);
      }
      if (meter.used + meter.blocked.length !== before) throw new Error(`ingest ${filename}: a provider call was attempted`);
      return document;
    },
    async pace() {
      if (opts.dryRun) return;
      const wait = lastStart + MIN_GAP_BETWEEN_LIVE_OPS_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    },
    stopReason() {
      if (stopped) return stopped;
      const quota = meter.calls.find((call) => `${call.provider}:${call.model}` === flashKey && call.status === 429);
      // A 4xx other than a 429 is deterministic (a schema or request the tier rejects): repeating it
      // only spends quota.
      const rejected = meter.calls.find((call) => call.status !== null && call.status >= 400 && call.status < 500 && call.status !== 429);
      const reason = quota
        ? `quota exhausted at call ${quota.seq} (${quota.model}, HTTP 429, window ${quota.quotaWindow})`
        : rejected
          ? `call ${rejected.seq} (${rejected.model}) was rejected with HTTP ${rejected.status}${providerSaid(rejected)}`
          : schemaFailed
            ? "an operation ended SCHEMA_FAILED (the model's output never matched the schema)"
            : sameCodeFailures >= 2
              ? `two consecutive operations failed with ${lastErrorCode}`
              : !opts.dryRun && meter.remainingFor(flashKey) < 1
                ? `the Flash-Lite allocation is spent (${meter.sentTo(flashKey)}/${opts.flashLite})`
                : null;
      if (reason) {
        stopped = reason;
        meta.stops.push(`${part}: stopped — ${reason}`);
      }
      return reason;
    },
    observe(op) {
      if (op.errorCode === "SCHEMA_FAILED") schemaFailed = true;
      if (op.outcome === "error") {
        sameCodeFailures = op.errorCode === lastErrorCode ? sameCodeFailures + 1 : 1;
        lastErrorCode = op.errorCode ?? null;
      } else {
        sameCodeFailures = 0;
        lastErrorCode = null;
      }
    },
    async save(write) {
      meta.callsSent = meter.used;
      meta.blocked = meter.blocked;
      meta.otherFetches = meter.otherFetches;
      meta.wallTimeMs = Date.now() - started;
      await write();
    },
    async close() {
      meta.finishedAt = new Date().toISOString();
      await venv.close();
    },
  };
}

export function skippedItem(label: string, reason: string): OpRecord {
  return { label, startedAt: new Date().toISOString(), durationMs: 0, outcome: "skipped", httpCallSeqs: [], skippedReason: reason };
}

export function callsOfOp(calls: readonly HttpCall[], op: OpRecord): HttpCall[] {
  return calls.filter((call) => op.httpCallSeqs.includes(call.seq));
}

// What answered: the model of the operation's last 200, or "none".
export function answeredBy(calls: readonly HttpCall[], op: OpRecord): string {
  return [...callsOfOp(calls, op)].reverse().find((call) => call.status === 200)?.model ?? "none";
}

// Per-operation provider trouble worth naming. The primary's 429s are not listed per item: they are
// expected and summarised once in the header.
export function callConcerns(meta: PartMeta, calls: readonly HttpCall[], op: OpRecord, subject: string): string[] {
  return callsOfOp(calls, op).flatMap((call) => {
    if (call.model === meta.models.primary && call.status === 429) return [];
    if (call.outcome !== "response") return [`${subject}: call #${call.seq} (${call.model}) ${call.outcome}${call.failure ? ` (${call.failure})` : ""} after ${formatMs(call.latencyMs)}`];
    if (call.status !== 200) return [`${subject}: call #${call.seq} (${call.model}) returned HTTP ${call.status}${providerSaid(call)}`];
    return [];
  });
}

// The fallback-tier caveat every Ask/Compare/Draft table carries: which models actually answered.
export function measuredOn(meta: PartMeta, calls: readonly HttpCall[]): string {
  const answered = [...new Set(calls.filter((call) => call.status === 200).map((call) => call.model ?? "unknown"))];
  const primary = calls.filter((call) => call.model === meta.models.primary);
  const primaryNote =
    primary.length === 0
      ? `The primary \`${meta.models.primary}\` was not reached.`
      : `The primary \`${meta.models.primary}\` answered ${primary.map((call) => (call.outcome === "response" ? `HTTP ${call.status}${call.quotaWindow ? ` (${call.quotaWindow})` : ""}` : call.outcome)).join(", ")}; later primary attempts were refused locally by the harness's cap.`;
  const who = answered.length === 0 ? "no model answered" : `answered by ${answered.map((m) => `\`${m}\``).join(", ")}`;
  const fallback = answered.some((m) => m !== meta.models.primary);
  const primaryAnswered = answered.includes(meta.models.primary);
  const tier = fallback && primaryAnswered ? "the primary AND the FALLBACK tier (see each row's model)" : fallback ? "the FALLBACK tier" : "the primary";
  return `**Measured on ${tier}: ${who}.** ${primaryNote} The cap is the harness's (one real primary request per part, since the primary's daily quota is scarce), not the product's.`;
}

export function partHeader(meta: PartMeta, calls: readonly HttpCall[], title: string): string[] {
  const byModel = new Map<string, number>();
  for (const call of calls) byModel.set(call.model ?? "?", (byModel.get(call.model ?? "?") ?? 0) + 1);
  const refused = meta.blocked.filter((b) => b.reason === "cap").length;
  const budget = meta.blocked.filter((b) => b.reason !== "cap").length;
  return [
    `# ${title}`,
    "",
    `Mode **${meta.mode}** · started ${meta.startedAt} · wall time ${formatMs(meta.wallTimeMs ?? 0)} · provider requests sent **${meta.callsSent}** ` +
      `(${[...byModel].map(([m, n]) => `${m} ${n}`).join(", ") || "none"}) · refused locally: ${refused} by a per-model cap, ${budget} by the total · ` +
      `Flash-Lite allocation ${meta.flashLiteAllocation}`,
    "",
    measuredOn(meta, calls),
    "",
    ...(meta.stops.length > 0 ? [`**Stopped early:** ${meta.stops.join("; ")}`, ""] : []),
  ];
}

export function concernsList(concerns: string[]): string[] {
  return ["## Concerns", "", ...(concerns.length === 0 ? ["None — every measured value met its threshold."] : concerns.map((c) => `- ${c}`)), ""];
}

export function callsTableByModel(meta: PartMeta, calls: readonly HttpCall[]): string[] {
  const out = ["## Provider requests", "", "| # | Operation | Model (gateway) | Result | Latency |", "|---|---|---|---|---|"];
  for (const call of calls) {
    const result =
      call.outcome === "response"
        ? `HTTP ${call.status}${call.status === 429 ? ` (${call.quotaWindow})` : ""}${call.status !== 200 && call.errorMessage ? ` — ${cell(call.errorMessage, 90)}` : ""}`
        : `${call.outcome}${call.failure ? ` (${call.failure})` : ""}`;
    out.push(`| ${call.seq} | ${call.op} | ${call.model ?? "?"} (${call.provider}) | ${result} | ${formatMs(call.latencyMs)} (${call.latencyMs} ms) |`);
  }
  if (calls.length === 0) out.push("| — | none | | | |");
  const refused = meta.blocked;
  if (refused.length > 0) {
    out.push("", `Refused locally, never sent: ${refused.map((b) => `${b.op} → ${b.model} (${b.reason})`).join("; ")}.`);
  }
  return [...out, ""];
}

export async function writePart(outDir: string, name: string, json: unknown, markdown: string): Promise<void> {
  await writeOutput(outDir, `${name}.json`, JSON.stringify(json, null, 2));
  await writeOutput(outDir, `${name}.md`, markdown);
}

// Every key anywhere in a value, for structural checks that a shape carries no status/badge field.
export function deepKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((child) => deepKeys(child, into));
  else if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      deepKeys(child, into);
    }
  }
  return into;
}

export function canonicalFixtureText(text: string): string {
  return text.replace(/\n$/, "");
}
