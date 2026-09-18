// Runs the shared LlmClient contract suite against `withGlobalLimit(FakeLlmClient)`, proving it
// satisfies the exact interface contract every real adapter does. The limit is set far above what
// this suite could hit, so none of these tests are about rate limiting itself (that's limiter.test.ts's job).

import { beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "@tests/support/db";
import { type ContractHarness, HARNESS_SECRET_API_KEY, runLlmContract } from "@tests/support/contracts/llm-client";
import { normalizeProviderError } from "@/server/llm/errors";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { withGlobalLimit } from "@/server/rate-limit/with-global-limit";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

function makeHarness(): ContractHarness {
  const client = new FakeLlmClient({ modelUsed: "fake-model" });
  const limited = withGlobalLimit(client, { db: t.db, providerKey: "gemini", limit: 10_000 });
  return {
    client: limited,
    secretApiKey: HARNESS_SECRET_API_KEY, // never touched by this decorator either — passes through to the fake
    queueText: (rawText) => client.enqueue({ rawText, tokensUsed: { input: 1, output: 1 } }),
    // Routed through the SAME `normalizeProviderError` every real adapter uses, not a hand-built
    // AppError, so the WeakSet-based non-retryable marking (a 410 dead-model error) is real, not
    // scripted by hand.
    queueError: (status, retryAfterSeconds) => {
      const headers = retryAfterSeconds !== undefined ? new Headers({ "retry-after": String(retryAfterSeconds) }) : undefined;
      client.enqueue({ error: normalizeProviderError({ status, headers }) });
    },
    queueHang: () => client.enqueue({ hang: true }),
  };
}

runLlmContract("withGlobalLimit(FakeLlmClient)", makeHarness);
