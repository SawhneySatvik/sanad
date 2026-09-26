/**
 * Reserved category glyphs — chosen to avoid both the law-firm-cliché default
 * (no gavel/scales) and anything that itself implies severity. Icons vary only by category identity,
 * never by anything else — no ranking, no colour-coded urgency.
 */

import { ClipboardList, CalendarClock, IndianRupee, CircleQuestionMark, FileMinus, type LucideIcon } from "lucide-react";
import type { DocumentCategory } from "./group-findings";

export const CATEGORY_ICONS: Record<DocumentCategory, LucideIcon> = {
  obligation: ClipboardList,
  deadline: CalendarClock,
  penalty: IndianRupee,
  ambiguity: CircleQuestionMark,
  missing_clause: FileMinus,
};
