import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES as SERVER_CODES, ERROR_REASONS as SERVER_REASONS } from "@/server/core/errors";
import { DOCUMENT_CATEGORIES as SERVER_CATEGORIES, INPUT_MODES as SERVER_INPUT_MODES } from "@/server/core/types";
import { APP_ERROR_CODES, ERROR_REASONS, DOCUMENT_CATEGORIES, INPUT_MODES } from "@/shared/contracts/vocabulary";

describe("shared contract vocabulary", () => {
  it("matches each server enum exactly, including order", () => {
    expect(APP_ERROR_CODES).toEqual(SERVER_CODES);
    expect(ERROR_REASONS).toEqual(SERVER_REASONS);
    expect(DOCUMENT_CATEGORIES).toEqual(SERVER_CATEGORIES);
    expect(INPUT_MODES).toEqual(SERVER_INPUT_MODES);
  });
});
