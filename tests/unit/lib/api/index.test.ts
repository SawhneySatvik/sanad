import { describe, expect, it } from "vitest";
import * as api from "@/lib/api";

describe("src/lib/api barrel", () => {
  it("re-exports the whole public surface — nothing imports this file otherwise, so it needs its own coverage", () => {
    expect(typeof api.apiFetch).toBe("function");
    expect(typeof api.apiFetchJson).toBe("function");
    expect(typeof api.ApiError).toBe("function");
    expect(typeof api.parseRetryAfterHeader).toBe("function");
    expect(typeof api.reportNetworkFailure).toBe("function");
    expect(typeof api.useIsOffline).toBe("function");
  });
});
