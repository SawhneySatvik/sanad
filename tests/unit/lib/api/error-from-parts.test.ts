// errorFromParts is apiFetch's own error-building logic, pulled out from behind a Response so
// putRelay's XMLHttpRequest path (status/headers/responseText, never a Response) can share it
// instead of keeping a second, hand-copied parser. Kept in its own file so a broken export here
// fails loudly on its own, rather than silently taking client.test.ts's unrelated coverage with it.

import { describe, expect, it } from "vitest";
import { errorFromParts, ApiError } from "@/lib/api";

const DOC_ID = "0a0a0a0a-0000-4000-8000-00000000000a";

function headers(map: Record<string, string> = {}): { get(name: string): string | null } {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("errorFromParts", () => {
  it("parses code/message/reason/retryAfterSeconds/documentId from a JSON body, and the correlation id from headers — the same shape apiFetch's own parsing produces", () => {
    const err = errorFromParts(
      422,
      headers({ "x-correlation-id": "corr-1", "retry-after": "999" }),
      JSON.stringify({ error: { code: "INVALID_DOCUMENT", message: "busy", retryAfterSeconds: 5, documentId: DOC_ID } }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("INVALID_DOCUMENT");
    expect(err.correlationId).toBe("corr-1");
    expect(err.retryAfterSeconds).toBe(5); // the body's own value wins over the header, same precedence apiFetch uses
    expect(err.documentId).toBe(DOC_ID);
    expect(err.message).toBe("busy"); // INVALID_DOCUMENT is a passthrough code — the server's own message renders unchanged
  });

  it("falls back to the retry-after header when the body carries no retryAfterSeconds of its own", () => {
    const err = errorFromParts(503, headers({ "retry-after": "120" }), JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "busy" } }));
    expect(err.retryAfterSeconds).toBe(120);
  });

  it("falls back to a status-derived code and no documentId when the body isn't parseable JSON at all (a direct-put signed-URL target's own non-JSON error page)", () => {
    const err = errorFromParts(502, headers(), "<html>Bad Gateway</html>");
    expect(err.code).toBe("SCHEMA_FAILED");
    expect(err.documentId).toBeUndefined();
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("falls back to a status-derived code and drops documentId when the body is JSON but fails ErrorBody's own schema (e.g. documentId isn't a real guid)", () => {
    const err = errorFromParts(422, headers(), JSON.stringify({ error: { code: "INVALID_DOCUMENT", message: "x", documentId: "not-a-guid" } }));
    expect(err.code).toBe("INVALID_DOCUMENT"); // coincidentally the same code, but via FALLBACK_CODE_BY_STATUS, not the rejected body
    expect(err.documentId).toBeUndefined();
  });

  it("falls all the way back to INTERNAL_ERROR when neither the body nor the status maps to a known code", () => {
    const err = errorFromParts(418, headers(), "I'm a teapot");
    expect(err.code).toBe("INTERNAL_ERROR");
  });

  it("handles an empty body string (a direct-put target that returns no body at all)", () => {
    const err = errorFromParts(500, headers(), "");
    expect(err.code).toBe("INTERNAL_ERROR");
  });
});
