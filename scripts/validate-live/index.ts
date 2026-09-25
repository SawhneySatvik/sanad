// `npm run validate:live -- <command> [flags]` — the one place real Gemini/NVIDIA/OpenRouter calls
// are allowed. Never part of `npm test` or `check-all`; run it sparingly and one command at a time —
// the free-tier quota is shared across the whole validate:live command set below.
//
//   understand [--budget=N] [--out=DIR]        Gemma smoke, Understand ×6, Prepare ×6 (live)
//   understand --dry-run[=clean|mutated]       same pipeline over FakeLlmClient, zero provider calls,
//                                              exact self-check; writes to a temp dir unless --out
//   understand --render-only [--out=DIR]       rebuild the reports from saved JSON, zero calls
//   understand --diagnose-gemini [--out=DIR]   one direct Gemini call reproducing a failed Understand
//                                              request, appended to the saved run, then re-rendered
//   understand --skip-smoke                    no live Gemma smoke; the fallback is reported UNVERIFIED
//   understand --prior-note="…" --prior-label="…"  note and heading label for the previous live run
//                                              as it is archived into this run's history
//   understand --render-only --note="…"        add a reviewer note to the saved run, then re-render
//   understand --fixtures=a,b --caps=tier:n,…  only those fixtures; per-tier request ceilings (tiers:
//                                              primary, flash-lite, gemma-google, nim, openrouter)
//   ask | compare | draft --flash-lite=N       one of three live parts sharing a Flash-Lite
//                                              allocation; N is this part's share of it (required for a live run)
//   ask | compare | draft --dry-run[=…]        the same over FakeLlmClient, zero calls, self-check
//   ask | compare | draft --render-only        rebuild that part's report from its saved JSON
//   all                                        refuses: each part is run on its own, with its budget

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLiveValidationSet } from "../../tests/fixtures/live-validation/load";
import { DEFAULT_CALL_BUDGET, LIVE_OUTPUT_DIR, loadEnvNames } from "./harness";
import { renderAsk, runAsk } from "./ask";
import { renderCompare, runCompare } from "./compare";
import { renderDraft, runDraft } from "./draft";
import { runUnderstand, type DryRunMode } from "./understand";
import { tierModels, type PartOptions } from "./part";

const PARTS: Record<string, (opts: PartOptions) => Promise<number>> = { ask: runAsk, compare: runCompare, draft: runDraft };
const PART_RENDERERS: Record<string, (outDir: string) => Promise<number>> = { ask: renderAsk, compare: renderCompare, draft: renderDraft };

// "primary:0,flash-lite:4,gemma-google:4,nim:0,openrouter:0" → ceilings keyed by the meter's
// `${provider}:${model}`, with each tier's model id resolved as the chain resolves it.
function parseCaps(spec: string): Record<string, number> {
  loadEnvNames();
  const models = tierModels();
  const keys: Record<string, string> = {
    primary: `gemini:${models.primary}`,
    "flash-lite": `gemini:${models.flashLite}`,
    "gemma-google": `gemini:${models.gemmaGoogle}`,
    nim: `nim:${models.nim}`,
    openrouter: `openrouter:${models.openrouter}`,
  };
  return Object.fromEntries(
    spec.split(",").map((part) => {
      const [tier, n] = part.split(":");
      if (!(tier in keys) || !/^\d+$/.test(n ?? "")) throw new Error(`--caps: "${part}" is not <tier>:<n> with tier one of ${Object.keys(keys).join(", ")}`);
      return [keys[tier], Number(n)];
    }),
  );
}

function knownFixtures(ids: string[]): string[] {
  const known = loadLiveValidationSet().fixtures.map((fixture) => fixture.id);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) throw new Error(`--fixtures: unknown ${unknown.join(", ")}; known: ${known.join(", ")}`);
  return ids;
}

function flag(args: string[], name: string): string | true | undefined {
  const hit = args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "all") {
    // The free-tier quotas are small and shared, so no command runs everything: each part is run on
    // its own with an explicit budget, and understand is never re-run by accident.
    console.error("validate:live all: refusing — run understand, then ask, compare and draft one at a time, each with its own --flash-lite=N. Nothing was run.");
    return 1;
  }
  if (command !== undefined && command in PARTS) {
    if (flag(args, "render-only") === true) {
      const outFlag = flag(args, "out");
      return PART_RENDERERS[command](typeof outFlag === "string" ? path.resolve(outFlag) : LIVE_OUTPUT_DIR);
    }
    const dryRunFlag = flag(args, "dry-run");
    const dryRun: DryRunMode | null = dryRunFlag === undefined ? null : dryRunFlag === true ? "clean" : (dryRunFlag as DryRunMode);
    if (dryRun !== null && dryRun !== "clean" && dryRun !== "mutated") {
      console.error("--dry-run takes clean or mutated");
      return 1;
    }
    const flashLiteFlag = flag(args, "flash-lite");
    const flashLite = typeof flashLiteFlag === "string" ? Number(flashLiteFlag) : dryRun !== null ? 0 : NaN;
    if (!Number.isInteger(flashLite) || flashLite < 0) {
      console.error(`validate:live ${command}: a live run needs --flash-lite=N, this part's share of the shared Flash-Lite allocation.`);
      return 1;
    }
    const outFlag = flag(args, "out");
    const outDir =
      typeof outFlag === "string" ? path.resolve(outFlag) : dryRun !== null ? mkdtempSync(path.join(tmpdir(), `validate-live-${command}-dry-run-`)) : LIVE_OUTPUT_DIR;
    if (dryRun !== null && outDir.startsWith(LIVE_OUTPUT_DIR)) {
      console.error("a dry run may not write into docs/live-validation");
      return 1;
    }
    return PARTS[command]({ outDir, flashLite, dryRun });
  }
  if (command !== "understand") {
    console.error("usage: npm run validate:live -- understand|ask|compare|draft|all [--flash-lite=N] [--dry-run[=clean|mutated]] [--render-only] [--diagnose-gemini] [--skip-smoke] [--prior-note=TEXT] [--prior-label=TEXT] [--note=TEXT] [--fixtures=a,b] [--caps=tier:n,...] [--budget=N] [--out=DIR]");
    return 1;
  }

  const dryRunFlag = flag(args, "dry-run");
  const dryRun: DryRunMode | null = dryRunFlag === undefined ? null : dryRunFlag === true ? "clean" : (dryRunFlag as DryRunMode);
  if (dryRun !== null && dryRun !== "clean" && dryRun !== "mutated") {
    console.error("--dry-run takes clean or mutated");
    return 1;
  }
  const budgetFlag = flag(args, "budget");
  const budget = typeof budgetFlag === "string" ? Number(budgetFlag) : DEFAULT_CALL_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) {
    console.error("--budget takes a positive integer");
    return 1;
  }
  const outFlag = flag(args, "out");
  // A dry run never writes into docs/: its numbers are the fake's, not a model's.
  const outDir =
    typeof outFlag === "string"
      ? path.resolve(outFlag)
      : dryRun !== null
        ? mkdtempSync(path.join(tmpdir(), `validate-live-dry-run-${dryRun}-`))
        : LIVE_OUTPUT_DIR;
  if (dryRun !== null && outDir.startsWith(LIVE_OUTPUT_DIR)) {
    console.error("a dry run may not write into docs/live-validation");
    return 1;
  }

  const renderOnly = flag(args, "render-only") === true;
  const diagnoseGemini = flag(args, "diagnose-gemini") === true;
  if (diagnoseGemini && (dryRun !== null || renderOnly)) {
    console.error("--diagnose-gemini makes one live call against a saved run; it does not combine with --dry-run or --render-only");
    return 1;
  }
  const skipSmoke = flag(args, "skip-smoke") === true;
  const priorNote = flag(args, "prior-note");
  const priorLabel = flag(args, "prior-label");
  const note = flag(args, "note");
  const fixturesFlag = flag(args, "fixtures");
  const capsFlag = flag(args, "caps");
  return runUnderstand({
    outDir,
    budget,
    dryRun,
    renderOnly,
    diagnoseGemini,
    skipSmoke,
    priorNote: typeof priorNote === "string" ? priorNote : null,
    priorLabel: typeof priorLabel === "string" ? priorLabel : null,
    note: typeof note === "string" ? note : null,
    fixtures: typeof fixturesFlag === "string" ? knownFixtures(fixturesFlag.split(",")) : null,
    caps: typeof capsFlag === "string" ? parseCaps(capsFlag) : null,
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Name and message only, never the object: an error's cause chain is not vetted for output.
    console.error(`validate:live failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "non-Error thrown"}`);
    process.exitCode = 1;
  },
);
