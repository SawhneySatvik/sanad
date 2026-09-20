// Two contexts, two distinct x-forwarded-for values: RATE_LIMIT_IP_PER_MINUTE is set low by
// scripts/e2e-server.ts specifically so this spec can exhaust one bucket in a handful of requests
// without waiting a real minute, and without starving any other spec (which uses its own distinct
// random IP via tests/e2e/support/fixtures.ts).

import { test, expect, newIsolatedContext } from "./fixtures";

test("one context's usage never counts against a different context's per-IP bucket", async ({ browser }) => {
  const exhausted = await newIsolatedContext(browser);
  const fresh = await newIsolatedContext(browser);

  try {
    // RATE_LIMIT_IP_PER_MINUTE=8 (scripts/e2e-server.ts): the 9th request from the same IP in the
    // same minute is the first to see 429 — GET /api/projects works for both guest and signed-in,
    // needs no body, and never touches the LLM.
    let lastStatus = 0;
    for (let i = 0; i < 9; i++) {
      const response = await exhausted.context.request.get("/api/projects");
      lastStatus = response.status();
    }
    expect(lastStatus, "the 9th request from the same IP within a minute must be rate-limited").toBe(429);

    const freshResponse = await fresh.context.request.get("/api/projects");
    expect(freshResponse.status(), "a different IP's own bucket must be unaffected").toBe(200);
  } finally {
    await exhausted.close();
    await fresh.close();
  }
});

// Positive control: the fixtures.ts's own per-test random IP already keeps this file isolated from
// every other spec file's bucket — proven here by making a handful of ordinary requests and
// confirming none of them was ever rate-limited, which would only happen if some other spec's usage
// bled in.
test("this spec's own default (per-test) IP starts each run with a clean bucket", async ({ request }) => {
  for (let i = 0; i < 3; i++) {
    const response = await request.get("/api/projects");
    expect(response.status()).toBe(200);
  }
});
