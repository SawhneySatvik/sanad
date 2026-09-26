// prepare.ts's own contract keeps every nested shape anonymous (only the outer PrepareOutput union
// and PrepareQuery are exported) — derived once here via Extract<> so every component in this
// directory shares one alias instead of repeating the same utility-type boilerplate.

import type { PrepareOutput } from "@/shared/contracts/prepare";

export type PrepareCompleteOutput = Extract<PrepareOutput, { state: "complete" }>;
export type PrepareQuestionOutput = PrepareCompleteOutput["lawyerQuestions"][number];
export type PrepareChecklistItemOutput = PrepareCompleteOutput["checklist"][number];
export type PrepareFindingRefOutput = PrepareQuestionOutput["findings"][number];
