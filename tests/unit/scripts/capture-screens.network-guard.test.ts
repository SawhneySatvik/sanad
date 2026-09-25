import { describe, expect, it } from "vitest";
import { isLocalUrl } from "../../e2e/support/capture/network-guard";

describe("isLocalUrl", () => {
  it("accepts 127.0.0.1 and localhost, any port or path", () => {
    expect(isLocalUrl("http://127.0.0.1:3100/settings")).toBe(true);
    expect(isLocalUrl("http://localhost:4100/__control__/health")).toBe(true);
  });

  it("rejects any other host", () => {
    expect(isLocalUrl("https://example.com/")).toBe(false);
    expect(isLocalUrl("https://api.google.com/")).toBe(false);
    // A loopback IP that isn't the exact literal this harness (and the e2e fixtures) allow-lists.
    expect(isLocalUrl("http://0.0.0.0:3100/")).toBe(false);
  });

  it("rejects a malformed URL rather than throwing", () => {
    expect(isLocalUrl("not a url")).toBe(false);
  });
});
