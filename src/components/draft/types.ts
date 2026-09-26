/**
 * library.ts exports only the schema consts for these three (no sibling `z.infer` type alias the
 * way drafts.ts/documents.ts do) — derived once here via z.infer rather than repeating it, or adding
 * a type export to library.ts that nothing there otherwise needs.
 */

import type { z } from "zod";
import { DocumentListRowOutput, DraftRevisionsOutput } from "@/shared/contracts/library";

export type DocumentListRow = z.infer<typeof DocumentListRowOutput>;
export type DraftRevisionsResult = z.infer<typeof DraftRevisionsOutput>;
export type DraftRevisionEntry = DraftRevisionsResult["items"][number];
