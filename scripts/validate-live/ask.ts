// Ask. Routing over the 30 non-grounded questions is measured locally with the product's own
// deterministic classifier, which makes no model call in production either. The non-legal redirect
// runs through ask() at zero provider cost. A small live sample of grounded and general answers
// measures the model: each question is picked because it routes to one specialist, so one call.

import { AppError } from "@/server/core/errors";
import { detectDocumentType } from "@/server/deterministic/detect-type";
import { extractDocument } from "@/server/deterministic/extract";
import type { FakeLlmScript } from "@tests/support/fakes/llm-client";
import { classify, MAX_SPECIALISTS, type SpecialistId } from "@/server/orchestrator";
import { specialistOutputSchema } from "@/server/orchestrator/schema";
import type { OrchestratorDocumentInput } from "@/server/orchestrator/types";
import { ask, GENERAL_MODE_LABEL, type AskEvent, type AssistantMessage } from "@/server/services/ask";
import { loadLiveValidationSet, type AskQuestion, type LiveValidationSet } from "../../tests/fixtures/live-validation/load";
import { cell, formatMs, pct, readJsonOutput, type HttpCall } from "./harness";
import { anchorSpan } from "./understand-metrics";
import { logOp, timed, type DryRunMode, type OpRecord } from "./understand";
import {
  answeredBy,
  callConcerns,
  callsTableByModel,
  canonicalFixtureText,
  concernsList,
  deepKeys,
  openPart,
  partHeader,
  skippedItem,
  writePart,
  type PartMeta,
  type PartOptions,
} from "./wave";

// One per audience the product serves (tenant, employee, freelancer), each routing to one specialist.
const LIVE_GROUNDED = ["LL-Q2", "JO-Q1", "FS-Q1"];
const LIVE_GENERAL = ["PP-Q5"];
const ROUTING_THRESHOLD = 0.8;
const CITATION_VERIFIED_THRESHOLD = 0.9;
const FORBIDDEN_GENERAL_KEYS = ["citations", "status", "verification", "verified"];

interface RoutingRow {
  id: string;
  fixture: string;
  kind: AskQuestion["kind"];
  top: string;
  expected: string;
  acceptable: string[] | null;
  pass: boolean;
  dispatched: number;
}

interface NonLegalRow {
  id: string;
  ambiguous: boolean;
  localKind: "legal" | "non_legal";
  op: OpRecord;
  redirect: boolean | null;
  modelUsed: string | null;
}

interface LiveCitation {
  claimedQuote: string;
  sourceDocumentId: string | null;
  status: string;
  spanStart: number | null;
  spanEnd: number | null;
  spanText: string | null;
  overlapsExpectedAnchor: boolean;
}

interface LiveAnswer {
  id: string;
  fixture: string;
  kind: "grounded" | "general";
  question: string;
  op: OpRecord;
  answeredBy: string;
  modelUsed: string | null;
  mode: string | null;
  routedDomains: string[];
  redirect: boolean | null;
  label: string | null;
  answerExcerpt: string | null;
  answerChars: number;
  streamedChars: number;
  citations: LiveCitation[];
  forbiddenKeys: string[];
}

interface AskRun {
  meta: PartMeta;
  httpCalls: HttpCall[];
  // Routing is deterministic and costs no call, so a re-render measures it again with the classifier
  // as it is now; the live answers stay those of the run.
  routingMeasuredAt?: string;
  routing: RoutingRow[];
  groundedRouting: RoutingRow[];
  nonLegal: NonLegalRow[];
  live: LiveAnswer[];
}

function allQuestions(set: LiveValidationSet) {
  return set.fixtures.flatMap((fixture) => fixture.askFile.questions.map((question) => ({ fixture, question })));
}

async function documentInputs(set: LiveValidationSet) {
  const byFixture = new Map<string, { id: string; canonicalText: string; canonicalTextHash: string; inputMode: "text"; documentType: string }>();
  for (const fixture of set.fixtures) {
    const extracted = await extractDocument({ pastedText: fixture.text });
    if (extracted.kind !== "extracted") throw new Error(`${fixture.id} did not extract`);
    byFixture.set(fixture.id, {
      id: fixture.id,
      canonicalText: extracted.canonicalText,
      canonicalTextHash: extracted.canonicalTextHash,
      inputMode: "text",
      documentType: detectDocumentType(extracted.canonicalText).documentType,
    });
  }
  return byFixture;
}

function route(question: AskQuestion, fixture: string, documents: readonly OrchestratorDocumentInput[]): RoutingRow {
  const result = classify(question.question, documents);
  const top = result.kind === "legal" ? result.domains[0].id : "non_legal";
  const acceptable = question.acceptableSpecialists ?? null;
  return {
    id: question.id,
    fixture,
    kind: question.kind,
    top,
    expected: question.expectedSpecialist,
    acceptable,
    pass: top === question.expectedSpecialist || (acceptable ?? []).includes(top as SpecialistId),
    dispatched: result.kind === "legal" ? Math.min(result.domains.length, MAX_SPECIALISTS) : 0,
  };
}

async function drainAsk(events: AsyncGenerator<AskEvent>): Promise<{ message: AssistantMessage; streamedChars: number }> {
  let message: AssistantMessage | undefined;
  let streamedChars = 0;
  for await (const event of events) {
    if (event.type === "token") streamedChars += event.text.length;
    else if (event.type === "error") throw new AppError(event.code, `ask() ended with ${event.code}`);
    else message = event.message;
  }
  if (!message) throw new Error("ask() ended without a final message");
  return { message, streamedChars };
}

// Dry run: the specialist cites the question's own expected anchors (clean) or text the document
// does not contain (mutated); in general mode it adds a citation the orchestrator must drop.
function fakeAsk(set: LiveValidationSet, mode: DryRunMode): FakeLlmScript {
  return ({ input }) => {
    if (input.schema !== specialistOutputSchema) throw new Error("dry run: unexpected schema");
    const hit = allQuestions(set).find(({ question }) => input.userPrompt.includes(`User question: ${question.question}`));
    const documentId = /id="([^"]+)"/.exec(input.userPrompt)?.[1];
    const quotes = mode === "clean" ? (hit?.question.expectedAnchors ?? []) : ["Dry run: a sentence the document does not contain."];
    return {
      data: {
        answer: "Dry run answer.",
        citations: documentId
          ? quotes.map((quote) => ({ quote, sourceDocumentId: documentId }))
          : [{ quote: "a general-mode citation the orchestrator must drop", sourceDocumentId: "none" }],
      },
    };
  };
}

export async function renderAsk(outDir: string): Promise<number> {
  const run = await readJsonOutput<AskRun>(outDir, "ask.json");
  Object.assign(run, await localRouting(loadLiveValidationSet()));
  await writeAsk(outDir, run);
  console.log(summaryAsk(run, computeAsk(run), outDir));
  return 0;
}

async function localRouting(set: LiveValidationSet) {
  const docs = await documentInputs(set);
  const questions = allQuestions(set);
  return {
    routingMeasuredAt: new Date().toISOString(),
    routing: questions.filter(({ question }) => question.kind !== "grounded").map(({ fixture, question }) => route(question, fixture.id, [])),
    groundedRouting: questions
      .filter(({ question }) => question.kind === "grounded")
      .map(({ fixture, question }) => route(question, fixture.id, [docs.get(fixture.id)!])),
  };
}

export async function runAsk(opts: PartOptions): Promise<number> {
  const set = loadLiveValidationSet();
  const docs = await documentInputs(set);
  const questions = allQuestions(set);
  const part = await openPart("ask", set, opts, fakeAsk(set, opts.dryRun ?? "clean"));
  const run: AskRun = { meta: part.meta, httpCalls: part.meter.calls, ...(await localRouting(set)), nonLegal: [], live: [] };
  const persist = () => part.save(() => writeAsk(opts.outDir, run));
  try {
    // The non-legal redirect makes no model call; a question the classifier calls legal would, so it
    // is reported from the local classification only.
    for (const question of set.nonLegal.questions) {
      const localKind = classify(question.question, []).kind;
      if (localKind !== "non_legal") {
        run.nonLegal.push({ id: question.id, ambiguous: question.ambiguous, localKind, op: skippedItem(`ask:${question.id}`, "a live run would spend a model call"), redirect: null, modelUsed: null });
        continue;
      }
      const { op, value } = await timed(part.meter, `ask:${question.id}`, () => drainAsk(ask(part.venv.deps(), part.venv.principal, { query: question.question })));
      const message = value?.message;
      run.nonLegal.push({
        id: question.id,
        ambiguous: question.ambiguous,
        localKind,
        op,
        redirect: message?.mode === "general" ? message.redirect : null,
        modelUsed: message?.modelUsed ?? null,
      });
    }
    await persist();

    const ingested = new Map<string, string>();
    for (const id of LIVE_GROUNDED) {
      const { fixture } = questions.find(({ question }) => question.id === id)!;
      if (!ingested.has(fixture.id)) ingested.set(fixture.id, (await part.ingest(`${fixture.id}.txt`, fixture.text)).id);
    }

    for (const id of [...LIVE_GROUNDED, ...LIVE_GENERAL]) {
      const { fixture, question } = questions.find(({ question: q }) => q.id === id)!;
      const kind = question.kind === "grounded" ? "grounded" : "general";
      const attached = kind === "grounded" ? [docs.get(fixture.id)!] : [];
      const dispatched = route(question, fixture.id, attached).dispatched;
      const stop = part.stopReason() ?? (dispatched !== 1 ? `routes to ${dispatched} specialists, which would cost more than one call` : null);
      if (stop) {
        run.live.push(emptyAnswer(id, fixture.id, kind, question.question, skippedItem(`ask:${id}`, stop)));
        continue;
      }
      await part.pace();
      const documentIds = kind === "grounded" ? [ingested.get(fixture.id)!] : [];
      const { op, value } = await timed(part.meter, `ask:${id}`, () =>
        drainAsk(ask(part.venv.deps(), part.venv.principal, { query: question.question, documentIds })),
      );
      part.observe(op);
      const answer = emptyAnswer(id, fixture.id, kind, question.question, op);
      answer.answeredBy = answeredBy(run.httpCalls, op);
      if (value) {
        const message = value.message;
        op.modelUsed = message.modelUsed;
        const canonical = canonicalFixtureText(fixture.text);
        Object.assign(answer, {
          modelUsed: message.modelUsed,
          mode: message.mode,
          routedDomains: [...message.routedDomains],
          redirect: message.mode === "general" ? message.redirect : null,
          label: message.mode === "general" ? message.label : null,
          answerExcerpt: message.content.slice(0, 400),
          answerChars: message.content.length,
          streamedChars: value.streamedChars,
          citations: message.mode === "grounded" ? message.citations.map((c) => toLiveCitation(c, canonical, question.expectedAnchors ?? [])) : [],
          forbiddenKeys: message.mode === "general" ? [...deepKeys(message)].filter((key) => FORBIDDEN_GENERAL_KEYS.includes(key)) : [],
        });
      }
      run.live.push(answer);
      logOp(`ask ${id}`, op, value ? `answered by ${answer.answeredBy}, ${answer.citations.length} citations` : "");
      await persist();
    }
  } finally {
    await part.close();
    await persist();
  }
  const computed = computeAsk(run);
  await writeAsk(opts.outDir, run);
  console.log(summaryAsk(run, computed, opts.outDir));
  if (!opts.dryRun) return 0;
  const failures = selfCheckAsk(opts.dryRun, run, computed);
  console.log(failures.length === 0 ? `DRY-RUN SELF-CHECK ask (${opts.dryRun}): PASS` : `DRY-RUN SELF-CHECK ask (${opts.dryRun}): FAIL\n- ${failures.join("\n- ")}`);
  return failures.length === 0 ? 0 : 1;
}

function emptyAnswer(id: string, fixture: string, kind: "grounded" | "general", question: string, op: OpRecord): LiveAnswer {
  return {
    id,
    fixture,
    kind,
    question,
    op,
    answeredBy: "none",
    modelUsed: null,
    mode: null,
    routedDomains: [],
    redirect: null,
    label: null,
    answerExcerpt: null,
    answerChars: 0,
    streamedChars: 0,
    citations: [],
    forbiddenKeys: [],
  };
}

function toLiveCitation(
  citation: { quote: string; sourceDocumentId: string | null; verification: { status: string; spanStart: number | null; spanEnd: number | null } },
  canonical: string,
  anchors: readonly string[],
): LiveCitation {
  const v = citation.verification;
  const spanned = v.status !== "not_found" && v.spanStart !== null && v.spanEnd !== null;
  const overlaps =
    v.status === "verified" &&
    anchors.some((anchor) => {
      const span = anchorSpan(canonical, anchor);
      return Math.min(span.end, v.spanEnd!) - Math.max(span.start, v.spanStart!) > 0;
    });
  return {
    claimedQuote: citation.quote.slice(0, 400),
    sourceDocumentId: citation.sourceDocumentId,
    status: v.status,
    spanStart: v.spanStart,
    spanEnd: v.spanEnd,
    spanText: spanned ? canonical.slice(v.spanStart!, v.spanEnd!).slice(0, 400) : null,
    overlapsExpectedAnchor: overlaps,
  };
}

function computeAsk(run: AskRun) {
  const routingPass = run.routing.filter((r) => r.pass).length;
  const grounded = run.live.filter((a) => a.kind === "grounded" && a.op.outcome === "ok");
  const citations = grounded.flatMap((a) => a.citations);
  const verified = citations.filter((c) => c.status === "verified").length;
  const general = run.live.filter((a) => a.kind === "general" && a.op.outcome === "ok");
  const generalOk = general.filter((a) => a.mode === "general" && a.forbiddenKeys.length === 0 && a.label === GENERAL_MODE_LABEL && a.redirect === false);
  const nonLegalScored = run.nonLegal.filter((n) => !n.ambiguous);
  const redirected = nonLegalScored.filter((n) => n.redirect === true && n.modelUsed === "none" && n.op.httpCallSeqs.length === 0);
  const concerns: string[] = [];
  if (routingPass / run.routing.length < ROUTING_THRESHOLD) concerns.push(`routing: ${routingPass}/${run.routing.length} below the 80% bar`);
  else if (routingPass / run.routing.length === ROUTING_THRESHOLD) {
    concerns.push(`routing: ${routingPass}/${run.routing.length} meets the 80% bar exactly, with no slack (misses: ${run.routing.filter((r) => !r.pass).map((r) => r.id).join(", ")})`);
  }
  if (citations.length > 0 && verified / citations.length < CITATION_VERIFIED_THRESHOLD) {
    concerns.push(`grounded citations: verified ${verified}/${citations.length} (${pct(verified, citations.length)}) below the 90% bar`);
  }
  for (const a of grounded) if (a.citations.length === 0) concerns.push(`${a.id}: a grounded answer with no citations at all`);
  for (const a of grounded) if (!a.citations.some((c) => c.overlapsExpectedAnchor)) concerns.push(`${a.id}: no verified citation overlaps the passage a human marked as the answer`);
  for (const a of general) if (!generalOk.includes(a)) concerns.push(`${a.id}: the general answer is not structurally badge-free (${a.forbiddenKeys.join(", ") || `mode ${a.mode}, label ${a.label}`})`);
  for (const a of run.live) {
    if (a.op.outcome === "skipped") concerns.push(`${a.id}: not run — ${a.op.skippedReason}`);
    if (a.op.outcome === "error") concerns.push(`${a.id}: failed — ${a.op.error}`);
    concerns.push(...callConcerns(run.meta, run.httpCalls, a.op, a.id));
  }
  if (redirected.length !== nonLegalScored.length) concerns.push(`non-legal: ${redirected.length}/${nonLegalScored.length} redirected with no model call`);
  const liveRun = run.live.filter((a) => a.op.outcome !== "skipped").length;
  if (liveRun < LIVE_GROUNDED.length + LIVE_GENERAL.length) concerns.push(`only ${liveRun}/${LIVE_GROUNDED.length + LIVE_GENERAL.length} live questions ran`);
  return { routingPass, grounded, citations, verified, general, generalOk, nonLegalScored, redirected, concerns };
}

function writeAsk(outDir: string, run: AskRun): Promise<void> {
  const c = computeAsk(run);
  return writePart(outDir, "ask", { ...run, computed: { routingPass: c.routingPass, verified: c.verified, citations: c.citations.length, concerns: c.concerns } }, renderAskMd(run, c));
}

function renderAskMd(run: AskRun, c: ReturnType<typeof computeAsk>): string {
  const out = [...partHeader(run.meta, run.httpCalls, "Live validation — Ask"), ...concernsList(c.concerns)];
  const groundedRoutingPass = run.groundedRouting.filter((r) => r.pass).length;
  out.push(
    "## Thresholds",
    "",
    "| Metric | Threshold | Actual | Met | Measured on |",
    "|---|---|---|---|---|",
    `| Routing: classifier's top choice, 30 non-grounded questions | ≥80% | ${pct(c.routingPass, run.routing.length)} (${c.routingPass}/${run.routing.length}) | ${c.routingPass / run.routing.length >= ROUTING_THRESHOLD ? "yes (no slack)" : "**no**"} | the deterministic classifier, locally (no model involved), as of ${run.routingMeasuredAt ?? run.meta.startedAt}; the live answers below are from the run of ${run.meta.startedAt} |`,
    `| Grounded answers: citation verified rate | ≥90% | ${c.citations.length === 0 ? "n/a" : `${pct(c.verified, c.citations.length)} (${c.verified}/${c.citations.length})`} | ${c.citations.length === 0 ? "**not measured**" : c.verified / c.citations.length >= CITATION_VERIFIED_THRESHOLD ? `yes — ${c.grounded.length} answers only` : "**no**"} | ${[...new Set(c.grounded.map((a) => a.answeredBy))].join(", ") || "—"} |`,
    `| General answers: no citation, status or badge anywhere | 100% | ${c.generalOk.length}/${c.general.length} | ${c.general.length === 0 ? "**not measured**" : c.generalOk.length === c.general.length ? `yes — ${c.general.length} answer only` : "**no**"} | ${[...new Set(c.general.map((a) => a.answeredBy))].join(", ") || "—"} |`,
    `| Non-legal questions redirected, no model call | all non-ambiguous | ${c.redirected.length}/${c.nonLegalScored.length} | ${c.redirected.length === c.nonLegalScored.length ? "yes" : "**no**"} | ask() end to end, 0 provider requests |`,
    "",
    `Grounded questions' routing (reported, not gated; the attached document decides it): ${groundedRoutingPass}/${run.groundedRouting.length}.`,
    "",
    "## Routing misses (locally, deterministic classifier)",
    "",
    "| Question | Kind | Classifier's top choice | Expected | Acceptable |",
    "|---|---|---|---|---|",
    ...run.routing.filter((r) => !r.pass).map((r) => `| ${r.id} | ${r.kind} | ${r.top} | ${r.expected} | ${r.acceptable?.join(", ") ?? "—"} |`),
    "",
    "## Live answers",
    "",
    "| Question | Kind | Answered by | Routed to | Latency | Citations: verified / approx / not found | Overlaps the marked passage | Answer (excerpt) |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const a of run.live) {
    const count = (s: string) => a.citations.filter((x) => x.status === s).length;
    out.push(
      `| ${a.id} | ${a.kind} | ${a.answeredBy} | ${a.routedDomains.join(", ") || "—"} | ${a.op.outcome === "ok" ? formatMs(a.op.durationMs) : a.op.outcome} | ${a.kind === "grounded" ? `${count("verified")} / ${count("approximate")} / ${count("not_found")}` : "— (general)"} | ${a.kind === "grounded" ? (a.citations.some((x) => x.overlapsExpectedAnchor) ? "yes" : "**no**") : "—"} | ${cell(a.answerExcerpt ?? a.op.skippedReason ?? a.op.error ?? "", 220)} |`,
    );
  }
  out.push("", "Questions:", ...run.live.map((a) => `- ${a.id}: ${a.question}`), "", "## Citations (as a reader sees them)", "");
  for (const a of run.live) {
    for (const citation of a.citations) {
      out.push(
        `- ${a.id} · **${citation.status}**${citation.overlapsExpectedAnchor ? " · overlaps the marked passage" : ""} — ${citation.spanText !== null ? `span: "${cell(citation.spanText, 220)}"` : `claimed (not in document): "${cell(citation.claimedQuote, 220)}"`}`,
      );
    }
  }
  const general = run.live.filter((a) => a.kind === "general");
  if (general.length > 0) {
    out.push("", "## General-mode structure", "", ...general.map((a) => `- ${a.id}: mode \`${a.mode}\`, label "${a.label}", redirect ${a.redirect}, forbidden keys found: ${a.forbiddenKeys.join(", ") || "none"}`));
  }
  out.push(
    "",
    "## Non-legal questions (ask() end to end)",
    "",
    ...run.nonLegal.map((n) => `- ${n.id}${n.ambiguous ? " (ambiguous, not scored)" : ""}: ${n.op.outcome === "skipped" ? `classified ${n.localKind} locally; ${n.op.skippedReason}` : `redirect ${n.redirect}, model_used \`${n.modelUsed}\`, provider requests ${n.op.httpCallSeqs.length}`}`),
    "",
    "## How it ran",
    "",
    "Grounded documents were uploaded, confirmed and extracted server-side through `understand.analyze()`; its analysis call was deliberately declined (no provider request), so each document is `ready` with extracted text only, which is all Ask reads. " +
      "Each live question went through `ask()` → the orchestrator → the production fallback chain from `createContainer().forRequest()`. Citations were re-verified by the service against the document's canonical text.",
    "",
    ...callsTableByModel(run.meta, run.httpCalls),
  );
  return out.join("\n");
}

function summaryAsk(run: AskRun, c: ReturnType<typeof computeAsk>, outDir: string): string {
  return [
    "",
    `=== validate:live ask — ${run.meta.mode} ===`,
    `provider requests sent ${run.meta.callsSent}; refused locally ${run.meta.blocked.length}; wall time ${formatMs(run.meta.wallTimeMs ?? 0)}`,
    ...run.meta.stops.map((stop) => `STOP: ${stop}`),
    `routing (local classifier) ${c.routingPass}/${run.routing.length} [≥80%] · non-legal redirect ${c.redirected.length}/${c.nonLegalScored.length}`,
    `grounded citations verified ${c.verified}/${c.citations.length} [≥90%] over ${c.grounded.length} answers · general badge-free ${c.generalOk.length}/${c.general.length}`,
    ...run.live.map((a) => `  ${a.id.padEnd(6)} ${a.op.outcome} answered-by=${a.answeredBy} citations=${a.citations.length} ${a.op.outcome === "ok" ? formatMs(a.op.durationMs) : a.op.skippedReason ?? a.op.error ?? ""}`),
    `concerns ${c.concerns.length} · reports: ${outDir}/ask.{md,json}`,
  ].join("\n");
}

function selfCheckAsk(mode: DryRunMode, run: AskRun, c: ReturnType<typeof computeAsk>): string[] {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  expect(run.meta.callsSent === 0 && run.meta.blocked.length === 0, `no provider request in a dry run (sent ${run.meta.callsSent}, refused ${run.meta.blocked.length})`);
  expect(run.live.every((a) => a.op.outcome === "ok"), `every live item ran (${run.live.map((a) => `${a.id}:${a.op.outcome}`).join(" ")})`);
  expect(c.redirected.length === c.nonLegalScored.length && c.nonLegalScored.length > 0, `non-legal redirected ${c.redirected.length}/${c.nonLegalScored.length}`);
  expect(c.generalOk.length === c.general.length && c.general.length === LIVE_GENERAL.length, `general answers badge-free ${c.generalOk.length}/${c.general.length}`);
  if (mode === "clean") {
    expect(c.citations.length > 0 && c.verified === c.citations.length, `clean: every citation verified (${c.verified}/${c.citations.length})`);
    expect(c.grounded.every((a) => a.citations.some((x) => x.overlapsExpectedAnchor)), "clean: every grounded answer overlaps its marked passage");
  } else {
    expect(c.citations.length > 0 && c.verified === 0, `mutated: no citation verified (${c.verified}/${c.citations.length})`);
    expect(c.grounded.every((a) => !a.citations.some((x) => x.overlapsExpectedAnchor)), "mutated: no anchor overlap");
  }
  return failures;
}
