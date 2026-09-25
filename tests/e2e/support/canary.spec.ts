// Proves the suite really is driving the fake provider, not silently passing against nothing: a
// real Ask turn, through the real orchestrator, through providers.ts's e2e redirect, answered by a
// script this test itself registers. Red-proved by running this same file with the fake told to go
// down first (SABOOT_E2E_CANARY_DOWN=1), which fails instead of passing vacuously.

import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { registerScript, setFakeProviderDown } from "./fake-provider/client";

const FORCE_DOWN = process.env.SABOOT_E2E_CANARY_DOWN === "1";
const SENTINEL_ANSWER = "canary sentinel: the fake provider answered this turn.";

// FORCE_DOWN is a whole-server toggle, so the red-proof run must be scoped to a single project
// (e.g. --project=desktop-light) — run alongside the other three projects' own parallel traffic,
// "down" would fail turns this spec never touched. The normal (FORCE_DOWN unset) run is unaffected:
// every test here uses its own randomUUID() nonce, so concurrently-running instances of this same
// spec (once per project) never share or clear each other's scripts — no reset is ever called.
test.describe("canary", () => {
  test.afterEach(async () => {
    // Never leave the fake down for whichever spec runs next against the same server process.
    if (FORCE_DOWN) await setFakeProviderDown(false);
  });

  test("a general Ask turn answers with the fake's scripted text, proving the fake was really called", async ({ request }) => {
    const nonce = `canary-${randomUUID()}`;
    await registerScript({ id: nonce, match: nonce, chunks: [`{"answer":"${SENTINEL_ANSWER}","citations":[]}`] });
    if (FORCE_DOWN) await setFakeProviderDown(true);

    const response = await request.post("/api/ask", {
      data: { query: `${nonce} What does a standard lease say about the security deposit?` },
    });
    const body = await response.text();

    // With the fake up, the orchestrator streams the scripted sentinel back; every fallback tier
    // ultimately points at the same fake host, so "down" exhausts the whole chain into a 503 instead.
    expect(response.status(), body).toBe(200);
    expect(body).toContain(SENTINEL_ANSWER);
  });
});
