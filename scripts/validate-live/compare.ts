// Compare, on the three curated before/after pairs: each injected change must be detected (a
// persisted change of the same type whose verified span overlaps the manifest line on every side
// that exists, the absent side carrying no quote) and explained (the model's own explanation of
// that change names the new value). One model call per pair.

import type { FakeLlmScript } from "@tests/support/fakes/llm-client";
import { compare, type ComparisonChangeResult } from "@/server/services/compare";
import { loadLiveValidationSet, matchedPhrases, type CompareChange, type LiveValidationSet } from "../../tests/fixtures/live-validation/load";
import { cell, formatMs, readJsonOutput, type HttpCall } from "./harness";
import { logOp, timed, type DryRunMode, type OpRecord } from "./understand";
import {
  answeredBy,
  callConcerns,
  callsTableByModel,
  concernsList,
  openPart,
  partHeader,
  skippedItem,
  writePart,
  type PartMeta,
  type PartOptions,
} from "./part";

// services/compare.ts's text for a candidate the model did not explain (module-private there). An
// explanation equal to it is the server's, not the model's, so it never counts as explained.
const SERVER_DEFAULT_EXPLANATION = {
  added: "This clause appears only in the second document.",
  removed: "This clause appears only in the first document.",
  changed: "The wording of this clause differs between the two documents.",
} as const;

interface Side {
  status: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  spanText: string | null;
}

interface RawChange {
  id: string;
  changeType: "added" | "removed" | "changed";
  explanation: string;
  a: Side;
  b: Side;
}

interface PairRun {
  pair: string;
  op: OpRecord;
  answeredBy: string;
  modelUsed: string | null;
  modelQuotes: { kept: number; replaced: number } | null;
  changes: RawChange[];
}

interface ChangeVerdict {
  pair: string;
  id: string;
  type: CompareChange["type"];
  description: string;
  matchedChangeId: string | null;
  detected: boolean;
  modelWritten: boolean;
  mentions: string[];
  explained: boolean;
  explanation: string | null;
}

interface CompareRun {
  meta: PartMeta;
  httpCalls: HttpCall[];
  pairs: PairRun[];
}

function toSide(verification: ComparisonChangeResult["verificationA"], canonical: string): Side {
  if (verification === null) return { status: null, spanStart: null, spanEnd: null, spanText: null };
  const spanned = verification.status !== "not_found";
  return {
    status: verification.status,
    spanStart: verification.spanStart,
    spanEnd: verification.spanEnd,
    spanText: spanned ? canonical.slice(verification.spanStart!, verification.spanEnd!).slice(0, 300) : null,
  };
}

// The manifest side exists → a verified span overlapping its line; absent → no quote at all.
function sideMatches(manifest: CompareChange["before"], side: Side): boolean {
  if (manifest === null) return side.status === null;
  return side.status === "verified" && Math.min(side.spanEnd!, manifest.end) - Math.max(side.spanStart!, manifest.start) > 0;
}

function judge(pair: LiveValidationSet["comparePairs"][number], run: PairRun | undefined): ChangeVerdict[] {
  return pair.changes.map((change) => {
    const hit = run?.changes.find((c) => c.changeType === change.type && sideMatches(change.before, c.a) && sideMatches(change.after, c.b));
    const modelWritten = hit !== undefined && hit.explanation !== SERVER_DEFAULT_EXPLANATION[hit.changeType];
    const mentions = hit && modelWritten ? matchedPhrases(hit.explanation, change.expectedMentions) : [];
    return {
      pair: pair.id,
      id: change.id,
      type: change.type,
      description: change.description,
      matchedChangeId: hit?.id ?? null,
      detected: hit !== undefined,
      modelWritten,
      mentions,
      explained: mentions.length > 0,
      explanation: hit?.explanation ?? null,
    };
  });
}

// Dry run: explain each candidate with its changed side's own text (clean), which the manifest
// guarantees contains an expected mention, or with text that mentions nothing (mutated).
function fakeCompare(mode: DryRunMode): FakeLlmScript {
  return ({ input }) => {
    const texts = new Map<string, { a?: string; b?: string }>();
    let current: { id: string; side: "a" | "b" | null } | null = null;
    for (const line of input.userPrompt.split("\n")) {
      const marker = /^<<<CHANGES-[0-9a-f]{16} (c\d+) (A|B|added|removed|changed)>>>$/.exec(line);
      if (marker) {
        current = { id: marker[1], side: marker[2] === "A" ? "a" : marker[2] === "B" ? "b" : null };
        if (!texts.has(marker[1])) texts.set(marker[1], {});
        continue;
      }
      if (/^<<<CHANGES-[0-9a-f]{16} (BEGIN|END)>>>$/.test(line)) {
        current = null;
        continue;
      }
      if (current?.side) {
        const entry = texts.get(current.id)!;
        entry[current.side] = entry[current.side] === undefined ? line : `${entry[current.side]}\n${line}`;
      }
    }
    return {
      data: {
        changes: [...texts].map(([id, t]) => ({ id, explanation: mode === "clean" ? (t.b ?? t.a ?? "") : "Dry run.", quoteA: null, quoteB: null })),
      },
    };
  };
}

export async function renderCompare(outDir: string): Promise<number> {
  const set = loadLiveValidationSet();
  const run = await readJsonOutput<CompareRun>(outDir, "compare.json");
  await writeCompare(outDir, set, run);
  console.log(summaryCompare(run, set.comparePairs.flatMap((pair) => judge(pair, run.pairs.find((p) => p.pair === pair.id))), outDir));
  return 0;
}

export async function runCompare(opts: PartOptions): Promise<number> {
  const set = loadLiveValidationSet();
  const part = await openPart("compare", set, opts, fakeCompare(opts.dryRun ?? "clean"));
  const run: CompareRun = { meta: part.meta, httpCalls: part.meter.calls, pairs: [] };
  const persist = () => part.save(() => writeCompare(opts.outDir, set, run));
  try {
    for (const pair of set.comparePairs) {
      const stop = part.stopReason();
      if (stop) {
        run.pairs.push({ pair: pair.id, op: skippedItem(`compare:${pair.id}`, stop), answeredBy: "none", modelUsed: null, modelQuotes: null, changes: [] });
        continue;
      }
      const before = await part.ingest(`${pair.id}.before.txt`, pair.beforeText);
      const after = await part.ingest(`${pair.id}.after.txt`, pair.afterText);
      await part.pace();
      const { op, value } = await timed(part.meter, `compare:${pair.id}`, () =>
        compare(part.venv.deps(), part.venv.principal, { documentAId: before.id, documentBId: after.id }),
      );
      part.observe(op);
      if (value) op.modelUsed = value.comparison.modelUsed;
      run.pairs.push({
        pair: pair.id,
        op,
        answeredBy: answeredBy(run.httpCalls, op),
        modelUsed: value?.comparison.modelUsed ?? null,
        modelQuotes: value?.modelQuotes ?? null,
        changes: (value?.changes ?? []).map((change) => ({
          id: change.id,
          changeType: change.changeType,
          explanation: change.explanation,
          a: toSide(change.verificationA, value!.documentA.canonicalText ?? ""),
          b: toSide(change.verificationB, value!.documentB.canonicalText ?? ""),
        })),
      });
      logOp(`compare ${pair.id}`, op, value ? `answered by ${answeredBy(run.httpCalls, op)}, ${value.changes.length} changes` : "");
      await persist();
    }
  } finally {
    await part.close();
    await persist();
  }
  const verdicts = set.comparePairs.flatMap((pair) => judge(pair, run.pairs.find((p) => p.pair === pair.id)));
  console.log(summaryCompare(run, verdicts, opts.outDir));
  if (!opts.dryRun) return 0;
  const failures = selfCheckCompare(opts.dryRun, run, verdicts);
  console.log(failures.length === 0 ? `DRY-RUN SELF-CHECK compare (${opts.dryRun}): PASS` : `DRY-RUN SELF-CHECK compare (${opts.dryRun}): FAIL\n- ${failures.join("\n- ")}`);
  return failures.length === 0 ? 0 : 1;
}

function concernsFor(set: LiveValidationSet, run: CompareRun, verdicts: ChangeVerdict[]): string[] {
  const concerns: string[] = [];
  const passed = verdicts.filter((v) => v.detected && v.explained).length;
  if (passed < verdicts.length) concerns.push(`${passed}/${verdicts.length} injected changes detected and explained — the bar is 100%`);
  for (const v of verdicts) {
    if (!v.detected) concerns.push(`${v.pair}/${v.id} (${v.type}): not detected — no persisted change of that type with a verified span on the manifest line`);
    else if (!v.modelWritten) concerns.push(`${v.pair}/${v.id}: detected, but the explanation is the server's default text (the model did not explain it)`);
    else if (!v.explained) concerns.push(`${v.pair}/${v.id}: detected, but the model's explanation names none of: ${set.comparePairs.find((p) => p.id === v.pair)!.changes.find((c) => c.id === v.id)!.expectedMentions.join(", ")}`);
  }
  for (const p of run.pairs) {
    if (p.op.outcome === "skipped") concerns.push(`${p.pair}: not run — ${p.op.skippedReason}`);
    if (p.op.outcome === "error") concerns.push(`${p.pair}: failed — ${p.op.error}`);
    const matched = new Set(verdicts.filter((v) => v.pair === p.pair).map((v) => v.matchedChangeId));
    const extra = p.changes.filter((c) => !matched.has(c.id));
    if (p.op.outcome === "ok" && extra.length > 0) concerns.push(`${p.pair}: ${extra.length} persisted change(s) match no injected change`);
    concerns.push(...callConcerns(run.meta, run.httpCalls, p.op, p.pair));
  }
  return concerns;
}

async function writeCompare(outDir: string, set: LiveValidationSet, run: CompareRun): Promise<void> {
  const verdicts = set.comparePairs.flatMap((pair) => judge(pair, run.pairs.find((p) => p.pair === pair.id)));
  const concerns = concernsFor(set, run, verdicts);
  await writePart(outDir, "compare", { ...run, computed: { verdicts, concerns } }, renderCompareMd(run, verdicts, concerns));
}

function renderCompareMd(run: CompareRun, verdicts: ChangeVerdict[], concerns: string[]): string {
  const passed = verdicts.filter((v) => v.detected && v.explained).length;
  const detected = verdicts.filter((v) => v.detected).length;
  const explained = verdicts.filter((v) => v.explained).length;
  const ran = run.pairs.filter((p) => p.op.outcome === "ok").length;
  const out = [...partHeader(run.meta, run.httpCalls, "Live validation — Compare"), ...concernsList(concerns)];
  out.push(
    "## Thresholds",
    "",
    "| Metric | Threshold | Actual | Met | Measured on |",
    "|---|---|---|---|---|",
    `| Injected changes detected AND explained | 100% | ${passed}/${verdicts.length} | ${ran === 0 ? "**not measured**" : passed === verdicts.length ? "yes" : "**no**"} | ${[...new Set(run.pairs.map((p) => p.answeredBy).filter((m) => m !== "none"))].join(", ") || "—"} |`,
    `| — detected (deterministic diff + verify()) | — | ${detected}/${verdicts.length} | | the service's own alignment, no model |`,
    `| — explained (the model names the new value) | — | ${explained}/${verdicts.length} | | the model |`,
    "",
    "## Per change",
    "",
    "| Pair | Change | Type | Detected | Explained (mentions found) | Explanation (model text) |",
    "|---|---|---|---|---|---|",
    ...verdicts.map(
      (v) =>
        `| ${v.pair} | ${v.id} | ${v.type} | ${v.detected ? "yes" : "**no**"} | ${v.explained ? `yes (${v.mentions.join(", ")})` : v.detected && !v.modelWritten ? "**no** (server default text)" : "**no**"} | ${cell(v.explanation ?? "—", 260)} |`,
    ),
    "",
    "## Per pair",
    "",
    "| Pair | Answered by | Latency | Persisted changes | Model quotes kept / replaced by the clause |",
    "|---|---|---|---|---|",
    ...run.pairs.map(
      (p) =>
        `| ${p.pair} | ${p.answeredBy} | ${p.op.outcome === "ok" ? formatMs(p.op.durationMs) : `${p.op.outcome}${p.op.skippedReason ? ` (${cell(p.op.skippedReason, 80)})` : ""}`} | ${p.changes.length} | ${p.modelQuotes ? `${p.modelQuotes.kept} / ${p.modelQuotes.replaced}` : "—"} |`,
    ),
    "",
    "## How it ran",
    "",
    "Both versions of each pair were uploaded, confirmed and extracted server-side through `understand.analyze()`, with its analysis call deliberately declined (no provider request). `compare()` then ran on the pair through the production fallback chain: " +
      "the deterministic clause alignment finds the candidates, one model call explains them, and every quote shown is re-verified against its own document. Detection is judged on the persisted change's verified span; the explanation is judged only when it is the model's own text.",
    "",
    ...callsTableByModel(run.meta, run.httpCalls),
  );
  return out.join("\n");
}

function summaryCompare(run: CompareRun, verdicts: ChangeVerdict[], outDir: string): string {
  const passed = verdicts.filter((v) => v.detected && v.explained).length;
  return [
    "",
    `=== validate:live compare — ${run.meta.mode} ===`,
    `provider requests sent ${run.meta.callsSent}; refused locally ${run.meta.blocked.length}; wall time ${formatMs(run.meta.wallTimeMs ?? 0)}`,
    ...run.meta.stops.map((stop) => `STOP: ${stop}`),
    `injected changes detected+explained ${passed}/${verdicts.length} [100%] · detected ${verdicts.filter((v) => v.detected).length} · explained ${verdicts.filter((v) => v.explained).length}`,
    ...run.pairs.map((p) => `  ${p.pair.padEnd(28)} ${p.op.outcome} answered-by=${p.answeredBy} changes=${p.changes.length} ${p.op.outcome === "ok" ? formatMs(p.op.durationMs) : p.op.skippedReason ?? p.op.error ?? ""}`),
    `reports: ${outDir}/compare.{md,json}`,
  ].join("\n");
}

function selfCheckCompare(mode: DryRunMode, run: CompareRun, verdicts: ChangeVerdict[]): string[] {
  const failures: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  expect(run.meta.callsSent === 0 && run.meta.blocked.length === 0, `no provider request in a dry run (sent ${run.meta.callsSent})`);
  expect(verdicts.length === 8, `8 injected changes (got ${verdicts.length})`);
  expect(verdicts.every((v) => v.detected), `every change detected (${verdicts.filter((v) => v.detected).length}/8)`);
  const explained = verdicts.filter((v) => v.explained).length;
  expect(mode === "clean" ? explained === 8 : explained === 0, `${mode}: explained ${explained}/8, expected ${mode === "clean" ? 8 : 0}`);
  return failures;
}
