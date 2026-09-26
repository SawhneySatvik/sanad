import { describe, expect, it } from "vitest";
import { executeRows } from "@/server/data/execute-rows";

describe("executeRows", () => {
  it("reads PGlite's { rows } result", () => {
    expect(executeRows<{ id: string }>({ rows: [{ id: "a" }] })).toEqual([{ id: "a" }]);
  });

  it("reads postgres.js's row array, which has no .rows property", () => {
    const rowList = Object.assign([{ id: "a" }, { id: "b" }], { count: 2, command: "SELECT" });
    expect(executeRows<{ id: string }>(rowList)).toBe(rowList);
  });
});
