// Pure CLI parsing for scripts/capture-screens.ts — no env reads, no filesystem, so a malformed
// invocation fails before anything is spawned.

export interface CaptureArgs {
  screen: string;
  states: string[];
  outDir?: string;
}

const USAGE = "Usage: capture:screens -- --screen <name> --states <a,b,c> [--out <dir>]";

export function parseArgs(argv: string[]): CaptureArgs {
  let screen: string | undefined;
  let states: string | undefined;
  let outDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--screen") screen = argv[++i];
    else if (arg === "--states") states = argv[++i];
    else if (arg === "--out") outDir = argv[++i];
    else throw new Error(`capture-screens: unrecognised argument "${arg}". ${USAGE}`);
  }

  if (screen === undefined || screen === "") throw new Error(`capture-screens: --screen is required. ${USAGE}`);
  if (states === undefined) throw new Error(`capture-screens: --states is required. ${USAGE}`);

  const stateList = states
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (stateList.length === 0) throw new Error(`capture-screens: --states must list at least one state. ${USAGE}`);

  return { screen, states: stateList, outDir };
}
