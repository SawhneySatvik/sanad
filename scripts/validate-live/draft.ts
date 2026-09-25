// Draft: every generated draft must carry every section its template requires (non-blank, checked by
// the template registry's own helper), and a document-grounded draft must reproduce at least one
// fact from its grounding document. One model call per draft.

import { aiSectionKeys, missingRequiredSections } from "@/server/deterministic/draft-templates";
import type { FakeLlmScript } from "@tests/support/fakes/llm-client";
import { create } from "@/server/services/draft";
import { loadLiveValidationSet, type DraftItem } from "../../tests/fixtures/live-validation/load";
import { cell, formatMs, readJsonOutput, type HttpCall } from "./harness";
import { logOp, timed, type DryRunMode, type OpRecord } from "./understand";
import {
  answeredBy,
  callConcerns,
  callsTableByModel,
  concernsList,
  deepKeys,
  openPart,
  partHeader,
  skippedItem,
  writePart,
  type PartMeta,
  type PartOptions,
} from "./part";

// The two most representative: a tenant's lease from scratch, and an employee's offer letter
// grounded on the fixture offer letter.
const LIVE_ITEMS = ["D-LL-SCRATCH", "D-JO-GROUNDED"];
const FORBIDDEN_KEYS = ["status", "verified", "verification"];

interface DraftRun {
  meta: PartMeta;
  httpCalls: HttpCall[];
  drafts: DraftRecord[];
}

interface DraftRecord {
  item: string;
  documentType: string;
  mode: DraftItem["mode"];
  op: OpRecord;
  answeredBy: string;
  modelUsed: string | null;
  groundingDocumentAvailable: boolean | null;
  sections: { key: string; heading: string; provenance: string; chars: number; excerpt: string }[];
  contentChars: number;
  requiredMissing: string[] | null;
  expectedFacts: string[];
  factsFound: string[];
  forbiddenKeys: string[];
}

// Dry run: every AI section names the item's expected facts (clean) or none of them (mutated).
function fakeDraft(current: { item: DraftItem | null }, mode: DryRunMode): FakeLlmScript {
  return () => {
    const item = current.item!;
    const text = mode === "clean" ? `Dry run section naming ${item.expectedFacts.join(", ")}.` : "Dry run section.";
    return { data: { sections: Object.fromEntries(aiSectionKeys(item.documentType).map((key) => [key, text])) } };
  };
}

export async function renderDraft(outDir: string): Promise<number> {
  const run = await readJsonOutput<DraftRun>(outDir, "draft.json");
  await writeDraft(outDir, run);
  console.log(summaryDraft(run, outDir));
  return 0;
}

export async function runDraft(opts: PartOptions): Promise<number> {
  const set = loadLiveValidationSet();
  const current: { item: DraftItem | null } = { item: null };
  const part = await openPart("draft", set, opts, fakeDraft(current, opts.dryRun ?? "clean"));
  const run: DraftRun = { meta: part.meta, httpCalls: part.meter.calls, drafts: [] };
  const persist = () => part.save(() => writeDraft(opts.outDir, run));
  try {
    for (const id of LIVE_ITEMS) {
      const item = set.draft.items.find((i) => i.id === id)!;
      current.item = item;
      const record = emptyRecord(item, skippedItem(`draft:${id}`, ""));
      const stop = part.stopReason();
      if (stop) {
        record.op = skippedItem(`draft:${id}`, stop);
        run.drafts.push(record);
        continue;
      }
      const grounding = item.groundingFixture ? set.fixtures.find((f) => f.id === item.groundingFixture)! : null;
      const groundingDocumentId = grounding ? (await part.ingest(`${grounding.id}.txt`, grounding.text)).id : undefined;
      await part.pace();
      const { op, value } = await timed(part.meter, `draft:${id}`, () =>
        create(part.venv.deps(), part.venv.principal, {
          mode: item.mode,
          documentType: item.documentType,
          groundingDocumentId,
          userInstructions: item.userInstructions,
          jurisdiction: item.jurisdiction,
        }),
      );
      part.observe(op);
      record.op = op;
      record.answeredBy = answeredBy(run.httpCalls, op);
      if (value) {
        op.modelUsed = value.modelUsed;
        const content = value.content.toLowerCase();
        Object.assign(record, {
          modelUsed: value.modelUsed,
          groundingDocumentAvailable: value.groundingDocumentAvailable,
          sections: value.sections.map((s) => ({ key: s.key, heading: s.heading, provenance: s.provenance, chars: s.content.length, excerpt: s.content.slice(0, 160) })),
          contentChars: value.content.length,
          requiredMissing: missingRequiredSections(value.documentType, value.sections.map((s) => ({ sectionKey: s.key, content: s.content }))),
          factsFound: item.expectedFacts.filter((fact) => content.includes(fact.toLowerCase())),
          forbiddenKeys: [...deepKeys(value)].filter((key) => FORBIDDEN_KEYS.includes(key)),
        });
      }
      run.drafts.push(record);
      logOp(`draft ${id}`, op, value ? `answered by ${record.answeredBy}, ${record.sections.length} sections` : "");
      await persist();
    }
  } finally {
    await part.close();
    await persist();
  }
  console.log(summaryDraft(run, opts.outDir));
  if (!opts.dryRun) return 0;
  const failures = selfCheckDraft(opts.dryRun, run);
  console.log(failures.length === 0 ? `DRY-RUN SELF-CHECK draft (${opts.dryRun}): PASS` : `DRY-RUN SELF-CHECK draft (${opts.dryRun}): FAIL\n- ${failures.join("\n- ")}`);
  return failures.length === 0 ? 0 : 1;
}

function emptyRecord(item: DraftItem, op: OpRecord): DraftRecord {
  return {
    item: item.id,
    documentType: item.documentType,
    mode: item.mode,
    op,
    answeredBy: "none",
    modelUsed: null,
    groundingDocumentAvailable: null,
    sections: [],
    contentChars: 0,
    requiredMissing: null,
    expectedFacts: item.expectedFacts,
    factsFound: [],
    forbiddenKeys: [],
  };
}

function concernsFor(run: DraftRun): string[] {
  const concerns: string[] = [];
  for (const d of run.drafts) {
    if (d.op.outcome === "skipped") concerns.push(`${d.item}: not run — ${d.op.skippedReason}`);
    if (d.op.outcome === "error") concerns.push(`${d.item}: failed — ${d.op.error}`);
    if (d.requiredMissing && d.requiredMissing.length > 0) concerns.push(`${d.item}: missing or blank required sections: ${d.requiredMissing.join(", ")}`);
    if (d.op.outcome === "ok" && d.mode === "document_grounded" && d.factsFound.length === 0) {
      concerns.push(`${d.item}: the grounded draft reproduces none of its document's facts (${d.expectedFacts.join(", ")})`);
    }
    if (d.forbiddenKeys.length > 0) concerns.push(`${d.item}: the draft carries a status-like field: ${d.forbiddenKeys.join(", ")}`);
    concerns.push(...callConcerns(run.meta, run.httpCalls, d.op, d.item));
  }
  return concerns;
}

async function writeDraft(outDir: string, run: DraftRun): Promise<void> {
  const concerns = concernsFor(run);
  await writePart(outDir, "draft", { ...run, computed: { concerns } }, renderDraftMd(run, concerns));
}

function renderDraftMd(run: DraftRun, concerns: string[]): string {
  const done = run.drafts.filter((d) => d.op.outcome === "ok");
  const complete = done.filter((d) => d.requiredMissing?.length === 0).length;
  const grounded = done.filter((d) => d.mode === "document_grounded");
  const groundedOk = grounded.filter((d) => d.factsFound.length > 0).length;
  const models = [...new Set(done.map((d) => d.answeredBy))].join(", ") || "—";
  const out = [...partHeader(run.meta, run.httpCalls, "Live validation — Draft"), ...concernsList(concerns)];
  out.push(
    "## Thresholds",
    "",
    "| Metric | Threshold | Actual | Met | Measured on |",
    "|---|---|---|---|---|",
    `| Drafts with every required section present and non-blank | 100% | ${complete}/${done.length} | ${done.length === 0 ? "**not measured**" : complete === done.length ? `yes — ${done.length} drafts only` : "**no**"} | ${models} |`,
    `| Grounded drafts reproducing ≥1 fact from their document | 100% | ${groundedOk}/${grounded.length} | ${grounded.length === 0 ? "**not measured**" : groundedOk === grounded.length ? `yes — ${grounded.length} draft only` : "**no**"} | ${models} |`,
    "",
    "## Per draft",
    "",
    "| Item | Type | Mode | Answered by | Latency | Sections (AI / templated) | Required missing | Expected facts found | Status-like fields |",
    "|---|---|---|---|---|---|---|---|---|",
    ...run.drafts.map(
      (d) =>
        `| ${d.item} | ${d.documentType} | ${d.mode} | ${d.answeredBy} | ${d.op.outcome === "ok" ? formatMs(d.op.durationMs) : `${d.op.outcome}${d.op.skippedReason ? ` (${cell(d.op.skippedReason, 80)})` : ""}`} | ${d.sections.filter((s) => s.provenance === "ai_generated").length} / ${d.sections.filter((s) => s.provenance === "templated").length} | ${d.requiredMissing === null ? "—" : d.requiredMissing.join(", ") || "none"} | ${d.factsFound.length}/${d.expectedFacts.length}: ${d.factsFound.join(", ") || "none"}${d.mode === "from_scratch" ? " (from the instructions; informational)" : ""} | ${d.forbiddenKeys.join(", ") || "none"} |`,
    ),
    "",
    "## Section openings (AI-written sections are labelled `ai_generated` in the product)",
    "",
  );
  for (const d of done) {
    out.push(`**${d.item}**`, "", ...d.sections.map((s) => `- ${s.heading} (${s.provenance}, ${s.chars} chars): ${cell(s.excerpt, 160)}`), "");
  }
  out.push(
    "## How it ran",
    "",
    "`draft.create()` through the production fallback chain. The grounding document was uploaded, confirmed and extracted server-side through `understand.analyze()`, whose analysis call was deliberately declined (no provider request). " +
      "Required sections are checked with the template registry's own `missingRequiredSections()` (a blank body counts as missing); a grounded draft passes when its text contains at least one expected fact, case-insensitively.",
    "",
    ...callsTableByModel(run.meta, run.httpCalls),
  );
  return out.join("\n");
}

function summaryDraft(run: DraftRun, outDir: string): string {
  return [
    "",
    `=== validate:live draft — ${run.meta.mode} ===`,
    `provider requests sent ${run.meta.callsSent}; refused locally ${run.meta.blocked.length}; wall time ${formatMs(run.meta.wallTimeMs ?? 0)}`,
    ...run.meta.stops.map((stop) => `STOP: ${stop}`),
    ...run.drafts.map(
      (d) =>
        `  ${d.item.padEnd(14)} ${d.op.outcome} answered-by=${d.answeredBy} required-missing=${d.requiredMissing === null ? "-" : d.requiredMissing.length} facts=${d.factsFound.length}/${d.expectedFacts.length} ${d.op.outcome === "ok" ? formatMs(d.op.durationMs) : d.op.skippedReason ?? d.op.error ?? ""}`,
    ),
    `reports: ${outDir}/draft.{md,json}`,
  ].join("\n");
}

function selfCheckDraft(mode: DryRunMode, run: DraftRun): string[] {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  expect(run.meta.callsSent === 0 && run.meta.blocked.length === 0, `no provider request in a dry run (sent ${run.meta.callsSent})`);
  expect(run.drafts.length === LIVE_ITEMS.length && run.drafts.every((d) => d.op.outcome === "ok"), "every draft ran");
  expect(run.drafts.every((d) => d.requiredMissing?.length === 0), "every draft has all required sections");
  expect(run.drafts.every((d) => d.forbiddenKeys.length === 0), "no status-like field");
  const grounded = run.drafts.filter((d) => d.mode === "document_grounded");
  expect(
    mode === "clean" ? grounded.every((d) => d.factsFound.length > 0) : grounded.every((d) => d.factsFound.length === 0),
    `${mode}: grounded facts found ${grounded.map((d) => d.factsFound.length).join(",")}`,
  );
  return failures;
}

