import { describe, expect, it } from "vitest";
import { canCompare } from "@/components/compare/picker/can-compare";

describe("canCompare — a pure function of (slotA, slotB)", () => {
  it("false when either slot is empty", () => {
    expect(canCompare(null, null)).toBe(false);
    expect(canCompare("a", null)).toBe(false);
    expect(canCompare(null, "b")).toBe(false);
  });

  it("false when both slots hold the same document", () => {
    expect(canCompare("a", "a")).toBe(false);
  });

  it("true when both slots hold two different documents", () => {
    expect(canCompare("a", "b")).toBe(true);
  });
});
