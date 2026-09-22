import { describe, expect, it } from "vitest";
import * as sse from "@/lib/sse";

describe("src/lib/sse barrel", () => {
  it("re-exports the whole public surface — nothing imports this file otherwise, so it needs its own coverage", () => {
    expect(typeof sse.parseSseStream).toBe("function");
    expect(typeof sse.postSse).toBe("function");
  });
});
