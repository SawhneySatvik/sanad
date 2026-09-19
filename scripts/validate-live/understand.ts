// Live validation of Understand, plus Prepare's structural checks and the Gemma-path smoke.
//
// Order: Gemma smoke first (its own quota, and it also settles whether NIM/OpenRouter can answer
// within a longer timeout, even when the Gemini parts stop early), then Understand on all six
// fixtures, then Prepare on each analysed document. Every operation's raw result is written to disk
// as soon as it finishes, so `--render-only` rebuilds metrics and reports from those files with zero
// provider calls. Stop rules live in PartStop below; the call budget is shared with the other
// validate:live parts (ask, compare, draft).

import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError } from "@/server/core/errors";
import { detectDocumentType } from "@/server/deterministic/detect-type";
import { findMissingStandardClauses, STANDARD_CLAUSES_BY_DOCUMENT_TYPE, withoutModelCoveredGaps } from "@/server/deterministic/standard-clauses";
import { extractDocument } from "@/server/deterministic/extract";
import { MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "@/server/deterministic/verify";
import type { LlmProviders } from "@/server/container";
import { FakeLlmClient, type FakeLlmAttempt } from "@tests/support/fakes/llm-client";
import { createGeminiClient, createGemmaClient, geminiModelId } from "@/server/llm/providers";
import type { LlmClient, LlmCompleteInput } from "@/server/llm/types";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_LAWYER_QUESTIONS,
  PROMPT_VERSION as PREPARE_PROMPT_VERSION,
  prepareResponseSchema,
} from "@/server/prompts/prepare/prepare";
import {
  buildUnderstandResponseSchema,
  buildUnderstandSystemPrompt,
  buildUnderstandUserPrompt,
  PROMPT_VERSION as UNDERSTAND_PROMPT_VERSION,
} from "@/server/prompts/understand/analyze";
import { LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { withGlobalLimit } from "@/server/rate-limit/with-global-limit";
import { generate, type PrepareFindingRef } from "@/server/services/prepare";
import { analyze, analyzeDocument, DocumentAnalysisError, get, type UnderstandFinding } from "@/server/services/understand";
import { loadLiveValidationSet, type LiveValidationSet } from "../../tests/fixtures/live-validation/load";
import {
  type BlockedCall,
  cell,
  createValidationEnv,
  describeError,
  errorCode,
  formatMs,
  type HttpCall,
  loadEnvNames,
  pct,
  type Provider,
  ProviderMeter,
  readJsonOutput,
  sleep,
  type ValidationEnv,
  writeOutput,
} from "./harness";
import {
  type ChecklistMetrics,
  measureChecklist,
  measureUnderstand,
  RECALL_THRESHOLD,
  type UnderstandMetrics,
  VERIFIED_RATE_THRESHOLD,
} from "./understand-metrics";

export type DryRunMode = "clean" | "mutated";

export interface UnderstandRunOptions {
  outDir: string;
  budget: number;
  dryRun: DryRunMode | null;
  renderOnly: boolean;
  diagnoseGemini: boolean;
  // Skip the live Gemma smoke and record the fallback as UNVERIFIED on the recorded evidence.
  skipSmoke: boolean;
  // Attached to the previous live run when it is archived into `meta.history`.
  priorNote: string | null;
  priorLabel: string | null;
  note: string | null;
  // Only these fixtures (null: all six).
  fixtures: string[] | null;
  // Per-model ceilings on requests sent, keyed `${provider}:${model}` (null: none but the budget).
  caps: Record<string, number> | null;
}

// The smallest fixture with the fewest lenses: the cheapest Understand-sized call.
const SMOKE_FIXTURE = "privacy_policy";
// An earlier attempt's 20s call-site timeout is the likely cause of its inconclusive NIM result (see
// EXTERNAL_GEMMA_ATTEMPTS below); 90s applies to each gateway in the NIM → OpenRouter chain separately.
const SMOKE_TIMEOUT_MS = 90_000;
// Sequential pacing between Gemini-dependent operations: at most ~4.6 logical calls a minute, under
// the principal tier (5/min) and the Gemini global tier (7/min) even before latency.
export const MIN_GAP_BETWEEN_LLM_OPS_MS = 13_000;
const CLAIMED_QUOTE_KEEP_CHARS = 600;

export interface OpRecord {
  label: string;
  startedAt: string;
  durationMs: number;
  outcome: "ok" | "error" | "skipped";
  httpCallSeqs: number[];
  modelUsed?: string;
  error?: string;
  errorCode?: string;
  skippedReason?: string;
  // Structured events the services logged during this operation (llm_output_trimmed,
  // llm_provider_rejected): counts and ids only, by the services' own contract.
  events?: Record<string, unknown>[];
}

interface RawFinding {
  id: string;
  category: string;
  // The model's claim, kept only to show beside a not_found status (labelled as claimed). Verified
  // and approximate findings are always shown as the canonical span, never as this string.
  claimedQuote: string | null;
  claimedQuoteLength: number;
  lensExplanations: { lens: string; explanation: string }[];
  status: "verified" | "approximate" | "not_found" | null;
  spanStart: number | null;
  spanEnd: number | null;
  modelUsed: string;
  // "checklist": a deterministic standard-clause gap get() appends (no quote, never verified).
  // Absent in runs saved before the checklist existed, which hold model findings only.
  provenance?: "ai_generated" | "checklist";
  explanation?: string;
}

function isModelFinding(finding: RawFinding): boolean {
  return (finding.provenance ?? "ai_generated") === "ai_generated";
}

interface UnderstandFixtureRun {
  fixture: string;
  expectedDocumentType: string;
  op: OpRecord;
  documentId: string | null;
  document: {
    processingStatus: string;
    documentType: string | null;
    detectionConfidence: string | null;
    inputMode: string | null;
    canonicalTextHash: string | null;
  } | null;
  analysis: { promptVersion: string; modelUsed: string } | null;
  findings: RawFinding[] | null;
  // The one retry this fixture may spend after a transient provider/network failure.
  retry?: OpRecord;
}

interface PrepareRefRaw {
  id: string;
  category: string;
  status: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  spanText: string | null;
}

interface PrepareFixtureRun {
  fixture: string;
  op: OpRecord;
  state: string | null;
  modelUsed: string | null;
  promptVersion: string | null;
  lawyerQuestions: { question: string; whyItMatters: string; findingIds: string[]; findings: PrepareRefRaw[] }[];
  checklist: { item: string; findingIds: string[]; findings: PrepareRefRaw[] }[];
  markdown: string | null;
  retry?: OpRecord;
}

interface SmokeRun {
  fixture: string;
  timeoutMs: number;
  documentType: string;
  canonicalTextHash: string;
  op: OpRecord;
  // The provider whose response produced the parsed answer.
  gateway: Provider | null;
  parsed: boolean;
  findings: RawFinding[] | null;
}

interface RunMeta {
  mode: "live" | "dry-run:clean" | "dry-run:mutated";
  startedAt: string;
  finishedAt: string | null;
  wallTimeMs: number | null;
  budget: number;
  callsUsed: number;
  blockedCalls: BlockedCall[];
  otherFetches: number;
  env: Record<string, string>;
  primaryModelId: string;
  understandPromptVersion: string;
  preparePromptVersion: string;
  stops: string[];
  // Earlier live runs whose files this run overwrote, compacted: their calls and outcomes.
  history: PriorRun[];
  // Human review of this run's output that the numbers cannot show (--note, also at render time).
  notes?: string[];
}

interface PriorRun {
  startedAt: string;
  understandPromptVersion: string;
  callsUsed: number;
  stops: string[];
  calls: HttpCall[];
  outcomes: { label: string; outcome: string; detail: string | null }[];
  note: string | null;
  label?: string | null;
  fixtureMetrics?: PriorFixtureMetrics[];
}

interface PriorFixtureMetrics {
  fixture: string;
  modelUsed: string | null;
  latencyMs: number;
  findings: number;
  verified: number;
  claimedQuotes: number;
  requiredHit: number;
  requiredTotal: number;
  optional: number;
  unmatched: number;
  duplicates: number;
  categoryAgree: number;
  categoryTotal: number;
  missingClause: number;
  missedRequired: string[];
}

interface Run {
  meta: RunMeta;
  httpCalls: HttpCall[];
  smoke: SmokeRun | null;
  understand: UnderstandFixtureRun[];
  prepare: PrepareFixtureRun[];
  // Single direct calls made after a run to capture a provider's own error (--diagnose-gemini).
  diagnostics: OpRecord[];
}

export async function runUnderstand(opts: UnderstandRunOptions): Promise<number> {
  const set = loadLiveValidationSet();
  const run = opts.renderOnly
    ? await readRun(opts.outDir)
    : opts.diagnoseGemini
      ? await diagnoseGemini(set, opts.outDir)
      : await collect(set, opts);
  if (opts.note) run.meta.notes = [...(run.meta.notes ?? []), opts.note];
  const report = await render(set, run, opts.outDir);
  console.log(report.summary);
  if (opts.dryRun === null) return 0;
  const failures = dryRunSelfCheck(opts.dryRun, set, run, report);
  console.log(failures.length === 0 ? `DRY-RUN SELF-CHECK (${opts.dryRun}): PASS` : `DRY-RUN SELF-CHECK (${opts.dryRun}): FAIL\n- ${failures.join("\n- ")}`);
  return failures.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Collection (the only part that can spend provider calls)
// ---------------------------------------------------------------------------------------------

async function collect(set: LiveValidationSet, opts: UnderstandRunOptions): Promise<Run> {
  // A dry run never reads .env and gets a zero budget: any real provider request is refused locally.
  const env = opts.dryRun ? {} : loadEnvNames();
  const meter = new ProviderMeter(opts.dryRun ? 0 : opts.budget, opts.dryRun ? {} : (opts.caps ?? {}));
  meter.install();
  const providers: () => LlmProviders = opts.dryRun
    ? () => ({
        primary: new FakeLlmClient({ modelUsed: "dry-run-fake", defaultResponse: ({ input }) => fakeAnswer(set, opts.dryRun!, input) }),
        secondary: new FakeLlmClient({
          modelUsed: "dry-run-fake-secondary",
          defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", "dry run: the secondary never answers") },
        }),
      })
    : () => ({ primary: createGeminiClient(), secondary: createGemmaClient() });
  const primaryModelId = opts.dryRun ? "dry-run-fake" : geminiModelId();
  const started = Date.now();
  const run: Run = {
    meta: {
      mode: opts.dryRun ? `dry-run:${opts.dryRun}` : "live",
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      wallTimeMs: null,
      budget: meter.budget,
      callsUsed: 0,
      blockedCalls: [],
      otherFetches: 0,
      env,
      primaryModelId,
      understandPromptVersion: UNDERSTAND_PROMPT_VERSION,
      preparePromptVersion: PREPARE_PROMPT_VERSION,
      stops: [],
      // Only a live run is ever archived (see archivePriorRun); a dry run writes to a fresh temp dir.
      history: await archivePriorRun(opts.outDir, opts.priorNote, opts.priorLabel),
    },
    httpCalls: meter.calls,
    smoke: null,
    understand: [],
    prepare: [],
    diagnostics: [],
  };
  console.log(`[validate-live] mode=${run.meta.mode} budget=${meter.budget} primary=${primaryModelId}`);
  console.log(`[validate-live] env: ${Object.entries(env).map(([name, state]) => `${name}=${state}`).join(" ") || "(not loaded: dry run)"}`);

  // A dry run is not paced, so its limiter clock moves every check into a fresh one-minute window:
  // the tiers still count every call, they just never trip on a run that makes no real request.
  let tick = 0;
  const dryRunClock = { now: () => new Date(Date.now() + 61_000 * tick++) };
  const venv = await createValidationEnv(providers, primaryModelId, opts.dryRun ? { clock: dryRunClock } : undefined);
  const save = async () => {
    run.meta.callsUsed = meter.used;
    run.meta.blockedCalls = meter.blocked;
    run.meta.otherFetches = meter.otherFetches;
    run.meta.wallTimeMs = Date.now() - started;
    await writeRaw(opts.outDir, run);
  };
  let lastLlmOpStart = 0;
  const pace = async () => {
    if (opts.dryRun) return;
    const wait = lastLlmOpStart + MIN_GAP_BETWEEN_LLM_OPS_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastLlmOpStart = Date.now();
  };

  const retried = new Set<string>();
  const retries: RetryPolicy = {
    pace,
    take: (fixture) => {
      if (opts.dryRun || retried.has(fixture)) return false;
      retried.add(fixture);
      return true;
    },
  };

  const understandStop = new PartStop("understand", meter, run.meta.stops, !opts.dryRun);
  const prepareStop = new PartStop("prepare", meter, run.meta.stops, !opts.dryRun);
  try {
    run.smoke = opts.skipSmoke ? await skippedSmoke(set) : await smoke(set, venv, meter, opts.dryRun);
    logOp("smoke", run.smoke.op, `gateway=${run.smoke.gateway ?? "none"} parsed=${run.smoke.parsed}`);
    await save();

    // Each fixture's Prepare runs straight after its Understand, so a quota stop never leaves
    // analyses with no Prepare to show for them.
    // In the order given, so the most valuable fixture spends the budget first.
    const selected = opts.fixtures ? opts.fixtures.map((id) => set.fixtures.find((fixture) => fixture.id === id)!) : set.fixtures;
    for (const fixture of selected) {
      const short = !opts.dryRun && meter.remaining < 2 ? `fewer than 2 provider calls left (${meter.remaining}), not enough for this fixture's Understand and Prepare` : null;
      if (short && !run.meta.stops.some((stop) => stop.startsWith("understand"))) run.meta.stops.push(`understand: stopped — ${short}`);
      const stop = understandStop.reason() ?? short;
      const record = stop
        ? skippedUnderstand(fixture, stop)
        : await (async () => {
            await pace();
            return understandFixture(venv, meter, fixture, retries);
          })();
      run.understand.push(record);
      if (!stop) understandStop.observe(record.retry ?? record.op);
      logOp(`understand ${fixture.id}`, record.op, record.findings ? `findings=${record.findings.length}` : "");
      await save();
      await prepareStep(record);
    }
  } finally {
    run.meta.finishedAt = new Date().toISOString();
    await save();
    await venv.close();
  }
  return run;

  async function prepareStep(understood: UnderstandFixtureRun): Promise<void> {
    let record: PrepareFixtureRun;
    if (understood.documentId === null) {
      record = emptyPrepare(understood.fixture, skippedOp(`prepare:${understood.fixture}`, "no document was created"));
    } else if (understood.analysis === null) {
      // No analysis means generate() returns not_analyzed without an LLM call — a free check of the
      // typed state, so it runs even after a stop.
      record = await prepareFixture(venv, meter, understood.fixture, understood.documentId, retries);
    } else {
      const stop = prepareStop.reason();
      if (stop) {
        record = emptyPrepare(understood.fixture, skippedOp(`prepare:${understood.fixture}`, stop));
      } else {
        await pace();
        record = await prepareFixture(venv, meter, understood.fixture, understood.documentId, retries);
        prepareStop.observe(record.retry ?? record.op);
      }
    }
    run.prepare.push(record);
    logOp(`prepare ${understood.fixture}`, record.op, record.state ? `state=${record.state}` : "");
    await save();
  }
}

// Tracks one part's stop condition. Global conditions (a Gemini 429 anywhere, the budget) and the
// part's own (two Gemini timeouts, two consecutive same-code failures) both end it.
class PartStop {
  private lastErrorCode: string | null = null;
  private sameCodeFailures = 0;
  private stopped: string | null = null;
  private readonly firstSeq: number;

  constructor(
    private readonly part: string,
    private readonly meter: ProviderMeter,
    private readonly stops: string[],
    // Off in a dry run, whose zero budget exists only to refuse any real request at the fetch level.
    private readonly budgetStops: boolean,
  ) {
    this.firstSeq = meter.used;
  }

  observe(op: OpRecord): void {
    if (op.outcome === "error") {
      this.sameCodeFailures = op.errorCode === this.lastErrorCode ? this.sameCodeFailures + 1 : 1;
      this.lastErrorCode = op.errorCode ?? null;
    } else {
      this.sameCodeFailures = 0;
      this.lastErrorCode = null;
    }
  }

  reason(): string | null {
    if (this.stopped) return this.stopped;
    const quota = this.meter.calls.find((call) => call.provider === "gemini" && call.status === 429);
    const timeouts = this.meter.callsSince(this.firstSeq).filter((call) => call.provider === "gemini" && call.outcome === "aborted");
    const reason = quota
      ? `quota exhausted at call ${quota.seq} (gemini, ${quota.model ?? "model unknown"}, HTTP 429, window ${quota.quotaWindow})`
      : this.budgetStops && this.meter.remaining <= 0
        ? `call budget exhausted (${this.meter.used}/${this.meter.budget})`
        : timeouts.length >= 2
          ? `two Gemini requests aborted by the client-side timeout in this part (calls ${timeouts.map((c) => c.seq).join(", ")})`
          : this.sameCodeFailures >= 2
            ? `two consecutive operations failed with ${this.lastErrorCode}`
            : null;
    if (reason) {
      this.stopped = reason;
      this.stops.push(`${this.part}: stopped — ${reason}`);
    }
    return reason;
  }
}

export async function timed<T>(meter: ProviderMeter, label: string, fn: () => Promise<T>): Promise<{ op: OpRecord; value?: T; error?: unknown }> {
  meter.op = label;
  const seqBefore = meter.used;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const events: Record<string, unknown>[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    const event = typeof args[0] === "string" ? serviceEvent(args[0]) : null;
    if (event) events.push(event);
    warn(...args);
  };
  const finish = (outcome: "ok" | "error", extra: Partial<OpRecord>): OpRecord => ({
    label,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    outcome,
    httpCallSeqs: meter.callsSince(seqBefore).map((call) => call.seq),
    ...(events.length > 0 ? { events } : {}),
    ...extra,
  });
  try {
    const value = await fn();
    return { op: finish("ok", {}), value };
  } catch (error) {
    return { op: finish("error", { error: describeError(error), errorCode: errorCode(error) }), error };
  } finally {
    console.warn = warn;
    meter.op = "idle";
  }
}

function serviceEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && typeof (parsed as { event?: unknown }).event === "string"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// A failure worth the one retry: a Gemini request that died in transit (network error, client
// timeout, 5xx). A 4xx is permanent, a 429 is quota (the stop rule's business), and a 200 that
// failed parsing is the model's output, not a transient fault.
function transientFailure(meter: ProviderMeter, op: OpRecord): boolean {
  const gemini = meter.calls.filter((call) => op.httpCallSeqs.includes(call.seq) && call.provider === "gemini");
  const permanent = gemini.some((call) => call.status !== null && call.status >= 400 && call.status < 500);
  const transient = gemini.some((call) => call.outcome !== "response" || (call.status !== null && call.status >= 500));
  return op.outcome === "error" && transient && !permanent;
}

interface RetryPolicy {
  // Pacing and the budget apply to a retry exactly as to any other Gemini-dependent operation.
  pace(): Promise<void>;
  // At most one retry per fixture across Understand and Prepare.
  take(fixture: string): boolean;
}

export function skippedOp(label: string, reason: string): OpRecord {
  return { label, startedAt: new Date().toISOString(), durationMs: 0, outcome: "skipped", httpCallSeqs: [], skippedReason: reason };
}

function skippedUnderstand(fixture: LiveValidationSet["fixtures"][number], reason: string): UnderstandFixtureRun {
  return {
    fixture: fixture.id,
    expectedDocumentType: fixture.expectedDocumentType,
    op: skippedOp(`understand:${fixture.id}`, reason),
    documentId: null,
    document: null,
    analysis: null,
    findings: null,
  };
}

function toRawFinding(finding: UnderstandFinding): RawFinding {
  const v = finding.verification;
  return {
    id: finding.id,
    category: finding.category,
    claimedQuote: finding.quote === null ? null : finding.quote.slice(0, CLAIMED_QUOTE_KEEP_CHARS),
    claimedQuoteLength: finding.quote?.length ?? 0,
    lensExplanations: finding.lensExplanations,
    status: v?.status ?? null,
    spanStart: v?.spanStart ?? null,
    spanEnd: v?.spanEnd ?? null,
    modelUsed: finding.modelUsed,
    provenance: finding.provenance,
    explanation: finding.explanation,
  };
}

// The real service path for a text fixture: the upload relay's storage calls, then analyze()
// (confirmUpload → pending row → text/plain extraction → type detection → one LLM call → verify →
// persist), then a fresh get() — the read path every client sees, which re-verifies every quote.
async function understandFixture(
  venv: ValidationEnv,
  meter: ProviderMeter,
  fixture: LiveValidationSet["fixtures"][number],
  retries: RetryPolicy,
): Promise<UnderstandFixtureRun> {
  let documentId: string | null = null;
  const { op, value, error } = await timed(meter, `understand:${fixture.id}`, async () => {
    const input = await venv.uploadText(`${fixture.id}.txt`, fixture.text);
    const analysed = await analyze(venv.deps(), venv.principal, input);
    documentId = analysed.document.id;
    return analysed;
  });
  if (error instanceof DocumentAnalysisError) documentId = error.documentId;
  if (value) op.modelUsed = value.analysis.modelUsed;

  if (documentId === null) {
    return { fixture: fixture.id, expectedDocumentType: fixture.expectedDocumentType, op, documentId, document: null, analysis: null, findings: null };
  }
  // The product's own retry entry point (POST /api/documents/:id/analyze) on the same document.
  let retry: OpRecord | undefined;
  if (transientFailure(meter, op) && meter.remaining > 0 && retries.take(fixture.id)) {
    await retries.pace();
    const id = documentId;
    const second = await timed(meter, `understand:${fixture.id}:retry`, () => analyzeDocument(venv.deps(), venv.principal, id));
    if (second.value) second.op.modelUsed = second.value.analysis.modelUsed;
    retry = second.op;
    logOp(`understand ${fixture.id} (retry)`, retry, "");
  }
  // No LLM on the read path: a deps object whose llm throws if touched.
  const read = await get(venv.container.forRequest(venv.principal, false), venv.principal, documentId);
  return {
    fixture: fixture.id,
    expectedDocumentType: fixture.expectedDocumentType,
    op,
    documentId,
    document: {
      processingStatus: read.document.processingStatus,
      documentType: read.document.documentType,
      detectionConfidence: read.document.detectionConfidence,
      inputMode: read.document.inputMode,
      canonicalTextHash: read.document.canonicalTextHash,
    },
    analysis: read.analysisState === "complete" ? { promptVersion: read.analysis.promptVersion, modelUsed: read.analysis.modelUsed } : null,
    findings: read.analysisState === "complete" ? read.findings.map(toRawFinding) : null,
    ...(retry ? { retry } : {}),
  };
}

function emptyPrepare(fixture: string, op: OpRecord): PrepareFixtureRun {
  return { fixture, op, state: null, modelUsed: null, promptVersion: null, lawyerQuestions: [], checklist: [], markdown: null };
}

function toPrepareRef(ref: PrepareFindingRef): PrepareRefRaw {
  return {
    id: ref.id,
    category: ref.category,
    status: ref.verification?.status ?? null,
    spanStart: ref.verification?.spanStart ?? null,
    spanEnd: ref.verification?.spanEnd ?? null,
    spanText: ref.verification?.spanText ?? null,
  };
}

async function prepareFixture(
  venv: ValidationEnv,
  meter: ProviderMeter,
  fixture: string,
  documentId: string,
  retries: RetryPolicy,
): Promise<PrepareFixtureRun> {
  const first = await timed(meter, `prepare:${fixture}`, () => generate(venv.deps(), venv.principal, documentId));
  let { value } = first;
  let retry: OpRecord | undefined;
  if (transientFailure(meter, first.op) && meter.remaining > 0 && retries.take(fixture)) {
    await retries.pace();
    const second = await timed(meter, `prepare:${fixture}:retry`, () => generate(venv.deps(), venv.principal, documentId));
    value = second.value;
    retry = second.op;
    logOp(`prepare ${fixture} (retry)`, retry, "");
  }
  const op = first.op;
  const extra = retry ? { retry } : {};
  if (!value) return { ...emptyPrepare(fixture, op), ...extra };
  if (value.state !== "complete") return { ...emptyPrepare(fixture, op), state: value.state, ...extra };
  (retry ?? op).modelUsed = value.modelUsed;
  return {
    ...extra,
    fixture,
    op,
    state: value.state,
    modelUsed: value.modelUsed,
    promptVersion: value.promptVersion,
    lawyerQuestions: value.lawyerQuestions.map((q) => ({
      question: q.question,
      whyItMatters: q.whyItMatters,
      findingIds: q.findingIds,
      findings: q.findings.map(toPrepareRef),
    })),
    checklist: value.checklist.map((c) => ({ item: c.item, findingIds: c.findingIds, findings: c.findings.map(toPrepareRef) })),
    markdown: value.markdown,
  };
}

async function canonicalOf(text: string): Promise<{ canonicalText: string; canonicalTextHash: string }> {
  const extracted = await extractDocument({ pastedText: text });
  if (extracted.kind !== "extracted") throw new Error("fixture did not extract as text");
  return { canonicalText: extracted.canonicalText, canonicalTextHash: extracted.canonicalTextHash };
}

// One Understand-sized call straight through the Gemma path (providers.ts's NIM → OpenRouter
// fallback), behind the gemma global tier, with the Understand prompt and schema for the fixture's
// detected type. Its quotes go through verify() against the fixture's canonical text.
async function smoke(set: LiveValidationSet, venv: ValidationEnv, meter: ProviderMeter, dryRun: DryRunMode | null): Promise<SmokeRun> {
  const fixture = set.fixtures.find((f) => f.id === SMOKE_FIXTURE)!;
  const { canonicalText, canonicalTextHash } = await canonicalOf(fixture.text);
  const documentType = detectDocumentType(canonicalText).documentType;
  const gemmaPath: LlmClient = dryRun
    ? new FakeLlmClient({ modelUsed: "dry-run-fake-gemma", defaultResponse: ({ input }) => fakeAnswer(set, dryRun, input) })
    : createGemmaClient();
  const client = withGlobalLimit(gemmaPath, { db: venv.t.db, providerKey: "gemma" });
  const { op, value } = await timed(meter, `smoke:${fixture.id}`, () =>
    client.complete({
      systemPrompt: buildUnderstandSystemPrompt(documentType),
      userPrompt: buildUnderstandUserPrompt({ canonicalText, canonicalTextHash }),
      schema: buildUnderstandResponseSchema(documentType),
      timeoutMs: SMOKE_TIMEOUT_MS,
    }),
  );
  const answered = [...meter.calls].reverse().find((call) => op.httpCallSeqs.includes(call.seq) && call.status === 200);
  const base = { fixture: fixture.id, timeoutMs: SMOKE_TIMEOUT_MS, documentType, canonicalTextHash, op };
  if (!value) return { ...base, gateway: null, parsed: false, findings: null };
  op.modelUsed = value.modelUsed;

  // Understand's own rule (services/understand.ts toClaims): a missing_clause or blank quote is no quote.
  const lenses = LENSES_BY_DOCUMENT_TYPE[documentType];
  const claims = value.data.findings.map((finding) => ({
    category: finding.category,
    quote: finding.category === "missing_clause" || finding.quote === null || finding.quote.trim() === "" ? null : finding.quote,
    lensExplanations: lenses.map((lens) => ({ lens: lens.id, explanation: finding.lensExplanations[lens.id] })),
  }));
  const quoted = claims.flatMap((claim) => (claim.quote === null ? [] : [claim.quote]));
  const results: VerifyResult[] = [];
  for (let start = 0; start < quoted.length; start += MAX_QUOTES_PER_CALL) {
    results.push(...verifyMany(quoted.slice(start, start + MAX_QUOTES_PER_CALL), canonicalText, "text"));
  }
  let next = 0;
  const findings: RawFinding[] = claims.map((claim, i) => {
    const v = claim.quote === null ? null : results[next++];
    return {
      id: `S${i + 1}`,
      category: claim.category,
      claimedQuote: claim.quote === null ? null : claim.quote.slice(0, CLAIMED_QUOTE_KEEP_CHARS),
      claimedQuoteLength: claim.quote?.length ?? 0,
      lensExplanations: claim.lensExplanations,
      status: v?.status ?? null,
      spanStart: v?.spanStart ?? null,
      spanEnd: v?.spanEnd ?? null,
      modelUsed: value.modelUsed,
      provenance: "ai_generated",
      explanation: claim.lensExplanations[0]?.explanation ?? "",
    };
  });
  return { ...base, gateway: answered?.provider ?? null, parsed: true, findings };
}

export function logOp(what: string, op: OpRecord, extra: string): void {
  const outcome = op.outcome === "skipped" ? `skipped (${op.skippedReason})` : op.outcome === "error" ? `error (${op.error})` : "ok";
  console.log(
    `[validate-live] ${what}: ${outcome} ${formatMs(op.durationMs)} calls=[${op.httpCallSeqs.join(",")}] model=${op.modelUsed ?? "-"} ${extra}`.trim(),
  );
}

// ---------------------------------------------------------------------------------------------
// Dry run: FakeLlmClient answers built from the golden keys, through the same container wiring
// ---------------------------------------------------------------------------------------------

const DRY_RUN_FABRICATED_QUOTE = "Dry run: this sentence appears nowhere in any fixture.";

// Mutated mode drops two required anchored entries (never a carrier, so no optional entry can
// re-credit them), adds one fabricated quote and repeats one anchor: recall must fall by exactly 2,
// and not_found, unmatched and duplicates must each be exactly 1.
function droppedEntryIds(entries: LiveValidationSet["fixtures"][number]["keyFile"]["entries"]): string[] {
  const carriers = new Set(entries.flatMap((entry) => entry.carriedBy ?? []));
  return entries.filter((entry) => entry.required && entry.anchor !== null && !carriers.has(entry.id)).slice(0, 2).map((entry) => entry.id);
}

// Mutated mode also drops the NDA's required missing clauses, which the checklist finds on its own:
// the model line must lose them and the combined line must get them back.
const CHECKLIST_PROBE_FIXTURE = "nda";

function droppedMissingClauseIds(fixtureId: string, entries: LiveValidationSet["fixtures"][number]["keyFile"]["entries"]): string[] {
  if (fixtureId !== CHECKLIST_PROBE_FIXTURE) return [];
  return entries.filter((entry) => entry.required && entry.category === "missing_clause").map((entry) => entry.id);
}

function fakeAnswer(set: LiveValidationSet, mode: DryRunMode, input: LlmCompleteInput<z.ZodType>): FakeLlmAttempt {
  if (input.schema === prepareResponseSchema) {
    const aliases = [...input.userPrompt.matchAll(/<<<FINDINGS-[0-9a-f]{16} (F\d+)>>>/g)].map((match) => match[1]);
    return {
      data: {
        lawyerQuestions: [
          { question: "Dry run: what does this clause mean for me?", whyItMatters: "Dry run.", findingIds: aliases.slice(0, 2) },
          // Never offered, so prepare.ts must drop this question.
          { question: "Dry run: an invented reference.", whyItMatters: "Dry run.", findingIds: ["F999"] },
        ],
        // The last alias: checklist gaps are offered after the model's findings.
        checklist: [{ item: "Dry run: bring the signed copy.", findingIds: [aliases[aliases.length - 1], aliases[aliases.length - 1]] }],
      },
    };
  }
  const fixture = set.fixtures.find((f) => input.userPrompt.includes(f.text.replace(/\n$/, "")));
  if (!fixture) throw new Error("dry run: the prompt carries no known fixture");
  const documentType = detectDocumentType(fixture.text.replace(/\n$/, "")).documentType;
  const explain = (text: string) => Object.fromEntries(LENSES_BY_DOCUMENT_TYPE[documentType].map((lens) => [lens.id, text]));
  const dropped = mode === "mutated" ? [...droppedEntryIds(fixture.keyFile.entries), ...droppedMissingClauseIds(fixture.id, fixture.keyFile.entries)] : [];
  const kept = fixture.keyFile.entries.filter((entry) => !dropped.includes(entry.id));
  const findings = kept.map((entry) =>
    entry.anchor === null
      ? { category: "missing_clause", quote: null, lensExplanations: explain(`Dry run: the document has no clause on ${entry.matchKeywords![0]}.`) }
      : { category: entry.category, quote: entry.anchor, lensExplanations: explain(`Dry run: ${entry.id}.`) },
  );
  if (mode === "mutated") {
    const repeated = kept.find((entry) => entry.anchor !== null)!;
    findings.push({ category: "penalty", quote: DRY_RUN_FABRICATED_QUOTE, lensExplanations: explain("Dry run: fabricated.") });
    findings.push({ category: repeated.category, quote: repeated.anchor, lensExplanations: explain("Dry run: repeated.") });
  }
  return { data: { findings } };
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

async function writeRaw(outDir: string, run: Run, computed?: Computed): Promise<void> {
  const callsFor = (prefix: string) => run.httpCalls.filter((call) => call.op.startsWith(prefix));
  await writeOutput(
    outDir,
    "understand.json",
    JSON.stringify(
      { meta: run.meta, httpCalls: run.httpCalls, fixtures: run.understand, diagnostics: run.diagnostics, computed: computed?.understand ?? null },
      null,
      2,
    ),
  );
  await writeOutput(
    outDir,
    "prepare.json",
    JSON.stringify({ meta: run.meta, httpCalls: callsFor("prepare:"), fixtures: run.prepare, computed: computed?.prepare ?? null }, null, 2),
  );
  await writeOutput(
    outDir,
    "gemma-smoke.json",
    JSON.stringify({ meta: run.meta, httpCalls: callsFor("smoke:"), smoke: run.smoke, computed: computed?.smoke ?? null }, null, 2),
  );
}

async function readRun(outDir: string): Promise<Run> {
  const understand = await readJsonOutput<{ meta: RunMeta; httpCalls: HttpCall[]; fixtures: UnderstandFixtureRun[]; diagnostics?: OpRecord[] }>(
    outDir,
    "understand.json",
  );
  const prepare = await readJsonOutput<{ fixtures: PrepareFixtureRun[] }>(outDir, "prepare.json");
  const smokeFile = await readJsonOutput<{ smoke: SmokeRun | null }>(outDir, "gemma-smoke.json");
  return {
    meta: { ...understand.meta, history: understand.meta.history ?? [] },
    httpCalls: understand.httpCalls,
    smoke: smokeFile.smoke,
    understand: understand.fixtures,
    prepare: prepare.fixtures,
    diagnostics: understand.diagnostics ?? [],
  };
}

// The live run these files hold becomes a compact history entry of the run about to replace them, so a
// re-run never erases the evidence of what the previous one found.
async function archivePriorRun(outDir: string, note: string | null, label: string | null): Promise<PriorRun[]> {
  if (!existsSync(path.join(outDir, "understand.json"))) return [];
  const prior = await readRun(outDir);
  const saved = await readJsonOutput<{ computed: Computed["understand"] | null }>(outDir, "understand.json");
  if (prior.meta.mode !== "live") return prior.meta.history ?? [];
  const outcomes = [prior.smoke?.op, ...prior.understand.map((u) => u.op), ...prior.prepare.map((p) => p.op), ...prior.diagnostics]
    .filter((op): op is OpRecord => op !== undefined)
    .map((op) => ({ label: op.label, outcome: op.outcome, detail: op.error ?? op.skippedReason ?? null }));
  return [
    ...(prior.meta.history ?? []),
    {
      startedAt: prior.meta.startedAt,
      understandPromptVersion: prior.meta.understandPromptVersion,
      callsUsed: prior.meta.callsUsed,
      stops: prior.meta.stops,
      calls: prior.httpCalls,
      outcomes,
      note,
      label,
      fixtureMetrics: prior.understand.flatMap((u) => {
        const m = saved.computed?.fixtures.find((f) => f.fixture === u.fixture)?.metrics;
        if (!m) return [];
        return [
          {
            fixture: u.fixture,
            modelUsed: u.analysis?.modelUsed ?? null,
            latencyMs: (u.retry ?? u.op).durationMs,
            findings: m.findings,
            verified: m.verified,
            claimedQuotes: m.claimedQuotes,
            requiredHit: m.requiredHit,
            requiredTotal: m.requiredTotal,
            optional: m.optionalAssigned.length,
            unmatched: m.unmatchedFindingIds.length,
            duplicates: m.duplicateFindingIds.length,
            categoryAgree: m.categoryAgreement.agree,
            categoryTotal: m.categoryAgreement.total,
            missingClause: m.missingClauseFindings.length,
            missedRequired: m.missedRequired,
          },
        ];
      }),
    },
  ];
}

export const SKIPPED_SMOKE_REASON =
  "skipped: NIM has not answered within its timeout on 3 recorded attempts and OpenRouter's free quota is exhausted, so another attempt would spend budget without new information";

async function skippedSmoke(set: LiveValidationSet): Promise<SmokeRun> {
  const fixture = set.fixtures.find((f) => f.id === SMOKE_FIXTURE)!;
  const { canonicalText, canonicalTextHash } = await canonicalOf(fixture.text);
  return {
    fixture: fixture.id,
    timeoutMs: SMOKE_TIMEOUT_MS,
    documentType: detectDocumentType(canonicalText).documentType,
    canonicalTextHash,
    op: skippedOp(`smoke:${fixture.id}`, SKIPPED_SMOKE_REASON),
    gateway: null,
    parsed: false,
    findings: null,
  };
}

// Gemma-path attempts recorded outside this harness, cited by report. This script's own earlier
// attempts come from `meta.history`.
export const EXTERNAL_GEMMA_ATTEMPTS = [
  {
    source: "First probe (20 s call-site timeout)",
    // Ordering key only: this attempt predates every run captured in `meta.history`.
    at: "0",
    nim: "`google/gemma-4-31b-it`: TIMEOUT at 20,087 ms (the smoke script's 20 s call-site timeout), no HTTP response",
    openrouter: "`google/gemma-4-31b-it:free`: HTTP 429 at 878 ms",
  },
  {
    source: "Second probe (60 s timeout, minimal prompt)",
    // Ordering key only: between the first two runs captured in `meta.history`.
    at: "2026-09-23T07:30:00.000Z",
    nim: "`google/gemma-4-31b-it`: TIMEOUT at 60,017 ms (60 s timeout, minimal prompt), no HTTP response",
    openrouter: "not called",
  },
];

// The job_offer_letter Understand request failed fastest (1.4s, before any generation), so it is
// the cheapest to reproduce. One call, budget 1, straight through createGeminiClient() — no
// fallback, no limiter — so the provider's own error reaches the meter; appended to the saved run.
const DIAGNOSE_FIXTURE = "job_offer_letter";

async function diagnoseGemini(set: LiveValidationSet, outDir: string): Promise<Run> {
  const run = await readRun(outDir);
  loadEnvNames();
  const meter = new ProviderMeter(1);
  meter.install();
  const fixture = set.fixtures.find((f) => f.id === DIAGNOSE_FIXTURE)!;
  const { canonicalText, canonicalTextHash } = await canonicalOf(fixture.text);
  const documentType = detectDocumentType(canonicalText).documentType;
  const { op } = await timed(meter, `diagnose:gemini:${fixture.id}`, () =>
    createGeminiClient().complete({
      systemPrompt: buildUnderstandSystemPrompt(documentType),
      userPrompt: buildUnderstandUserPrompt({ canonicalText, canonicalTextHash }),
      schema: buildUnderstandResponseSchema(documentType),
    }),
  );
  const offset = run.httpCalls.length;
  for (const call of meter.calls) run.httpCalls.push({ ...call, seq: call.seq + offset });
  op.httpCallSeqs = op.httpCallSeqs.map((seq) => seq + offset);
  run.diagnostics.push(op);
  run.meta.callsUsed += meter.used;
  run.meta.blockedCalls.push(...meter.blocked);
  logOp(`diagnose gemini ${fixture.id}`, op, "");
  return run;
}

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

interface FixtureComputed {
  fixture: string;
  // Model findings only (provenance "ai_generated"), so recall stays comparable across runs.
  metrics: UnderstandMetrics | null;
  checklist: ChecklistComputed;
  // Model credits together with the checklist gaps a reader is shown; null when not analysed.
  combined: { hit: number; total: number; missingHit: number; missingTotal: number } | null;
  repairRetry: boolean;
  concerns: string[];
}

interface ChecklistComputed extends ChecklistMetrics {
  documentType: string;
  hasChecklist: boolean;
  // Where the served set came from: get()'s own findings, a recompute for a run saved before the
  // checklist existed, or nothing because the document was never analysed.
  source: "served by get()" | "recomputed (this run predates the checklist)" | "not analysed";
  // Served checklist findings the harness's recompute does not reproduce, or the reverse.
  mismatches: number;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface Computed {
  understand: {
    fixtures: FixtureComputed[];
    aggregate: {
      analysedFixtures: number;
      claimedQuotes: number;
      verified: number;
      approximate: number;
      notFound: number;
      requiredTotal: number;
      requiredHit: number;
      findings: number;
      unmatched: number;
      duplicates: number;
      outOfEnum: number;
      optionalAssigned: number;
    } & ReturnType<typeof missingClauseLines>;
    concerns: string[];
  };
  prepare: { schemaCheck: Check; fixtures: { fixture: string; checks: Check[] }[]; concerns: string[] };
  smoke: { metrics: UnderstandMetrics | null; repairRetry: boolean; concerns: string[] };
}

function callsOf(run: Run, op: OpRecord): HttpCall[] {
  return run.httpCalls.filter((call) => op.httpCallSeqs.includes(call.seq));
}

// Summary of a service's llm_output_trimmed event: every field but the identifying ones.
export function trimSummary(event: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(event).filter(([key]) => !["event", "surface", "documentId", "modelUsed"].includes(key)));
  return JSON.stringify(rest);
}

function trimEvents(ops: (OpRecord | undefined)[]): Record<string, unknown>[] {
  return ops.flatMap((op) => op?.events ?? []).filter((event) => event.event === "llm_output_trimmed");
}

function retryAndEventConcerns(run: Run, op: OpRecord, retry: OpRecord | undefined, subject: string): string[] {
  const concerns: string[] = [];
  if (retry) {
    concerns.push(`${subject}: first attempt failed transiently (${op.error}); retried once via the product's retry path — ${retry.outcome}${retry.error ? ` (${retry.error})` : ""}`);
    concerns.push(...opConcerns(run, retry, `${subject} (retry)`));
  }
  for (const event of trimEvents([op, retry])) concerns.push(`${subject}: the service trimmed model output (the service's trim log) — ${trimSummary(event)}`);
  return concerns;
}

export function providerSaid(call: HttpCall): string {
  if (call.errorStatus === undefined && call.errorMessage === undefined) return " (error body not captured)";
  return ` — provider said: ${cell(`${call.errorStatus ?? "?"}: ${call.errorMessage ?? "(no message)"}`, 320)}`;
}

// Two successful responses from one provider within one operation = the schema-repair retry fired.
export function hadRepairRetry(calls: HttpCall[]): boolean {
  const ok = calls.filter((call) => call.status === 200);
  return ok.some((call, i) => ok.findIndex((other) => other.provider === call.provider) !== i);
}

function opConcerns(run: Run, op: OpRecord, subject: string): string[] {
  const concerns: string[] = [];
  const calls = callsOf(run, op);
  for (const call of calls) {
    if (call.outcome === "aborted") concerns.push(`${subject}: call #${call.seq} (${call.provider}) aborted by the client-side timeout after ${formatMs(call.latencyMs)}`);
    else if (call.status === 429) {
      concerns.push(`${subject}: quota exhausted at call ${call.seq} (${call.provider}, ${call.model ?? "model unknown"}) — HTTP 429, window ${call.quotaWindow}${providerSaid(call)}`);
    } else if (call.status !== null && call.status !== 200) {
      concerns.push(`${subject}: call #${call.seq} (${call.provider}, ${call.model ?? "model unknown"}) returned HTTP ${call.status}${providerSaid(call)}`);
    } else if (call.outcome === "network_error") concerns.push(`${subject}: call #${call.seq} (${call.provider}) failed with a network error`);
  }
  if (hadRepairRetry(calls)) concerns.push(`${subject}: the schema-repair retry fired (two successful responses from one provider)`);
  return concerns;
}

function metricConcerns(subject: string, m: UnderstandMetrics): string[] {
  const concerns: string[] = [];
  if (m.verifiedRate === null) concerns.push(`${subject}: no claimed quotes at all (verified rate undefined)`);
  else if (m.verifiedRate < VERIFIED_RATE_THRESHOLD) {
    concerns.push(`${subject}: verified rate ${pct(m.verified, m.claimedQuotes)} (${m.verified}/${m.claimedQuotes}) < ${VERIFIED_RATE_THRESHOLD * 100}%`);
  }
  if (m.recall < RECALL_THRESHOLD) {
    concerns.push(`${subject}: recall ${pct(m.requiredHit, m.requiredTotal)} (${m.requiredHit}/${m.requiredTotal}) < ${RECALL_THRESHOLD * 100}%`);
  }
  if (m.outOfEnum > 0) concerns.push(`${subject}: ${m.outOfEnum} finding(s) with a category outside the five allowed categories`);
  if (m.unquotedNonMissing > 0) concerns.push(`${subject}: ${m.unquotedNonMissing} non-missing_clause finding(s) carry no quote at all`);
  return concerns;
}

// The three missing-protection lines over the analysed fixtures that have a checklist, plus the
// checklist alone over every fixture, analysed or not (it needs no model).
function missingClauseLines(
  set: LiveValidationSet,
  fixtures: FixtureComputed[],
  canonical: Map<string, { canonicalText: string }>,
) {
  const analysed = fixtures.filter((f) => f.metrics !== null && f.checklist.hasChecklist);
  const modelCredited = (f: FixtureComputed) => new Set([...f.metrics!.requiredAssigned, ...f.metrics!.requiredCarried.map((c) => c.entryId)]);
  const everyFixture = set.fixtures.map((fixture) => checklistFor(fixture.keyFile.entries, canonical.get(fixture.id)!.canonicalText, null));
  const withChecklist = everyFixture.filter((c) => c.hasChecklist);
  return {
    missingTotal: analysed.reduce((n, f) => n + f.checklist.requiredMissing.length, 0),
    modelMissingHit: analysed.reduce((n, f) => n + f.checklist.requiredMissing.filter((id) => modelCredited(f).has(id)).length, 0),
    checklistMissingHit: analysed.reduce((n, f) => n + f.checklist.credited.length, 0),
    combinedMissingHit: analysed.reduce((n, f) => n + f.combined!.missingHit, 0),
    combinedHit: fixtures.reduce((n, f) => n + (f.combined?.hit ?? 0), 0),
    combinedTotal: fixtures.reduce((n, f) => n + (f.combined?.total ?? 0), 0),
    checklistEveryFixtureHit: withChecklist.reduce((n, c) => n + c.credited.length, 0),
    checklistEveryFixtureTotal: withChecklist.reduce((n, c) => n + c.requiredMissing.length, 0),
    checklistGapsEveryFixture: withChecklist.reduce((n, c) => n + c.gaps.length, 0),
    checklistUnconfirmedEveryFixture: withChecklist.reduce((n, c) => n + c.unconfirmed, 0),
  };
}

// The checklist's own gaps for a fixture, recomputed from its text exactly as get() computes them,
// with which of them the reader was shown (get() drops a gap a model finding already covers).
function checklistFor(entries: LiveValidationSet["fixtures"][number]["keyFile"]["entries"], canonicalText: string, findings: RawFinding[] | null): ChecklistComputed {
  const documentType = detectDocumentType(canonicalText).documentType;
  const all = findMissingStandardClauses(documentType, canonicalText);
  const hasChecklist = STANDARD_CLAUSES_BY_DOCUMENT_TYPE[documentType].length > 0;
  let source: ChecklistComputed["source"] = "not analysed";
  let served = new Set<string>();
  let mismatches = 0;
  if (findings) {
    const modelExplanations = findings
      .filter((f) => isModelFinding(f) && f.category === "missing_clause")
      .map((f) => f.explanation ?? f.lensExplanations[0]?.explanation ?? "");
    const expected = new Set(withoutModelCoveredGaps(all, modelExplanations).map((gap) => gap.explanation));
    if (findings.some((f) => f.provenance !== undefined)) {
      source = "served by get()";
      served = new Set(findings.filter((f) => f.provenance === "checklist").map((f) => f.explanation ?? ""));
      mismatches = [...served].filter((e) => !expected.has(e)).length + [...expected].filter((e) => !served.has(e)).length;
    } else {
      source = "recomputed (this run predates the checklist)";
      served = expected;
    }
  }
  const metrics = measureChecklist(
    entries,
    all.map((gap) => ({ gapId: gap.id, topic: gap.topic, explanation: gap.explanation, served: served.has(gap.explanation) })),
  );
  return { ...metrics, documentType, hasChecklist, source, mismatches };
}

async function computeAll(set: LiveValidationSet, run: Run): Promise<Computed> {
  const canonical = new Map<string, { canonicalText: string; canonicalTextHash: string }>();
  for (const fixture of set.fixtures) canonical.set(fixture.id, await canonicalOf(fixture.text));

  const fixtures: FixtureComputed[] = run.understand.map((u) => {
    const fixture = set.fixtures.find((f) => f.id === u.fixture)!;
    const subject = `understand/${u.fixture}`;
    const concerns = [...opConcerns(run, u.op, subject), ...retryAndEventConcerns(run, u.op, u.retry, subject)];
    if (u.op.outcome === "skipped") concerns.push(`${subject}: not run — ${u.op.skippedReason}`);
    const final = u.retry ?? u.op;
    if (final.outcome === "error") concerns.push(`${subject}: analysis failed — ${final.error}`);
    const text = canonical.get(u.fixture)!;
    if (u.document?.canonicalTextHash && u.document.canonicalTextHash !== text.canonicalTextHash) {
      throw new Error(`${u.fixture}: stored canonical_text_hash differs from the fixture's — measuring against the wrong text`);
    }
    if (u.document && u.document.documentType !== fixture.expectedDocumentType) {
      concerns.push(`${subject}: detected type ${u.document.documentType} ≠ expected ${fixture.expectedDocumentType}`);
    }
    if (u.analysis && u.analysis.modelUsed !== run.meta.primaryModelId) {
      concerns.push(`${subject}: answered by the fallback model ${u.analysis.modelUsed}, not ${run.meta.primaryModelId}`);
    }
    const modelFindings = u.findings?.filter(isModelFinding) ?? null;
    const metrics = modelFindings ? measureUnderstand(text.canonicalText, fixture.keyFile.entries, modelFindings) : null;
    if (metrics) concerns.push(...metricConcerns(subject, metrics));
    const checklist = checklistFor(fixture.keyFile.entries, text.canonicalText, u.findings);
    for (const gap of checklist.gaps.filter((g) => g.matches.length === 0)) {
      const hint = gap.mayBeCoveredBy.map((h) => `${h.entryId} (${h.sharedWords.join(", ")})`).join("; ");
      concerns.push(`${subject}: checklist gap ${gap.gapId} is not confirmed by the key — either a gap the key lacks or a false absence claim${hint ? `; the document may cover it at ${hint}` : ""}`);
    }
    if (checklist.mismatches > 0) concerns.push(`${subject}: ${checklist.mismatches} checklist finding(s) served by get() differ from the harness's recompute`);
    let combined: FixtureComputed["combined"] = null;
    if (metrics) {
      const credited = new Set([...metrics.requiredAssigned, ...metrics.requiredCarried.map((c) => c.entryId), ...checklist.creditedServed]);
      combined = {
        hit: credited.size,
        total: metrics.requiredTotal,
        missingHit: checklist.requiredMissing.filter((id) => credited.has(id)).length,
        missingTotal: checklist.requiredMissing.length,
      };
    }
    return {
      fixture: u.fixture,
      metrics,
      checklist,
      combined,
      repairRetry: [u.op, u.retry].some((op) => op !== undefined && hadRepairRetry(callsOf(run, op))),
      concerns,
    };
  });

  const measured = fixtures.flatMap((f) => (f.metrics ? [f.metrics] : []));
  const sum = (pick: (m: UnderstandMetrics) => number) => measured.reduce((total, m) => total + pick(m), 0);
  const aggregate = {
    analysedFixtures: measured.length,
    claimedQuotes: sum((m) => m.claimedQuotes),
    verified: sum((m) => m.verified),
    approximate: sum((m) => m.approximate),
    notFound: sum((m) => m.notFound),
    requiredTotal: sum((m) => m.requiredTotal),
    requiredHit: sum((m) => m.requiredHit),
    findings: sum((m) => m.findings),
    unmatched: sum((m) => m.unmatchedFindingIds.length),
    duplicates: sum((m) => m.duplicateFindingIds.length),
    outOfEnum: sum((m) => m.outOfEnum),
    optionalAssigned: sum((m) => m.optionalAssigned.length),
    ...missingClauseLines(set, fixtures, canonical),
  };
  const aggregateConcerns: string[] = [];
  if (aggregate.analysedFixtures === 0) {
    aggregateConcerns.push(`understand/aggregate: NOT MEASURED — 0/${set.fixtures.length} fixtures analysed, so no Understand quality metric exists for this run`);
  } else if (aggregate.analysedFixtures < set.fixtures.length) {
    const unmeasured = set.fixtures.map((f) => f.id).filter((id) => !fixtures.some((f) => f.fixture === id && f.metrics !== null));
    const timedOut = run.understand.some((u) => u.findings === null && callsOf(run, u.op).some((call) => call.provider === "gemini" && call.outcome === "aborted"));
    aggregateConcerns.push(
      `understand/aggregate: only ${aggregate.analysedFixtures}/${set.fixtures.length} fixtures analysed — every aggregate below is partial; not measured: ${unmeasured.join(", ")}` +
        (timedOut ? ". The measured subset is latency-filtered: it is the fixtures whose Gemini call finished inside the client timeout, so it may not represent the ones that did not" : ""),
    );
  }
  for (const op of run.diagnostics) {
    aggregateConcerns.push(...opConcerns(run, op, `diagnostic ${op.label}`));
    if (op.outcome === "ok") aggregateConcerns.push(`diagnostic ${op.label}: the provider answered (not reproduced) — ${op.modelUsed}`);
    if (op.outcome === "error" && callsOf(run, op).length === 0) aggregateConcerns.push(`diagnostic ${op.label}: failed before any request — ${op.error}`);
  }
  if (aggregate.claimedQuotes > 0 && aggregate.verified / aggregate.claimedQuotes < VERIFIED_RATE_THRESHOLD) {
    aggregateConcerns.push(`understand/aggregate: verified rate ${pct(aggregate.verified, aggregate.claimedQuotes)} (${aggregate.verified}/${aggregate.claimedQuotes}) < 90%`);
  }
  if (aggregate.requiredTotal > 0 && aggregate.requiredHit / aggregate.requiredTotal < RECALL_THRESHOLD) {
    aggregateConcerns.push(`understand/aggregate: recall ${pct(aggregate.requiredHit, aggregate.requiredTotal)} (${aggregate.requiredHit}/${aggregate.requiredTotal}) < 80%`);
  }
  if (aggregate.outOfEnum > 0) aggregateConcerns.push(`understand/aggregate: ${aggregate.outOfEnum} out-of-enum categories`);

  const cmp = comparisonDrops(run, { fixtures, aggregate, concerns: [] });
  for (const row of cmp?.rows ?? []) {
    if (row.drops.length > 0) aggregateConcerns.push(`understand/${row.before.fixture}: quality drop vs Run ${cmp!.index + 1} — ${row.drops.join(", ")}`);
  }

  const schemaCheck = prepareSchemaCheck();
  const prepareFixtures = run.prepare.map((p) => {
    const u = run.understand.find((x) => x.fixture === p.fixture)!;
    return { fixture: p.fixture, checks: prepareChecks(p, u, canonical.get(p.fixture)!.canonicalText) };
  });
  const prepareConcerns: string[] = [];
  const generated = run.prepare.filter((p) => p.state === "complete").length;
  if (generated === 0) {
    prepareConcerns.push(`prepare: LLM path NOT MEASURED — 0/${set.fixtures.length} documents produced Prepare output; only the zero-call checks below ran`);
  }
  if (!schemaCheck.pass) prepareConcerns.push(`prepare: ${schemaCheck.name} — ${schemaCheck.detail}`);
  for (const p of run.prepare) {
    const subject = `prepare/${p.fixture}`;
    prepareConcerns.push(...opConcerns(run, p.op, subject), ...retryAndEventConcerns(run, p.op, p.retry, subject));
    if (p.op.outcome === "skipped") prepareConcerns.push(`${subject}: not run — ${p.op.skippedReason}`);
    if ((p.retry ?? p.op).outcome === "error") prepareConcerns.push(`${subject}: failed — ${(p.retry ?? p.op).error}`);
    for (const check of prepareFixtures.find((f) => f.fixture === p.fixture)!.checks) {
      if (!check.pass) prepareConcerns.push(`${subject}: ${check.name} FAILED — ${check.detail}`);
    }
    if (p.modelUsed && p.modelUsed !== run.meta.primaryModelId) prepareConcerns.push(`${subject}: answered by the fallback model ${p.modelUsed}`);
  }

  let smokeMetrics: UnderstandMetrics | null = null;
  const smokeConcerns: string[] = [];
  if (run.smoke) {
    const fixture = set.fixtures.find((f) => f.id === run.smoke!.fixture)!;
    smokeConcerns.push(...opConcerns(run, run.smoke.op, "gemma-smoke"));
    if (run.smoke.op.outcome === "skipped") smokeConcerns.push(`gemma-smoke: Gemma fallback UNVERIFIED — ${run.smoke.op.skippedReason}`);
    if (run.smoke.op.outcome === "error") smokeConcerns.push(`gemma-smoke: no answer — ${run.smoke.op.error}`);
    if (run.smoke.findings) {
      smokeMetrics = measureUnderstand(canonical.get(fixture.id)!.canonicalText, fixture.keyFile.entries, run.smoke.findings);
      smokeConcerns.push(...metricConcerns("gemma-smoke", smokeMetrics));
    }
  }

  return {
    understand: { fixtures, aggregate, concerns: [...aggregateConcerns, ...fixtures.flatMap((f) => f.concerns)] },
    prepare: { schemaCheck, fixtures: prepareFixtures, concerns: prepareConcerns },
    smoke: { metrics: smokeMetrics, repairRetry: run.smoke ? hadRepairRetry(callsOf(run, run.smoke.op)) : false, concerns: smokeConcerns },
  };
}

const FORBIDDEN_SCHEMA_KEYS = new Set(["status", "verified", "verification", "spanStart", "spanEnd", "quote_span_start", "quote_span_end"]);

function schemaKeys(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((child) => schemaKeys(child, into));
  else if (node !== null && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      into.add(key);
      schemaKeys(child, into);
    }
  }
  return into;
}

function prepareSchemaCheck(): Check {
  const found = [...schemaKeys(z.toJSONSchema(prepareResponseSchema), new Set())].filter((key) => FORBIDDEN_SCHEMA_KEYS.has(key));
  return {
    name: "Prepare response schema has no status/span field",
    pass: found.length === 0,
    detail: found.length === 0 ? "no status/verified/span key anywhere in the JSON schema" : `forbidden keys: ${found.join(", ")}`,
  };
}

// The Prepare Markdown renderer's label for a finding with no quote (module-private there).
const NOT_CHECKED_LABEL = "Flagged as possibly missing — not checked against the document";

// Built from code points, not literal \uXXXX escapes: some file-write tools turn a \uXXXX escape
// into an actual character, which would silently change which glyphs this matches. These are the
// badge glyphs the renderer must strip.
const BADGE_GLYPHS = new RegExp(`[${String.fromCodePoint(0x2705, 0x2713, 0x2714, 0x2611)}]`, "u");

function prepareChecks(p: PrepareFixtureRun, u: UnderstandFixtureRun, canonicalText: string): Check[] {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  if (p.op.outcome !== "ok") return checks;

  const expected = u.analysis === null ? ["not_analyzed"] : ["complete", "no_grounded_findings"];
  add("typed state", p.state !== null && expected.includes(p.state), `state=${p.state}; expected one of ${expected.join("/")}`);
  if (p.state !== "complete") return checks;

  const items = [...p.lawyerQuestions, ...p.checklist];
  const understood = new Map((u.findings ?? []).map((f) => [f.id, f]));
  add("non-empty", items.length > 0, `${p.lawyerQuestions.length} questions, ${p.checklist.length} checklist items`);
  add(
    "within caps",
    p.lawyerQuestions.length <= MAX_LAWYER_QUESTIONS && p.checklist.length <= MAX_CHECKLIST_ITEMS,
    `≤${MAX_LAWYER_QUESTIONS} questions, ≤${MAX_CHECKLIST_ITEMS} items`,
  );
  const unknownRefs = items.flatMap((item) => item.findingIds.filter((id) => !understood.has(id)));
  const unreferenced = items.filter((item) => item.findingIds.length === 0).length;
  const refMismatch = items.filter((item) => item.findings.map((f) => f.id).join() !== item.findingIds.join()).length;
  add(
    "every item references real finding ids",
    unknownRefs.length === 0 && unreferenced === 0 && refMismatch === 0,
    `${items.reduce((n, item) => n + item.findingIds.length, 0)} refs; unknown=${unknownRefs.length}; items with none=${unreferenced}; ids≠refs=${refMismatch}`,
  );
  const refs = items.flatMap((item) => item.findings);
  const ineligible = refs.filter((ref) => {
    const finding = understood.get(ref.id);
    return !finding || finding.status === "not_found" || (finding.status === null && finding.category !== "missing_clause");
  });
  add("every referenced finding is grounded (eligible)", ineligible.length === 0, `${ineligible.length} ineligible of ${refs.length}`);
  const statusMismatch = refs.filter((ref) => {
    const finding = understood.get(ref.id);
    return !finding || finding.status !== ref.status || finding.spanStart !== ref.spanStart || finding.spanEnd !== ref.spanEnd;
  });
  add("statuses/spans are get()'s, not the model's", statusMismatch.length === 0, `${statusMismatch.length} mismatches of ${refs.length}`);
  const sliceMismatch = refs.filter((ref) =>
    ref.spanStart === null || ref.spanEnd === null ? ref.spanText !== null : ref.spanText !== canonicalText.slice(ref.spanStart, ref.spanEnd),
  );
  add("spanText is the canonical slice", sliceMismatch.length === 0, `${sliceMismatch.length} mismatches of ${refs.length}`);

  const md = p.markdown ?? "";
  const lines = md.split("\n");
  const count = (prefix: string) => lines.filter((line) => line.startsWith(prefix)).length;
  add("markdown: not-legal-advice notice", md.includes("**This is not legal advice.**"), "");
  const q = count("- **AI-suggested question:**");
  const why = count("  **Why it may matter (AI-generated, not verified):**");
  const check = count("- **AI-suggested check:**");
  add(
    "markdown: every model-written line has its AI prefix",
    q === p.lawyerQuestions.length && why === p.lawyerQuestions.length && check === p.checklist.length,
    `question lines ${q}/${p.lawyerQuestions.length}, why lines ${why}/${p.lawyerQuestions.length}, check lines ${check}/${p.checklist.length}`,
  );
  add("markdown: no badge glyphs", !BADGE_GLYPHS.test(md), "");
  // Unquoted findings (model missing clauses and checklist gaps) have nothing to verify: each must be
  // cited with no status, under the renderer's "possibly missing — not checked" label.
  const unquoted = refs.filter((ref) => ref.status === null);
  const checklistRefs = refs.filter((ref) => understood.get(ref.id)?.provenance === "checklist").length;
  const labelLines = lines.filter((line) => line.includes(NOT_CHECKED_LABEL)).length;
  add(
    "unquoted findings cited under the not-checked label, with no status",
    unquoted.every((ref) => ref.category === "missing_clause" && ref.spanText === null) && labelLines === unquoted.length,
    `${unquoted.length} unquoted refs (${checklistRefs} checklist gaps), ${labelLines} label lines`,
  );
  // The per-call aliases (F1, F2…) mean nothing to a reader; the service scrubs them from model text.
  const aiTexts = [...p.lawyerQuestions.map((x) => `${x.question} ${x.whyItMatters}`), ...p.checklist.map((x) => x.item)];
  const leaking = aiTexts.filter((text) => /\bF\d+\b/.test(text)).length;
  add("no internal finding aliases (F1…) in AI-written text", leaking === 0, `${leaking}/${aiTexts.length} items leak an alias`);
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

interface Report {
  computed: Computed;
  summary: string;
}

async function render(set: LiveValidationSet, run: Run, outDir: string): Promise<Report> {
  const computed = await computeAll(set, run);
  const canonical = new Map<string, string>();
  for (const fixture of set.fixtures) canonical.set(fixture.id, (await canonicalOf(fixture.text)).canonicalText);
  await writeRaw(outDir, run, computed);
  await writeOutput(outDir, "understand.md", renderUnderstandMd(set, run, computed, canonical));
  await writeOutput(outDir, "prepare.md", renderPrepareMd(run, computed));
  await writeOutput(outDir, "gemma-smoke.md", renderSmokeMd(run, computed, canonical));
  return { computed, summary: renderSummary(run, computed, outDir) };
}

// Calls saved before refusals carried a reason were all budget refusals.
function refusedBy(run: Run, reason: "cap" | "budget"): number {
  return run.meta.blockedCalls.filter((b) => (b.reason ?? "budget") === reason).length;
}

function header(run: Run, title: string): string[] {
  title = run.meta.mode === "live" ? `${title} — Run ${run.meta.history.length + 1}` : title;
  const byProvider = (provider: Provider) => run.httpCalls.filter((call) => call.provider === provider).length;
  return [
    `# ${title}`,
    "",
    `Mode **${run.meta.mode}** · started ${run.meta.startedAt} · wall time ${formatMs(run.meta.wallTimeMs ?? 0)} · provider calls **${run.meta.callsUsed}/${run.meta.budget}** ` +
      `(gemini ${byProvider("gemini")}, nim ${byProvider("nim")}, openrouter ${byProvider("openrouter")}; refused locally: ${refusedBy(run, "cap")} by a per-model cap, ${refusedBy(run, "budget")} by the budget) · ` +
      `primary model \`${run.meta.primaryModelId}\` · prompts \`${run.meta.understandPromptVersion}\`, \`${run.meta.preparePromptVersion}\``,
    "",
    ...(run.meta.stops.length > 0 ? [`**Stopped early:** ${run.meta.stops.join("; ")}`, ""] : []),
  ];
}

// A reviewer note starting "Prepare:" belongs to prepare.md; every other note to understand.md.
function notesFor(run: Run, report: "understand" | "prepare"): string[] {
  return (run.meta.notes ?? []).filter((note) => note.startsWith("Prepare:") === (report === "prepare"));
}

function concernsBlock(concerns: string[], notes: string[] = []): string[] {
  return [
    "## Concerns",
    "",
    ...(concerns.length === 0 ? ["None — every measured value met its threshold."] : concerns.map((c) => `- ${c}`)),
    "",
    ...(notes.length > 0 ? ["### Reviewer notes (human review of this run's output)", "", ...notes.map((n) => `- ${n}`), ""] : []),
  ];
}

// Finding ids are UUIDv7: rows inserted together share their time-ordered prefix, so show the tail.
function shortId(id: string): string {
  return id.slice(-8);
}

function statusLabel(finding: RawFinding): string {
  return finding.status ?? (finding.category === "missing_clause" ? "— (missing clause)" : "— (no quote)");
}

// What a reader is shown for a finding: the canonical span for verified/approximate (the
// span-binding channel of the One Guarantee), the model's claim — labelled — only for not_found.
function shownText(finding: RawFinding, canonicalText: string): string {
  if (finding.status === "verified" || finding.status === "approximate") return `span: "${cell(canonicalText.slice(finding.spanStart!, finding.spanEnd!), 220)}"`;
  if (finding.status === "not_found") return `claimed (not in document): "${cell(finding.claimedQuote ?? "", 220)}"`;
  return "(no quote)";
}

// One finding verify() did not fully confirm (else one matching no key entry), and one verified
// finding credited to a required entry — a penalty or ambiguity if there is one.
function samplesFor(u: UnderstandFixtureRun, m: UnderstandMetrics): RawFinding[] {
  const findings = u.findings ?? [];
  const byId = (id: string | undefined) => findings.find((f) => f.id === id);
  const shaky = findings.find((f) => f.status === "not_found" || f.status === "approximate") ?? byId(m.unmatchedFindingIds[0]);
  const assigned = m.assignments.filter((a) => a.required && a.kind === "anchored");
  const pick = assigned.find((a) => ["penalty", "ambiguity"].includes(byId(a.findingId)?.category ?? "")) ?? assigned[0];
  const good = byId(pick?.findingId);
  const samples = [shaky, good].filter((f): f is RawFinding => f !== undefined);
  return samples.filter((f, i) => samples.indexOf(f) === i);
}

// This run against the latest earlier run that measured any fixture, on the fixtures both measured.
// Flagged as a drop: a lower verified rate, recall or category agreement, fewer missing-clause
// findings, or a larger share of findings matching no key entry.
function comparisonDrops(run: Run, c: Computed["understand"]): { index: number; prior: PriorRun; rows: { now: UnderstandMetrics; latencyMs: number; before: PriorFixtureMetrics; drops: string[] }[] } | null {
  const index = run.meta.history.findLastIndex((prior) => (prior.fixtureMetrics ?? []).length > 0);
  if (index === -1) return null;
  const prior = run.meta.history[index];
  const rows = (prior.fixtureMetrics ?? []).flatMap((before) => {
    const now = c.fixtures.find((f) => f.fixture === before.fixture)?.metrics;
    const u = run.understand.find((x) => x.fixture === before.fixture);
    if (!now || !u) return [];
    const drops: string[] = [];
    const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
    if (ratio(now.verified, now.claimedQuotes) < ratio(before.verified, before.claimedQuotes)) drops.push("verified rate");
    if (ratio(now.requiredHit, now.requiredTotal) < ratio(before.requiredHit, before.requiredTotal)) drops.push("recall");
    if (ratio(now.categoryAgreement.agree, now.categoryAgreement.total) < ratio(before.categoryAgree, before.categoryTotal)) drops.push("category agreement");
    if (now.missingClauseFindings.length < before.missingClause) drops.push(`missing-clause findings ${before.missingClause} → ${now.missingClauseFindings.length}`);
    if (ratio(now.unmatchedFindingIds.length, now.findings) > ratio(before.unmatched, before.findings)) {
      drops.push(`precision signal: unmatched ${before.unmatched}/${before.findings} → ${now.unmatchedFindingIds.length}/${now.findings}`);
    }
    return [{ now, latencyMs: (u.retry ?? u.op).durationMs, before, drops }];
  });
  return { index, prior, rows };
}

function comparisonBlock(run: Run, c: Computed["understand"]): string[] {
  const cmp = comparisonDrops(run, c);
  if (!cmp || cmp.rows.length === 0) return [];
  const then = `Run ${cmp.index + 1} (\`${cmp.prior.understandPromptVersion}\`)`;
  const now = `Run ${run.meta.history.length + 1} (\`${run.meta.understandPromptVersion}\`)`;
  const out = [
    `## ${then} vs ${now}, on the fixtures both measured`,
    "",
    "| Fixture | Run | Latency | Findings | Verified | Recall (req.) | Optional | Unmatched | Cat. agree | Missing-clause findings | Missed required |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of cmp.rows) {
    const b = row.before;
    const m = row.now;
    out.push(
      `| ${b.fixture} | ${then} | ${formatMs(b.latencyMs)} | ${b.findings} | ${b.verified}/${b.claimedQuotes} | ${b.requiredHit}/${b.requiredTotal} | ${b.optional} | ${b.unmatched} | ${b.categoryAgree}/${b.categoryTotal} | ${b.missingClause} | ${b.missedRequired.join(", ") || "—"} |`,
      `| ${b.fixture} | ${now} | ${formatMs(row.latencyMs)} | ${m.findings} | ${m.verified}/${m.claimedQuotes} | ${m.requiredHit}/${m.requiredTotal} | ${m.optionalAssigned.length} | ${m.unmatchedFindingIds.length} | ${m.categoryAgreement.agree}/${m.categoryAgreement.total} | ${m.missingClauseFindings.length} | ${m.missedRequired.join(", ") || "—"} |`,
    );
  }
  const drops = cmp.rows.filter((row) => row.drops.length > 0);
  out.push(
    "",
    drops.length === 0
      ? "No quality drop on these fixtures: verified rate, recall, category agreement, missing-clause findings and the precision signal are each equal or better."
      : `**Quality drop:** ${drops.map((row) => `${row.before.fixture} (${row.drops.join(", ")})`).join("; ")}.`,
    "",
  );
  return out;
}

// Three separately labelled lines for missing protections: what the model found, what the
// deterministic checklist finds on its own, and the two together as a reader sees them.
function missingProtectionsBlock(run: Run, c: Computed["understand"]): string[] {
  const a = c.aggregate;
  const sources = [...new Set(c.fixtures.filter((f) => f.metrics !== null).map((f) => f.checklist.source))].join("; ") || "—";
  const out = [
    "## Missing protections: the model, the checklist, and both",
    "",
    "Required missing-clause entries of the analysed fixtures that have a standard-clause checklist (the co-working membership has none by design: with no known document type, no clause is expected).",
    "",
    "| Line | What it counts | Required missing clauses found | All required entries |",
    "|---|---|---|---|",
    `| Model | findings the model wrote (\`ai_generated\`) | ${a.modelMissingHit}/${a.missingTotal} | ${a.requiredHit}/${a.requiredTotal} |`,
    `| Checklist | the deterministic checklist's own gaps, before get() drops those a model finding covers; source: ${sources} | ${a.checklistMissingHit}/${a.missingTotal} (every fixture with a checklist, analysed or not: ${a.checklistEveryFixtureHit}/${a.checklistEveryFixtureTotal}) | — |`,
    `| Combined | model findings plus the checklist gaps the reader is shown | ${a.combinedMissingHit}/${a.missingTotal} | ${a.combinedHit}/${a.combinedTotal} (${pct(a.combinedHit, a.combinedTotal)}) |`,
    "",
    `Checklist gaps on every fixture: ${a.checklistGapsEveryFixture}; not confirmed by any key entry (a gap the key lacks, or a false absence claim): ${a.checklistUnconfirmedEveryFixture}.`,
    "",
    "| Fixture | Gap | Topic | Shown to the reader | Confirmed by key entry (keywords) | If unconfirmed: the document may cover it at |",
    "|---|---|---|---|---|---|",
  ];
  let rows = 0;
  for (const u of run.understand) {
    const f = c.fixtures.find((x) => x.fixture === u.fixture)!;
    for (const gap of f.checklist.gaps) {
      rows += 1;
      const shown = f.checklist.source === "not analysed" ? "— (not analysed)" : gap.served ? "yes" : "no — a model finding covers it";
      out.push(
        `| ${u.fixture} | ${gap.gapId} | ${cell(gap.topic, 60)} | ${shown} | ${gap.matches.map((m) => `${m.entryId}${m.required ? "" : " (optional)"} (${m.keywords.join(", ")})`).join("; ") || "**none**"} | ${gap.mayBeCoveredBy.map((h) => `${h.entryId} (${h.sharedWords.join(", ")})`).join("; ") || "—"} |`,
      );
    }
  }
  if (rows === 0) out.push("| — | none | | | | |");
  return [...out, ""];
}

// A threshold over an empty denominator is not a pass, and one over a partial set says so.
function met(denominator: number, ok: boolean, partial: string | null): string {
  if (denominator === 0) return "**not measured**";
  const verdict = ok ? "yes" : "**no**";
  return partial ? `${verdict} — partial, ${partial}` : verdict;
}

function renderUnderstandMd(set: LiveValidationSet, run: Run, computed: Computed, canonical: Map<string, string>): string {
  const c = computed.understand;
  const a = c.aggregate;
  const out: string[] = [...header(run, "Live validation — Understand"), ...concernsBlock(c.concerns, notesFor(run, "understand"))];
  const partial = a.analysedFixtures < set.fixtures.length ? `${a.analysedFixtures}/${set.fixtures.length} fixtures` : null;

  out.push(
    "## Thresholds (aggregate over analysed fixtures)",
    "",
    "| Metric | Threshold | Actual | Met |",
    "|---|---|---|---|",
    `| Verified rate of claimed quotes | ≥90% | ${pct(a.verified, a.claimedQuotes)} (${a.verified}/${a.claimedQuotes}; ${a.approximate} approximate, ${a.notFound} not_found) | ${met(a.claimedQuotes, a.verified / a.claimedQuotes >= VERIFIED_RATE_THRESHOLD, partial)} |`,
    `| Recall of required key entries — model findings only | ≥80% | ${pct(a.requiredHit, a.requiredTotal)} (${a.requiredHit}/${a.requiredTotal}; +${a.optionalAssigned} optional) | ${met(a.requiredTotal, a.requiredHit / a.requiredTotal >= RECALL_THRESHOLD, partial)} |`,
    `| Categories within the five allowed values | 100% | ${pct(a.findings - a.outOfEnum, a.findings)} (${a.outOfEnum} outside of ${a.findings}) — zod rejects any other value at parse, so this is structural; the live signal is the repair-retry/SCHEMA_FAILED column below | ${met(a.findings, a.outOfEnum === 0, partial)} |`,
    `| Precision signal: model findings matching no key entry | reported, not gated | ${pct(a.unmatched, a.findings)} (${a.unmatched}/${a.findings}); ${a.duplicates} duplicates | — |`,
    `| Fixtures analysed | 6 | ${a.analysedFixtures}/${set.fixtures.length} | ${a.analysedFixtures === set.fixtures.length ? "yes" : "**no**"} |`,
    "",
    ...missingProtectionsBlock(run, c),
    "## Per fixture",
    "",
    "| Fixture | Detected type | model_used | Findings | Verified rate | Approx | Not found | Recall (required) | Optional | Unmatched | Dup | Cat. agree | Out-of-enum | Repair retry | Trimmed by service | Transient retry | Calls | Latency |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const u of run.understand) {
    const f = c.fixtures.find((x) => x.fixture === u.fixture)!;
    const m = f.metrics;
    const calls = [...u.op.httpCallSeqs, ...(u.retry?.httpCallSeqs ?? [])].map((seq) => `#${seq}`).join(" ") || "—";
    const trimmed = trimEvents([u.op, u.retry]).map(trimSummary).join("; ") || "none";
    const retried = u.retry ? `yes → ${u.retry.outcome}` : "no";
    const latency = `${formatMs(u.op.durationMs)}${u.retry ? ` + retry ${formatMs(u.retry.durationMs)}` : ""}`;
    if (!m) {
      out.push(`| ${u.fixture} | ${u.document?.documentType ?? "—"} | — | — | — | — | — | — | — | — | — | — | — | — | ${cell(trimmed, 80)} | ${retried} | ${calls} | ${u.op.outcome === "skipped" ? "skipped" : `**${(u.retry ?? u.op).outcome}**`} ${latency} |`);
      continue;
    }
    out.push(
      `| ${u.fixture} | ${u.document?.documentType} (${u.document?.detectionConfidence}) | ${u.analysis?.modelUsed} | ${m.findings} | ${pct(m.verified, m.claimedQuotes)} (${m.verified}/${m.claimedQuotes}) | ${m.approximate} | ${m.notFound} | ${pct(m.requiredHit, m.requiredTotal)} (${m.requiredHit}/${m.requiredTotal}) | ${m.optionalAssigned.length} | ${m.unmatchedFindingIds.length} (${pct(m.unmatchedFindingIds.length, m.findings)}) | ${m.duplicateFindingIds.length} | ${m.categoryAgreement.agree}/${m.categoryAgreement.total} | ${m.outOfEnum} | ${f.repairRetry ? "yes" : "no"} | ${cell(trimmed, 120)} | ${retried} | ${calls} | ${latency} |`,
    );
  }

  out.push("", "Category mix per fixture: " + run.understand.map((u) => {
    const m = c.fixtures.find((x) => x.fixture === u.fixture)!.metrics;
    return m ? `${u.fixture} ${Object.entries(m.categoryCounts).map(([k, v]) => `${k} ${v}`).join(", ")}` : `${u.fixture} —`;
  }).join(" · "), "");

  out.push(...comparisonBlock(run, c));

  out.push("## Missed required entries", "", "| Fixture | Entry | Category | Why it matters (key) | Approximate near-miss |", "|---|---|---|---|---|");
  let missed = 0;
  for (const u of run.understand) {
    const m = c.fixtures.find((x) => x.fixture === u.fixture)!.metrics;
    if (!m) continue;
    const entries = set.fixtures.find((f) => f.id === u.fixture)!.keyFile.entries;
    for (const id of m.missedRequired) {
      missed += 1;
      const entry = entries.find((e) => e.id === id)!;
      const near = m.nearMisses.filter((n) => n.entryId === id).map((n) => shortId(n.findingId)).join(", ");
      out.push(`| ${u.fixture} | ${id} | ${entry.category} | ${cell(entry.description, 150)} | ${near || "—"} |`);
    }
  }
  if (missed === 0) out.push("| — | none | | | |");
  const carried = run.understand.flatMap((u) => c.fixtures.find((x) => x.fixture === u.fixture)!.metrics?.requiredCarried.map((r) => `${u.fixture}: ${r.entryId} via ${r.via}`) ?? []);
  out.push("", `Required entries credited through \`carriedBy\`: ${carried.length === 0 ? "none" : carried.join("; ")}.`, "");

  out.push(
    "## Every missing_clause finding",
    "",
    "Keyword matching is fuzzy; check both the hits and the misses. Explanation is the default (first) lens.",
    "",
    "| Fixture | Finding | Matched entries (keywords) | Assigned to | Explanation |",
    "|---|---|---|---|---|",
  );
  let missingCount = 0;
  for (const u of run.understand) {
    const m = c.fixtures.find((x) => x.fixture === u.fixture)!.metrics;
    if (!m) continue;
    for (const mc of m.missingClauseFindings) {
      missingCount += 1;
      const finding = u.findings!.find((f) => f.id === mc.findingId)!;
      const matches = mc.matches.map((x) => `${x.entryId} (${x.keywords.join(", ")})`).join("; ") || "none";
      out.push(`| ${u.fixture} | ${shortId(mc.findingId)} | ${cell(matches, 120)} | ${mc.assignedTo ?? "—"} | ${cell(finding.lensExplanations[0]?.explanation ?? "", 260)} |`);
    }
  }
  if (missingCount === 0) out.push("| — | none | | | |");

  out.push("", "## Samples worth a human's eyes", "");
  for (const u of run.understand) {
    const m = c.fixtures.find((x) => x.fixture === u.fixture)!.metrics;
    if (!m) continue;
    const text = canonical.get(u.fixture)!;
    for (const finding of samplesFor(u, m)) {
      const assignment = m.assignments.find((x) => x.findingId === finding.id);
      out.push(
        `- **${u.fixture}** · ${finding.category} · **${statusLabel(finding)}** · ${assignment ? `matches ${assignment.entryId}` : m.unmatchedFindingIds.includes(finding.id) ? "matches no key entry" : "duplicate"} — ${shownText(finding, text)}`,
        `  - AI explanation (${finding.lensExplanations[0]?.lens}): ${cell(finding.lensExplanations[0]?.explanation ?? "", 300)}`,
      );
    }
  }

  run.meta.history.forEach((prior, i) => {
    const superseded = prior.understandPromptVersion !== run.meta.understandPromptVersion;
    const failed = prior.calls.filter((call) => call.status !== 200);
    out.push(
      "",
      `## Run ${i + 1}${prior.label ? ` (${prior.label})` : superseded ? " (pre-fix)" : ""} — ${prior.startedAt} · prompt \`${prior.understandPromptVersion}\` · ${prior.callsUsed} provider calls`,
      "",
      ...(prior.note ? [prior.note, ""] : []),
      ...(prior.stops.length > 0 ? [`Stopped: ${prior.stops.join("; ")}.`, ""] : []),
      `Outcomes: ${prior.outcomes.map((o) => `${o.label} ${o.outcome}`).join(" · ")}.`,
      "",
      "| # | Operation | Provider | Model | Result | Latency |",
      "|---|---|---|---|---|---|",
      ...failed.map((call) => `| ${call.seq} | ${call.op} | ${call.provider} | ${call.model ?? "?"} | ${call.outcome === "response" ? `HTTP ${call.status}${call.errorStatus !== undefined || call.errorMessage !== undefined ? ` — ${cell(`${call.errorStatus ?? "?"}: ${call.errorMessage ?? ""}`, 200)}` : ""}` : call.outcome} | ${formatMs(call.latencyMs)} |`),
    );
  });
  if (run.diagnostics.length > 0) {
    out.push("", "## Diagnostics (after the run)", "");
    for (const op of run.diagnostics) {
      const calls = callsOf(run, op);
      out.push(
        `- \`${op.label}\` — one direct \`createGeminiClient().complete()\` with that fixture's Understand prompt and schema (no fallback, no limiter, budget 1): ` +
          `${op.outcome}${op.error ? ` (${op.error})` : ""}; ${calls.map((call) => `call ${call.seq} ${call.provider} ${call.model} ${call.outcome === "response" ? `HTTP ${call.status}` : call.outcome} in ${formatMs(call.latencyMs)}${call.status !== 200 ? providerSaid(call) : ""}`).join("; ") || "no request sent"}`,
      );
    }
  }
  out.push(
    "",
    "## How each document went through the pipeline",
    "",
    "Per fixture: `LocalFsStorageAdapter.createUploadTarget` → `writeRelayed` (the upload relay route's calls, `text/plain`) → " +
      "`understand.analyze()` (`confirmUpload` → pending row → text extraction → type detection → one `llm.complete()` → `verifyMany` → one persisting transaction) → " +
      "a fresh `understand.get()` with an LLM-less deps object (re-verifies every quote against the stored canonical text). " +
      "The LLM client is `createContainer().forRequest(principal)` — the production composition: principal and IP tiers outside, the fallback chain (Gemini → Flash-Lite → Gemma on Google → NIM → OpenRouter) with per-model global tiers inside, default per-minute limits with the daily caps lifted, " +
      "in-memory PGlite with all migrations, a dedicated guest principal. Anchored matches require `status === \"verified\"`; approximate overlaps are listed as near-misses, never credited.",
    "",
  );
  out.push(...callsTable(run, run.httpCalls));
  return out.join("\n");
}

function callsTable(run: Run, calls: HttpCall[]): string[] {
  const out = ["## Provider calls", "", "| # | Operation | Provider | Model | Result | Latency |", "|---|---|---|---|---|---|"];
  for (const call of calls) {
    const result = call.outcome === "response" ? `HTTP ${call.status}${call.status === 429 ? ` (${call.quotaWindow}${call.retryAfter ? `, retry-after ${call.retryAfter}` : ""})` : ""}` : call.outcome;
    out.push(`| ${call.seq} | ${call.op} | ${call.provider} | ${call.model ?? "?"} | ${result} | ${formatMs(call.latencyMs)} (${call.latencyMs} ms) |`);
  }
  if (calls.length === 0) out.push("| — | none | | | | |");
  if (run.meta.blockedCalls.length > 0) {
    out.push("", `Refused locally, never sent: ${run.meta.blockedCalls.map((b) => `${b.op} → ${b.model ?? b.provider} (${b.reason ?? "budget"})`).join("; ")}.`);
  }
  return [...out, ""];
}

function renderPrepareMd(run: Run, computed: Computed): string {
  const c = computed.prepare;
  const out: string[] = [...header(run, "Live validation — Prepare, structural"), ...concernsBlock(c.concerns, notesFor(run, "prepare"))];
  out.push(`Schema: ${c.schemaCheck.pass ? "PASS" : "**FAIL**"} — ${c.schemaCheck.name}: ${c.schemaCheck.detail}.`, "");
  const names = [...new Set(c.fixtures.flatMap((f) => f.checks.map((check) => check.name)))];
  out.push(
    "## Per fixture",
    "",
    "| Fixture | State | model_used | Questions | Checklist | Checklist gaps offered / cited | Checks passed | Failed checks | Calls | Time |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const p of run.prepare) {
    const checks = c.fixtures.find((f) => f.fixture === p.fixture)!.checks;
    const failed = checks.filter((check) => !check.pass);
    const gapIds = new Set((run.understand.find((u) => u.fixture === p.fixture)?.findings ?? []).filter((f) => f.provenance === "checklist").map((f) => f.id));
    const cited = new Set([...p.lawyerQuestions, ...p.checklist].flatMap((item) => item.findingIds).filter((id) => gapIds.has(id)));
    const gapsCell = p.state === "complete" ? `${gapIds.size} / ${cited.size}` : "—";
    const state = p.op.outcome === "skipped" ? `skipped (${cell(p.op.skippedReason ?? "", 80)})` : p.op.outcome === "error" ? `**error** (${p.op.error})` : p.state;
    out.push(
      `| ${p.fixture} | ${state} | ${p.modelUsed ?? "—"} | ${p.lawyerQuestions.length} | ${p.checklist.length} | ${gapsCell} | ${checks.length - failed.length}/${checks.length} | ${failed.map((f) => cell(`${f.name}: ${f.detail}`, 120)).join("; ") || "—"} | ${p.op.httpCallSeqs.map((s) => `#${s}`).join(" ") || "—"} | ${formatMs(p.op.durationMs)} |`,
    );
  }
  out.push("", `Checks run per completed fixture: ${names.join(" · ") || "none"}.`, "", "## One question per fixture", "");
  if (run.prepare.every((p) => p.lawyerQuestions.length === 0)) out.push("None — no Prepare output was generated.");
  for (const p of run.prepare) {
    const q = p.lawyerQuestions[0];
    if (!q) continue;
    const refs = q.findings.map((f) => `${f.category}/${f.status ?? "missing clause"}${f.spanText ? `: "${cell(f.spanText, 120)}"` : ""}`).join("; ");
    out.push(`- **${p.fixture}** — AI-suggested: ${cell(q.question, 240)}`, `  - grounded in: ${refs}`);
  }
  out.push("");
  out.push(...callsTable(run, run.httpCalls.filter((call) => call.op.startsWith("prepare:"))));
  return out.join("\n");
}

function renderSmokeMd(run: Run, computed: Computed, canonical: Map<string, string>): string {
  const s = run.smoke;
  const out: string[] = [...header(run, "Gemma-path smoke"), ...concernsBlock(computed.smoke.concerns)];
  if (!s) return [...out, "The smoke did not run."].join("\n");
  if (s.op.outcome === "skipped") {
    const runs = [...run.meta.history.map((prior) => ({ startedAt: prior.startedAt, calls: prior.calls })), { startedAt: run.meta.startedAt, calls: run.httpCalls }];
    const own = runs.flatMap((prior, i) => {
      const calls = prior.calls.filter((call) => call.provider !== "gemini");
      const via = [...new Set(calls.map((call) => (call.op.startsWith("smoke:") ? `smoke, ${SMOKE_TIMEOUT_MS / 1000} s per gateway` : "product fallback")))].join(" + ");
      const show = (provider: Provider) =>
        calls
          .filter((call) => call.provider === provider)
          .map((call) => `\`${call.model}\`: ${call.outcome === "response" ? `HTTP ${call.status}` : call.outcome} at ${call.latencyMs.toLocaleString("en-US")} ms`)
          .join("; ") || "not called";
      return calls.length === 0 ? [] : [{ source: `validate:live understand run ${i + 1} (${via})`, at: prior.startedAt, nim: show("nim"), openrouter: show("openrouter") }];
    });
    const rows = [...EXTERNAL_GEMMA_ATTEMPTS, ...own].sort((x, y) => x.at.localeCompare(y.at));
    return [
      ...out,
      `**Gemma fallback: UNVERIFIED.** No live call this run — ${s.op.skippedReason}.`,
      "",
      "No Gemma gateway has returned a single completion in any recorded attempt:",
      "",
      "| Attempt | NVIDIA NIM (primary gateway) | OpenRouter (backup) |",
      "|---|---|---|",
      ...rows.map((row) => `| ${row.source} | ${row.nim} | ${row.openrouter} |`),
      "",
      "What this means: when Gemini fails retryably (429, 5xx, timeout), the product's fallback chain (gemini-2.5-flash → gemini-3.5-flash-lite → Gemma on Google → NVIDIA NIM → OpenRouter) reaches NIM and OpenRouter with no gateway known to answer between them, so the request fails with a typed error rather than degrading to Gemma. A per-operation budget bounds the whole chain (llm/timeouts.ts), and a secondary is not started with under 15 s of it left.",
    ].join("\n");
  }
  const m = computed.smoke.metrics;
  const calls = callsOf(run, s.op);
  out.push(
    "| Question | Answer |",
    "|---|---|",
    `| Path | \`createGemmaClient()\` (NIM primary → OpenRouter backup, providers.ts) behind \`withGlobalLimit(gemma)\`, called directly with the Understand prompt + schema for \`${s.fixture}\` (detected \`${s.documentType}\`) |`,
    `| Timeout | ${s.timeoutMs / 1000}s per gateway (call-site \`timeoutMs\`; the product default is 45s) |`,
    `| Gateway that answered | ${s.gateway ?? "**none**"} |`,
    `| model_used | ${s.op.modelUsed ?? "—"} |`,
    `| Parsed against the schema | ${s.parsed ? "yes" : "**no**"}${computed.smoke.repairRetry ? " (after the repair retry)" : ""} |`,
    `| Outcome | ${s.op.outcome}${s.op.error ? ` — ${s.op.error}` : ""} · total ${formatMs(s.op.durationMs)} |`,
    `| Per-call latency | ${calls.map((call) => `#${call.seq} ${call.provider} ${call.outcome === "response" ? `HTTP ${call.status}` : call.outcome} ${formatMs(call.latencyMs)}`).join("; ") || "—"} |`,
    `| Verified rate | ${m ? `${pct(m.verified, m.claimedQuotes)} (${m.verified}/${m.claimedQuotes}; ${m.approximate} approximate, ${m.notFound} not_found)` : "—"} |`,
    `| Recall (informational) | ${m ? `${pct(m.requiredHit, m.requiredTotal)} (${m.requiredHit}/${m.requiredTotal})` : "—"} |`,
    `| Findings | ${m ? `${m.findings} (${Object.entries(m.categoryCounts).map(([k, v]) => `${k} ${v}`).join(", ")})` : "—"} |`,
    "",
  );
  if (s.findings && m) {
    const text = canonical.get(s.fixture)!;
    const shaky = s.findings.filter((f) => f.status === "not_found" || f.status === "approximate").slice(0, 3);
    if (shaky.length > 0) {
      out.push("Quotes that did not verify exactly:", "", ...shaky.map((f) => `- ${f.category} · **${f.status}** — ${shownText(f, text)}`), "");
    }
  }
  out.push(...callsTable(run, calls));
  return out.join("\n");
}

function renderSummary(run: Run, computed: Computed, outDir: string): string {
  const a = computed.understand.aggregate;
  const lines = [
    "",
    `=== validate:live understand — ${run.meta.mode} ===`,
    `provider calls used: ${run.meta.callsUsed}/${run.meta.budget} (refused locally: ${refusedBy(run, "cap")} by a per-model cap, ${refusedBy(run, "budget")} by the budget); wall time ${formatMs(run.meta.wallTimeMs ?? 0)}`,
    ...run.meta.stops.map((stop) => `STOP: ${stop}`),
    a.analysedFixtures === 0
      ? "Understand aggregate: NOT MEASURED (0/6 fixtures analysed)"
      : `Understand aggregate (${a.analysedFixtures}/6 fixtures): verified ${pct(a.verified, a.claimedQuotes)} (${a.verified}/${a.claimedQuotes}) [≥90%] · recall ${pct(a.requiredHit, a.requiredTotal)} (${a.requiredHit}/${a.requiredTotal}) [≥80%] · out-of-enum ${a.outOfEnum}/${a.findings} [0] · unmatched ${pct(a.unmatched, a.findings)} (${a.unmatched}/${a.findings}) · duplicates ${a.duplicates}`,
    ...run.diagnostics.map((op) => `diagnostic ${op.label}: ${op.outcome}${op.error ? ` — ${op.error}` : ""} ${callsOf(run, op).map((call) => `HTTP ${call.status ?? call.outcome}${call.status !== 200 ? providerSaid(call) : ""}`).join("; ")}`),
  ];
  for (const f of computed.understand.fixtures) {
    const u = run.understand.find((x) => x.fixture === f.fixture)!;
    const m = f.metrics;
    lines.push(
      m
        ? `  ${f.fixture.padEnd(28)} ${u.analysis?.modelUsed} · verified ${m.verified}/${m.claimedQuotes} · recall ${m.requiredHit}/${m.requiredTotal} · findings ${m.findings} · unmatched ${m.unmatchedFindingIds.length} · dup ${m.duplicateFindingIds.length} · ${formatMs(u.op.durationMs)}`
        : `  ${f.fixture.padEnd(28)} ${u.op.outcome}${u.op.error ? ` — ${u.op.error}` : ""}${u.op.skippedReason ? ` — ${u.op.skippedReason}` : ""}`,
    );
  }
  for (const p of computed.prepare.fixtures) {
    const raw = run.prepare.find((x) => x.fixture === p.fixture)!;
    const failed = p.checks.filter((check) => !check.pass).length;
    lines.push(`  prepare ${p.fixture.padEnd(28)} ${raw.op.outcome} state=${raw.state ?? "-"} q=${raw.lawyerQuestions.length} c=${raw.checklist.length} checks ${p.checks.length - failed}/${p.checks.length} model=${raw.modelUsed ?? "-"}`);
  }
  const s = run.smoke;
  const sm = computed.smoke.metrics;
  lines.push(
    `Gemma smoke: ${s ? `${s.op.outcome}${s.op.error ? ` — ${s.op.error}` : ""} gateway=${s.gateway ?? "none"} model=${s.op.modelUsed ?? "-"} parsed=${s.parsed} ${formatMs(s.op.durationMs)}${sm ? ` verified ${sm.verified}/${sm.claimedQuotes}` : ""}` : "not run"}`,
    `concerns: understand ${computed.understand.concerns.length}, prepare ${computed.prepare.concerns.length}, smoke ${computed.smoke.concerns.length}`,
    `reports: ${outDir}/{understand,prepare,gemma-smoke}.{md,json}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Dry-run self-check: exact expectations, so the harness is proven before quota is spent
// ---------------------------------------------------------------------------------------------

function dryRunSelfCheck(mode: DryRunMode, set: LiveValidationSet, run: Run, report: Report): string[] {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  expect(run.meta.callsUsed === 0 && run.meta.blockedCalls.length === 0, `no provider request may be attempted in a dry run (used ${run.meta.callsUsed}, refused ${run.meta.blockedCalls.length})`);
  // Every fixture the run covered (all six unless --fixtures narrowed it; a skipped one still counts).
  for (const fixture of set.fixtures.filter((f) => run.understand.some((u) => u.fixture === f.id))) {
    const f = report.computed.understand.fixtures.find((x) => x.fixture === fixture.id);
    const m = f?.metrics;
    if (!m) {
      failures.push(`${fixture.id}: not measured`);
      continue;
    }
    const required = fixture.keyFile.entries.filter((e) => e.required).length;
    const probeDropped = mode === "mutated" ? droppedMissingClauseIds(fixture.id, fixture.keyFile.entries) : [];
    const dropped = (mode === "mutated" ? 2 : 0) + probeDropped.length;
    const extra = mode === "mutated" ? 1 : 0;
    expect(m.requiredHit === required - dropped, `${fixture.id}: model recall ${m.requiredHit}/${m.requiredTotal}, expected ${required - dropped}/${required}`);
    const cl = f!.checklist;
    expect(cl.mismatches === 0, `${fixture.id}: ${cl.mismatches} served checklist findings differ from the recompute`);
    const gapFindings = (run.understand.find((u) => u.fixture === fixture.id)?.findings ?? []).filter((x) => x.provenance === "checklist");
    expect(
      gapFindings.every((g) => g.status === null && g.claimedQuote === null && g.spanStart === null && g.category === "missing_clause" && g.modelUsed === "none"),
      `${fixture.id}: a checklist finding carries a quote, status or model`,
    );
    if (probeDropped.length > 0) {
      expect(probeDropped.every((id) => cl.creditedServed.includes(id)), `${fixture.id}: the checklist should credit ${probeDropped.join(", ")} (credited ${cl.creditedServed.join(", ") || "none"})`);
      expect(f!.combined?.hit === required - 2, `${fixture.id}: combined recall ${f!.combined?.hit}/${required}, expected ${required - 2}`);
    }
    if (gapFindings.length > 0) {
      const cited = [...(run.prepare.find((x) => x.fixture === fixture.id)?.checklist ?? [])].flatMap((item) => item.findingIds);
      expect(gapFindings.some((g) => cited.includes(g.id)), `${fixture.id}: Prepare should cite a checklist gap (the last alias)`);
    }
    expect(m.notFound === extra, `${fixture.id}: not_found ${m.notFound}, expected ${extra}`);
    expect(m.verified === m.claimedQuotes - extra, `${fixture.id}: verified ${m.verified}/${m.claimedQuotes}, expected all but ${extra}`);
    expect(m.unmatchedFindingIds.length === extra, `${fixture.id}: unmatched ${m.unmatchedFindingIds.length}, expected ${extra}`);
    expect(m.duplicateFindingIds.length === extra, `${fixture.id}: duplicates ${m.duplicateFindingIds.length}, expected ${extra}`);
    expect(m.outOfEnum === 0, `${fixture.id}: out-of-enum ${m.outOfEnum}`);
    expect(m.missingClauseFindings.every((mc) => mc.assignedTo !== null), `${fixture.id}: a missing-clause finding was left unassigned`);
    const p = run.prepare.find((x) => x.fixture === fixture.id);
    const checks = report.computed.prepare.fixtures.find((x) => x.fixture === fixture.id)?.checks ?? [];
    expect(p?.state === "complete" && p.lawyerQuestions.length === 1 && p.checklist.length === 1, `${fixture.id}: prepare expected 1 question + 1 item (the F999 question dropped), got ${p?.state} ${p?.lawyerQuestions.length}/${p?.checklist.length}`);
    expect(checks.length > 0 && checks.every((check) => check.pass), `${fixture.id}: prepare checks failed: ${checks.filter((check) => !check.pass).map((check) => check.name).join(", ")}`);
  }
  expect(report.computed.prepare.schemaCheck.pass, "prepare schema check failed");
  const sm = report.computed.smoke.metrics;
  const smokeSkipped = run.smoke?.op.outcome === "skipped" && run.smoke.op.skippedReason === SKIPPED_SMOKE_REASON;
  expect(smokeSkipped || (run.smoke?.parsed === true && sm !== null && sm.notFound === (mode === "mutated" ? 1 : 0)), `smoke: parsed=${run.smoke?.parsed} not_found=${sm?.notFound}`);
  return failures;
}
