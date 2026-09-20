// Checklist script: prints the One Guarantee channel → positive/negative test matrix and
// exits 1 if any channel lacks either (rules: tests/architecture/one-guarantee-coverage.ts). The same check
// runs inside `npm test` (tests/architecture/one-guarantee-coverage.verify.test.ts); this is the
// human-readable form. `--registry <file>` checks another registry (used to red-prove it).
//
//   npx tsx scripts/check-one-guarantee-coverage.ts [--registry <file>]

import { checkCoverage, loadRealTree, RELEASE_BLOCKER_FILTER, REGISTRY_FILE } from "../tests/architecture/one-guarantee-coverage";

const flag = process.argv.indexOf("--registry");
const registryFile = flag === -1 ? REGISTRY_FILE : process.argv[flag + 1];
const input = loadRealTree(process.cwd(), registryFile);

for (const channel of input.registry.channels) {
  console.log(`\n${channel.number}. ${channel.name}`);
  for (const polarity of ["positive", "negative"] as const) {
    for (const entry of channel[polarity] ?? []) {
      const suite = entry.file.includes(RELEASE_BLOCKER_FILTER) ? "" : "  [outside the verify filter]";
      console.log(`   ${polarity === "positive" ? "+" : "-"} ${entry.file} › ${entry.test}${suite}`);
    }
  }
}

const errors = checkCoverage(input);
if (errors.length > 0) {
  console.error(`\nFAIL: ${errors.length} problem(s) with ${registryFile}:`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`\nPASS: all ${input.registry.channels.length} channels have a positive and a negative test in \`npm test -- ${RELEASE_BLOCKER_FILTER}\` (${registryFile}).`);
