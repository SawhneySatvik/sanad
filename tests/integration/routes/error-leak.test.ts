// No error leaks through the route layer: whatever an error's message, stack or cause carries, the
// response carries only a code and a fixed message, and the log line only a correlation id, the
// code and an error class name. Exercised against real routes and real failure paths.

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as documentsRoute from "@/app/api/documents/route";
import * as uploadsRoute from "@/app/api/uploads/route";
import { AppError } from "@/server/core/errors";
import { CORRELATION_ID_HEADER, INTERNAL_ERROR_MESSAGE } from "@/server/http/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  request,
  TEST_MODEL_ID,
  uploadViaRoutes,
  type RouteHarness,
} from "./harness";

const SECRET = "postgres://admin:hunter2@db.internal:5432/prod?sslkey=sk-live-0123456789SECRET";

let h: RouteHarness;
let spies: MockInstance[] = [];

function captureLogs(): () => string {
  spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
}

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  await h.close();
});

function throwingProvider(error: Error): FakeLlmClient {
  return new FakeLlmClient({
    modelUsed: TEST_MODEL_ID,
    defaultResponse: () => {
      throw error;
    },
  });
}

async function postDocument(cookie: string) {
  const input = await uploadViaRoutes(cookie);
  return callRoute(documentsRoute.POST, request("POST", "/api/documents", { cookie, json: input }));
}

describe("error responses and logs never carry an error's content", () => {
  it("a raw Error with a secret message from deep in the stack is a generic 500; the log has the correlation id and no message or stack", async () => {
    const raw = new Error(SECRET);
    h = await createRouteHarness({ primary: throwingProvider(raw) });
    const { cookie } = guestCookie();
    const logs = captureLogs();

    const res = await postDocument(cookie);

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE } });
    expect(text).not.toContain("hunter2");
    expect(text).not.toMatch(/\bat\s+\S+\s+\(/);

    const logged = logs();
    const correlationId = res.headers.get(CORRELATION_ID_HEADER);
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const line = logged.split("\n").find((l) => l.includes(correlationId ?? "missing"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ event: "request_failed", status: 500, code: "INTERNAL_ERROR" });
    expect(logged).not.toContain("hunter2");
    expect(logged).not.toContain("sk-live");
    expect(logged).not.toContain(raw.stack?.split("\n")[1]?.trim() ?? "no stack");
  });

  it("a typed provider error with a secret message is its status and the fixed message", async () => {
    // Both providers fail with it, so the error that reaches the route (wrapped as the service's
    // DocumentAnalysisError, message and cause intact) really carries the secret.
    const secretError = () => new FakeLlmClient({ defaultResponse: { error: new AppError("UPSTREAM_UNAVAILABLE", SECRET) } });
    h = await createRouteHarness({ primary: secretError(), secondary: secretError() });
    const logs = captureLogs();

    const res = await postDocument(guestCookie().cookie);

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error).toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: "A required service is temporarily unavailable. Please try again later.",
    });
    expect(text).not.toContain("hunter2");
    expect(logs()).not.toContain("hunter2");
  });

  it("the storage policy's message echoing a client-sent mime type never reaches the response or the log", async () => {
    h = await createRouteHarness();
    const logs = captureLogs();

    const res = await callRoute(
      uploadsRoute.POST,
      request("POST", "/api/uploads", {
        cookie: guestCookie().cookie,
        json: { filename: "x.bin", mimeType: SECRET, sizeBytes: 10 },
      }),
    );

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text).error).toEqual({
      code: "INVALID_DOCUMENT",
      message: "The uploaded document could not be processed.",
      reason: "unsupported_type",
    });
    expect(logs()).not.toContain("hunter2");
  });

  it("a request body echoing a secret into a validation failure never reaches the response or the log", async () => {
    h = await createRouteHarness();
    const logs = captureLogs();

    const res = await callRoute(
      documentsRoute.POST,
      request("POST", "/api/documents", { cookie: guestCookie().cookie, json: { storageRef: 42, filename: SECRET } }),
    );

    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("hunter2");
    expect(logs()).not.toContain("hunter2");
  });
});
