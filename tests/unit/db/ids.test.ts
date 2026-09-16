import { describe, expect, it } from "vitest";
import { newId } from "@/db/ids";

describe("newId", () => {
  it("returns UUIDv7s that sort in generation order, including many within one millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});
