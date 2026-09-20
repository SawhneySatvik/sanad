// A thin control-plane client over the fake provider's HTTP API (see ./server.ts), for Playwright
// specs to script responses, release holds and inspect the request log without importing the
// server module itself — specs and the server run in different processes.

import type { FakeScript, LoggedRequest } from "./server";

/** The fake provider's base URL, fixed by scripts/e2e-server.ts and playwright.config.ts alike. */
export function fakeProviderUrl(): string {
  const port = process.env.SABOOT_E2E_PROVIDER_PORT ?? "4100";
  return `http://127.0.0.1:${port}`;
}

// Throws on any non-2xx — a spec that registers a malformed script, or races a release against an
// already-auto-released hold, must see a clear failure here, never silently continue against state
// that never actually changed.
async function post(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${fakeProviderUrl()}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`fake-provider: POST ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Clears every script, the request log, and any pending hold; brings the fake back up. */
export async function resetFakeProvider(): Promise<void> {
  await post("/__control__/reset");
}

/** Registers (or replaces, by id) one scripted answer. */
export async function registerScript(script: FakeScript): Promise<void> {
  await post("/__control__/scripts", script);
}

/** Releases a mid-stream hold, once the request that triggered it is known (see waitForHeldRequest). */
export async function releaseHold(requestId: string): Promise<void> {
  const result = (await post(`/__control__/release/${requestId}`)) as { released?: boolean; reason?: string };
  if (result.released !== true) {
    throw new Error(`fake-provider: release of "${requestId}" did not succeed: ${result.reason ?? "unknown reason"}`);
  }
}

/** Simulates a total provider outage: every provider-shaped request gets its socket destroyed. */
export async function setFakeProviderDown(down: boolean): Promise<void> {
  await post(down ? "/__control__/down" : "/__control__/up");
}

/** The fake's full request log so far, in receipt order. */
export async function fakeProviderRequests(): Promise<LoggedRequest[]> {
  const response = await fetch(`${fakeProviderUrl()}/__control__/requests`);
  const body = (await response.json()) as { requests: LoggedRequest[] };
  return body.requests;
}

/**
 * Polls the request log until a request matching `scriptId` is held mid-stream, and returns its
 * requestId — the handle releaseHold() needs. Throws if none appears within `timeoutMs`.
 */
export async function waitForHeldRequest(scriptId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const requests = await fakeProviderRequests();
    const held = requests.find((r) => r.matchedScriptId === scriptId && r.held);
    if (held) return held.requestId;
    if (Date.now() > deadline) {
      throw new Error(`fake-provider: no held request for script "${scriptId}" within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
