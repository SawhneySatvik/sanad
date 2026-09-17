import { describe, expect, it } from "vitest";
import {
  DOCUMENT_CATEGORIES,
  INPUT_MODES,
  VERIFICATION_STATUSES,
} from "@/server/core/types";

// These const arrays are what the migrator (M1) mirrors as Postgres enums —
// a drift here silently desyncs app-level vocabulary from the DB CHECK
// constraints, so pin the exact literal set and order.
describe("exported const arrays match the documented union values", () => {
  it("INPUT_MODES", () => {
    expect(INPUT_MODES).toEqual(["text", "native_document"]);
  });

  it("VERIFICATION_STATUSES", () => {
    expect(VERIFICATION_STATUSES).toEqual(["verified", "approximate", "not_found"]);
  });

  it("DOCUMENT_CATEGORIES", () => {
    expect(DOCUMENT_CATEGORIES).toEqual([
      "obligation",
      "deadline",
      "penalty",
      "ambiguity",
      "missing_clause",
    ]);
  });
});
